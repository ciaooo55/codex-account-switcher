import { mkdir, mkdtemp, readFile, readdir, rm, stat, truncate, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AppSettings,
  NormalizedCredential,
  SecretCipher,
  TestResult
} from '../../shared/types'
import { CredentialVault } from '../storage/vault'
import { StatusStore } from '../storage/status-store'
import { DeletedCredentialStore } from '../storage/deleted-credentials'
import { AccountManager } from './account-manager'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

const cipher: SecretCipher = {
  encrypt: (plainText) => Buffer.from(plainText).toString('base64'),
  decrypt: (encryptedText) => Buffer.from(encryptedText, 'base64').toString('utf8')
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'codex-switcher-manager-'))
  tempDirs.push(root)
  const accountDirectory = join(root, 'accounts')
  await mkdir(accountDirectory)
  const settings: AppSettings = {
    accountDirectory,
    authPath: join(root, 'codex', 'auth.json'),
    configPath: join(root, 'codex', 'config.toml'),
    concurrency: 2,
    timeoutMs: 1_000,
    backupRetention: 20,
    deepTestModel: 'gpt-5.4',
    autoSwitchEnabled: false,
    autoSwitchIntervalSeconds: 300,
    autoSwitchAccountIds: [],
    autoSwitchRestartCodex: true,
    grokDirectory: join(root, 'grok'),
    customApiBaseUrl: 'https://api.openai.com/v1',
    customApiModel: 'gpt-5.4'
  }
  const vault = new CredentialVault(join(root, 'app', 'vault.json'), cipher)
  const statusStore = new StatusStore(join(root, 'app', 'status.json'))
  return { root, accountDirectory, settings, vault, statusStore }
}

function successfulResult(accountId: string): TestResult {
  return {
    accountId,
    status: 'valid',
    detail: '正常可用',
    checkedAt: '2026-07-15T00:00:00Z',
    httpStatus: 200,
    stage: 'deep-test',
    refreshed: false,
    usage: {
      planType: 'plus',
      checkedAt: '2026-07-15T00:00:00Z',
      windows: []
    }
  }
}

describe('AccountManager', () => {
  it('adds new CPA credentials without overwriting an existing aa account', async () => {
    const fixture = await setup()
    const managedDirectory = join(fixture.root, 'aa', 'codex')
    const manager = new AccountManager({
      settings: () => fixture.settings,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      managedImportDirectory: managedDirectory,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })
    const first: NormalizedCredential = {
      id: 'first', email: 'existing@example.com', accountId: 'workspace-existing', subject: 'existing-user',
      accessToken: 'original-access', refreshToken: 'original-refresh', idToken: null, authKind: 'oauth',
      oauthClientId: null, isFedRamp: null, planType: 'plus', lastRefresh: null,
      accessExpiresAt: null, idExpiresAt: null, canRefresh: true,
      sourcePath: 'cpa-existing.json', sourceFormat: 'json', sourceDialect: 'cpa'
    }
    await manager.importCredentialsAdditive([first])
    const storedFirst = (await fixture.vault.list())[0]
    const second: NormalizedCredential = {
      ...first, id: 'second', email: 'new@example.com', accountId: 'workspace-new', subject: 'new-user',
      accessToken: 'new-access', refreshToken: 'new-refresh', sourcePath: 'cpa-new.json'
    }

    const result = await manager.importCredentialsAdditive([
      { ...storedFirst, accessToken: 'must-not-overwrite' },
      second
    ])

    expect(result).toMatchObject({ imported: 1, skipped: 1 })
    const stored = await fixture.vault.list()
    expect(stored).toHaveLength(2)
    expect(stored.find((item) => item.email === 'existing@example.com')?.accessToken).toBe('original-access')
    expect(await readdir(managedDirectory)).toHaveLength(2)
  })

  it('scans disabled .json.0 files and deduplicates them with enabled copies by email', async () => {
    const fixture = await setup()
    const accessToken = jwt({ sub: 'same-email', email: 'same@example.com' })
    const raw = JSON.stringify({ type: 'codex', email: 'same@example.com', access_token: accessToken })
    await writeFile(join(fixture.accountDirectory, 'same.json'), raw)
    await writeFile(join(fixture.accountDirectory, 'same.json.0'), raw)
    const manager = new AccountManager({
      settings: () => fixture.settings,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })

    const result = await manager.scanDirectory()

    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0].email).toBe('same@example.com')
  })

  it('scans supported files, reports malformed files and never modifies source content', async () => {
    const fixture = await setup()
    const sourcePath = join(fixture.accountDirectory, 'person.json')
    const source = JSON.stringify({
      access_token: jwt({
        sub: 'user-a',
        exp: 1_900_000_000,
        'https://api.openai.com/profile': { email: 'person@example.com' }
      }),
      account_id: 'workspace-a'
    })
    await writeFile(sourcePath, source)
    await writeFile(join(fixture.accountDirectory, 'bad.txt'), 'this is not a credential')
    await mkdir(join(fixture.accountDirectory, 'logs'))
    await writeFile(join(fixture.accountDirectory, 'logs', 'ignored.json'), source)

    const manager = new AccountManager({
      settings: () => fixture.settings,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })
    const result = await manager.scanDirectory()

    expect(result.imported).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.accounts[0].email).toBe('person@example.com')
    expect(JSON.stringify(result.accounts)).not.toContain('header.')
    expect(await readFile(sourcePath, 'utf8')).toBe(source)
  })

  it('rejects oversized text credentials before reading them into memory', async () => {
    const fixture = await setup()
    const oversized = join(fixture.accountDirectory, 'oversized.json')
    await writeFile(oversized, '')
    await truncate(oversized, 100 * 1024 * 1024 + 1)
    const manager = new AccountManager({
      settings: () => fixture.settings,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })

    const result = await manager.scanDirectory()

    expect(result.imported).toBe(0)
    expect(result.errors).toEqual([expect.stringContaining('100MB')])
  })

  it('recursively scans supported account files in nested folders', async () => {
    const fixture = await setup()
    const nested = join(fixture.accountDirectory, 'region-a', 'batch-1')
    await mkdir(nested, { recursive: true })
    await writeFile(
      join(nested, 'nested.json'),
      JSON.stringify({
        type: 'codex',
        access_token: jwt({ sub: 'nested-user' }),
        email: 'nested@example.com'
      })
    )
    const manager = new AccountManager({
      settings: () => fixture.settings,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })

    const result = await manager.scanDirectory()

    expect(result.accounts.map((item) => item.email)).toEqual(['nested@example.com'])
  })

  it('imports a bounded CPA ZIP containing one standard JSON per account', async () => {
    const fixture = await setup()
    const zipPath = join(fixture.accountDirectory, 'cpa-accounts.zip')
    const archive = zipSync({
      'one.json': strToU8(
        JSON.stringify({
          type: 'codex',
          access_token: jwt({ sub: 'zip-user-1' }),
          email: 'zip-one@example.com'
        })
      ),
      'nested/two.json': strToU8(
        JSON.stringify({
          type: 'codex',
          access_token: jwt({ sub: 'zip-user-2' }),
          email: 'zip-two@example.com'
        })
      ),
      'ignored.exe': strToU8('not a credential')
    })
    await writeFile(zipPath, archive)
    const manager = new AccountManager({
      settings: () => fixture.settings,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })

    const result = await manager.scanDirectory()

    expect(result.accounts.map((item) => item.email)).toEqual([
      'zip-one@example.com',
      'zip-two@example.com'
    ])
    expect(result.accounts.every((item) => item.sourceFormat === 'zip')).toBe(true)
  })

  it('normalizes manual imports into one account file and skips duplicate re-imports', async () => {
    const fixture = await setup()
    const managedImportDirectory = join(fixture.root, 'app', 'imports')
    const externalPath = join(fixture.root, 'external-source.txt')
    const source = `email=managed@example.com\naccess_token=${jwt({ sub: 'managed-user' })}`
    await writeFile(externalPath, source)
    const manager = new AccountManager({
      settings: () => fixture.settings,
      managedImportDirectory,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })

    const result = await manager.importFiles([externalPath], { archiveSources: true })
    const archived = await readdir(managedImportDirectory)

    expect(archived).toEqual(['managed@example.com_unknown.json'])
    expect(JSON.parse(await readFile(join(managedImportDirectory, archived[0]), 'utf8'))).toMatchObject({
      type: 'codex',
      auth_mode: 'chatgpt',
      email: 'managed@example.com'
    })
    expect(await readFile(externalPath, 'utf8')).toBe(source)
    expect(result.accounts[0].sourcePath).toBe(join(managedImportDirectory, archived[0]))
    const duplicate = await manager.importFiles([externalPath], { archiveSources: true })
    expect(duplicate).toMatchObject({ imported: 0, skipped: 1 })
    expect(await readdir(managedImportDirectory)).toEqual(archived)
  })

  it('converts a Sub2API Team PAT bundle into one reusable CPA-compatible aa file', async () => {
    const fixture = await setup()
    const managedImportDirectory = join(fixture.root, 'app', 'aa')
    const sourcePath = join(fixture.root, 'sub2api-team.json')
    await writeFile(sourcePath, JSON.stringify({
      exported_at: '2026-07-16T13:32:05Z',
      proxies: [],
      accounts: [{
        name: 'Team account',
        type: 'oauth',
        platform: 'openai',
        credentials: {
          email: 'team@example.com',
          auth_mode: 'personalAccessToken',
          openai_auth_mode: 'personal_access_token',
          plan_type: 'team',
          access_token: 'at-personal-token',
          chatgpt_user_id: 'user-team',
          chatgpt_account_id: 'workspace-team'
        }
      }]
    }))
    const manager = new AccountManager({
      settings: () => fixture.settings,
      managedImportDirectory,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })

    const result = await manager.importFiles([sourcePath], { archiveSources: true })
    const files = await readdir(managedImportDirectory)
    const stored = JSON.parse(await readFile(join(managedImportDirectory, files[0]), 'utf8'))

    expect(result.accounts).toHaveLength(1)
    expect(files).toEqual(['team@example.com_team.json'])
    expect(stored).toEqual({
      type: 'codex',
      email: 'team@example.com',
      auth_mode: 'personalAccessToken',
      openai_auth_mode: 'personal_access_token',
      personal_access_token: 'at-personal-token',
      access_token: 'at-personal-token',
      account_id: 'workspace-team',
      chatgpt_account_id: 'workspace-team',
      subject: 'user-team',
      chatgpt_user_id: 'user-team',
      plan_type: 'team',
      chatgpt_plan_type: 'team'
    })
    expect(await readFile(sourcePath, 'utf8')).toContain('"accounts"')
  })

  it('recursively imports a folder with Markdown and multi-account files into app storage', async () => {
    const fixture = await setup()
    const sourceDirectory = join(fixture.root, 'folder-import')
    const nested = join(sourceDirectory, 'nested')
    const managedImportDirectory = join(fixture.root, 'app', 'imports')
    await mkdir(nested, { recursive: true })
    await writeFile(
      join(sourceDirectory, 'accounts.md'),
      `# Team\n\n\`\`\`json\n${JSON.stringify([
        { access_token: jwt({ sub: 'folder-one' }), email: 'folder-one@example.com' },
        { access_token: jwt({ sub: 'folder-two' }), email: 'folder-two@example.com' }
      ])}\n\`\`\``
    )
    await writeFile(
      join(nested, 'third.txt'),
      `email=folder-three@example.com\naccess_token=${jwt({ sub: 'folder-three' })}`
    )
    await writeFile(join(nested, 'ignored.csv'), 'not supported')
    const manager = new AccountManager({
      settings: () => fixture.settings,
      managedImportDirectory,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })

    const result = await manager.importDirectory(sourceDirectory)

    expect(result.imported).toBe(3)
    expect(result.accounts.map((account) => account.email)).toEqual([
      'folder-one@example.com',
      'folder-three@example.com',
      'folder-two@example.com'
    ])
    expect((await readdir(managedImportDirectory)).sort()).toEqual([
      'folder-one@example.com_unknown.json',
      'folder-three@example.com_unknown.json',
      'folder-two@example.com_unknown.json'
    ])
    expect(result.accounts.every((account) => account.sourcePath.startsWith(managedImportDirectory))).toBe(true)
  })

  it('does not replace a complete stored credential with an access-only duplicate', async () => {
    const fixture = await setup()
    const completePath = join(fixture.accountDirectory, 'complete.json')
    const incompletePath = join(fixture.root, 'incomplete.json')
    await writeFile(
      completePath,
      JSON.stringify({
        type: 'codex',
        access_token: jwt({ sub: 'merge-user' }),
        refresh_token: 'merge-refresh',
        email: 'merge@example.com'
      })
    )
    await writeFile(
      incompletePath,
      JSON.stringify({
        type: 'codex',
        access_token: jwt({ sub: 'merge-user' }),
        email: 'merge@example.com'
      })
    )
    const manager = new AccountManager({
      settings: () => fixture.settings,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })

    await manager.scanDirectory()
    const result = await manager.importFiles([incompletePath])

    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0].canRefresh).toBe(true)
    expect((await fixture.vault.list())[0].refreshToken).toBe('merge-refresh')
  })

  it('cleans pasted text and stores the same normalized account format as file imports', async () => {
    const fixture = await setup()
    const managedImportDirectory = join(fixture.root, 'app', 'imports')
    const manager = new AccountManager({
      settings: () => fixture.settings,
      managedImportDirectory,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })
    const pasted = `账号如下：\n\`\`\`json\n${JSON.stringify({
      type: 'codex',
      access_token: jwt({ sub: 'pasted-user' }),
      email: 'pasted@example.com'
    })}\n\`\`\``

    const result = await manager.importPasted(pasted)
    const storedFiles = await readdir(managedImportDirectory)
    const stored = JSON.parse(await readFile(join(managedImportDirectory, storedFiles[0]), 'utf8'))

    expect(result.accounts[0].email).toBe('pasted@example.com')
    expect(stored).toMatchObject({
      type: 'codex',
      auth_mode: 'chatgpt',
      email: 'pasted@example.com'
    })
  })

  it('exchanges pasted refresh tokens and persists the rotated credential in aa', async () => {
    const fixture = await setup()
    const managedImportDirectory = join(fixture.root, 'app', 'aa')
    const resolved: NormalizedCredential = {
      id: 'rt-account',
      email: 'rt-import@example.com',
      accountId: 'rt-workspace',
      subject: 'rt-user',
      accessToken: jwt({ sub: 'rt-user' }),
      refreshToken: 'rotated-refresh-token',
      idToken: jwt({ sub: 'rt-user', email: 'rt-import@example.com' }),
      authKind: 'oauth',
      oauthClientId: 'mobile-client-id',
      planType: 'plus',
      lastRefresh: '2026-07-16T00:00:00.000Z',
      accessExpiresAt: null,
      idExpiresAt: null,
      canRefresh: true,
      sourcePath: 'pasted-refresh-token.txt',
      sourceFormat: 'paste',
      sourceDialect: 'sub2api'
    }
    const refreshTokenImporter = {
      resolve: vi.fn().mockResolvedValue({ credentials: [resolved], errors: [], total: 1 })
    }
    const manager = new AccountManager({
      settings: () => fixture.settings,
      managedImportDirectory,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      refreshTokenImporter,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })

    const result = await manager.importPasted('plus rt.1.temporary-refresh-token-value')
    const stored = JSON.parse(await readFile(
      join(managedImportDirectory, 'rt-import@example.com_plus.json'),
      'utf8'
    ))

    expect(result.imported).toBe(1)
    expect(refreshTokenImporter.resolve).toHaveBeenCalledWith(
      'plus rt.1.temporary-refresh-token-value',
      'auto'
    )
    expect(stored).toMatchObject({
      email: 'rt-import@example.com',
      refresh_token: 'rotated-refresh-token',
      client_id: 'mobile-client-id'
    })
    expect((await fixture.vault.list())[0]).toMatchObject({
      refreshToken: 'rotated-refresh-token',
      oauthClientId: 'mobile-client-id'
    })
  })

  it('preserves the recognized RT count when every exchange fails', async () => {
    const fixture = await setup()
    const manager = new AccountManager({
      settings: () => fixture.settings,
      managedImportDirectory: join(fixture.root, 'app', 'aa'),
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      refreshTokenImporter: {
        resolve: vi.fn().mockResolvedValue({
          credentials: [],
          errors: ['#1：invalid_refresh_token'],
          total: 94
        })
      },
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })

    const result = await manager.importRefreshTokens('rt.1.invalid-value', 'codex')

    expect(result).toMatchObject({
      imported: 0,
      skipped: 0,
      recognized: 94,
      errors: ['#1：invalid_refresh_token']
    })
  })

  it('imports a large Sub2API bundle directly without exchanging its refresh tokens', async () => {
    const fixture = await setup()
    const sourcePath = join(fixture.root, 'sub2api-admin-data-payload.json')
    const clientId = 'app_custom_sub2api_client'
    const accounts = Array.from({ length: 751 }, (_, index) => ({
      name: `bundle-${index}@example.com`,
      platform: 'openai',
      type: 'oauth',
      credentials: {
        access_token: jwt({
          sub: `bundle-user-${index}`,
          exp: 1_900_000_000,
          'https://api.openai.com/auth': {
            chatgpt_account_id: `bundle-workspace-${index}`,
            chatgpt_plan_type: 'k12'
          }
        }),
        refresh_token: `bundle-refresh-${index}`,
        chatgpt_account_id: `bundle-workspace-${index}`,
        client_id: clientId,
        model_mapping: {
          'gpt-5.2': 'gpt-5.2',
          'gpt-5.3-codex': 'gpt-5.3-codex',
          'gpt-5.4': 'gpt-5.4',
          'gpt-5.4-mini': 'gpt-5.4-mini',
          'gpt-5.5': 'gpt-5.5',
          'gpt-5.6-sol': 'gpt-5.6-sol',
          'gpt-5.6-luna': 'gpt-5.6-luna',
          'gpt-5.6-terra': 'gpt-5.6-terra'
        }
      }
    }))
    await writeFile(sourcePath, JSON.stringify({
      type: 'sub2api-data',
      version: 1,
      accounts
    }))
    const refreshTokenImporter = {
      resolve: vi.fn().mockResolvedValue({
        credentials: [],
        errors: ['should not be called'],
        total: 751
      })
    }
    const manager = new AccountManager({
      settings: () => fixture.settings,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      refreshTokenImporter,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })

    const result = await manager.importFiles([sourcePath])

    expect(result).toMatchObject({ imported: 751, skipped: 0, errors: [] })
    expect(refreshTokenImporter.resolve).not.toHaveBeenCalled()
    expect(await fixture.vault.list()).toHaveLength(751)
    expect((await fixture.vault.list())[0].oauthClientId).toBe(clientId)
  })

  it('does not exchange refresh tokens when a structured access-token file exceeds parser limits', async () => {
    const fixture = await setup()
    const accessToken = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({
      sub: 'deep-structured-user'
    })).toString('base64url')}.signature`
    let nested: unknown = {
      access_token: accessToken,
      refresh_token: 'rt.1.must-not-be-exchanged'
    }
    for (let index = 0; index < 80; index += 1) nested = { nested }
    const refreshTokenImporter = {
      resolve: vi.fn().mockResolvedValue({
        credentials: [],
        errors: ['should not be called'],
        total: 1
      })
    }
    const manager = new AccountManager({
      settings: () => fixture.settings,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      refreshTokenImporter,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })

    const result = await manager.importPasted(JSON.stringify(nested))

    expect(result).toMatchObject({ imported: 0, skipped: 0 })
    expect(result.errors).toHaveLength(1)
    expect(refreshTokenImporter.resolve).not.toHaveBeenCalled()
  })

  it('marks the credential matching the current auth.json as active', async () => {
    const fixture = await setup()
    const idToken = jwt({ sub: 'user-a', email: 'person@example.com' })
    const accessToken = jwt({ sub: 'user-a', exp: 1_900_000_000 })
    await writeFile(
      join(fixture.accountDirectory, 'person.json'),
      JSON.stringify({
        id_token: idToken,
        access_token: accessToken,
        refresh_token: 'refresh-a',
        account_id: 'workspace-a'
      })
    )
    await mkdir(join(fixture.root, 'codex'))
    await writeFile(
      fixture.settings.authPath,
      JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          id_token: idToken,
          access_token: accessToken,
          refresh_token: 'refresh-a',
          account_id: 'workspace-a'
        }
      })
    )
    const manager = new AccountManager({
      settings: () => fixture.settings,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })

    await manager.scanDirectory()
    const accounts = await manager.listAccounts()

    expect(accounts).toHaveLength(1)
    expect(accounts[0].active).toBe(true)
  })

  it('tests selected accounts with the configured concurrency and progress reporting', async () => {
    const fixture = await setup()
    const records = Array.from({ length: 5 }, (_, index) => ({
      access_token: jwt({ sub: `user-${index}`, exp: 1_900_000_000 }),
      email: `person-${index}@example.com`,
      account_id: 'shared-workspace'
    }))
    await writeFile(join(fixture.accountDirectory, 'accounts.json'), JSON.stringify(records))
    let active = 0
    let maxActive = 0
    const tester = {
      test: vi.fn(async (item: NormalizedCredential) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 10))
        active -= 1
        return successfulResult(item.id)
      })
    }
    const progress = vi.fn()
    const manager = new AccountManager({
      settings: () => fixture.settings,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester,
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })
    await manager.scanDirectory()

    const result = await manager.testAccounts(undefined, { onProgress: progress })

    expect(result.tested).toBe(5)
    expect(maxActive).toBe(2)
    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ done: 5, total: 5, runningIds: [] })
    )
    expect(
      progress.mock.calls.some(
        ([value]) => value.updatedAccount?.status === 'valid' && value.updatedAccount?.usage?.planType === 'plus'
      )
    ).toBe(true)
    expect((await manager.listAccounts()).every((item) => item.status === 'valid')).toBe(true)
  })

  it('forwards refresh-only mode and preserves the previous usage snapshot', async () => {
    const fixture = await setup()
    await writeFile(
      join(fixture.accountDirectory, 'refresh-mode.json'),
      JSON.stringify({
        access_token: jwt({ sub: 'refresh-mode-user' }),
        refresh_token: 'refresh-mode-token',
        email: 'refresh-mode@example.com'
      })
    )
    const test = vi.fn(async (item: NormalizedCredential) => ({
      ...successfulResult(item.id),
      stage: 'refresh' as const,
      detail: '凭据刷新成功',
      refreshed: true,
      usage: null
    }))
    const manager = new AccountManager({
      settings: () => fixture.settings,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })
    const scan = await manager.scanDirectory()
    await fixture.statusStore.set(successfulResult(scan.accounts[0].id))

    const result = await manager.testAccounts([scan.accounts[0].id], { mode: 'refresh' })

    expect(test).toHaveBeenCalledWith(expect.any(Object), undefined, 'refresh')
    expect(result.results[0].usage?.planType).toBe('plus')
    expect((await manager.listAccounts())[0].usage?.planType).toBe('plus')
  })

  it('keeps the last account status across reloads and directory scans', async () => {
    const fixture = await setup()
    await writeFile(
      join(fixture.accountDirectory, 'persistent.json'),
      JSON.stringify({
        access_token: jwt({ sub: 'persistent-user' }),
        email: 'persistent@example.com'
      })
    )
    const options = {
      settings: () => fixture.settings,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    }
    const manager = new AccountManager(options)
    const scan = await manager.scanDirectory()
    await fixture.statusStore.set(successfulResult(scan.accounts[0].id))

    const reloaded = new AccountManager({
      ...options,
      statusStore: new StatusStore(join(fixture.root, 'app', 'status.json'))
    })

    expect((await reloaded.listAccounts())[0]).toMatchObject({
      status: 'valid',
      lastCheckedAt: '2026-07-15T00:00:00Z'
    })
    expect((await reloaded.scanDirectory()).accounts[0]).toMatchObject({
      status: 'valid',
      lastCheckedAt: '2026-07-15T00:00:00Z'
    })
  })

  it('switches with refreshed credentials written to the vault during validation', async () => {
    const fixture = await setup()
    await writeFile(
      join(fixture.accountDirectory, 'refresh.json'),
      JSON.stringify({
        type: 'codex',
        access_token: jwt({ sub: 'refresh-user', exp: 1 }),
        refresh_token: 'refresh-old',
        email: 'refresh@example.com'
      })
    )
    const switchTo = vi.fn().mockResolvedValue({ ok: true, message: 'ok', backupPath: null })
    const manager = new AccountManager({
      settings: () => fixture.settings,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: {
        test: vi.fn(async (item: NormalizedCredential) => {
          await fixture.vault.upsertMany([
            {
              ...item,
              accessToken: 'refreshed-access-token',
              refreshToken: 'refresh-new',
              lastRefresh: '2026-07-16T00:00:00Z'
            }
          ])
          return { ...successfulResult(item.id), refreshed: true }
        })
      },
      switcher: { switchTo, restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })
    const scan = await manager.scanDirectory()

    await manager.switchAccount(scan.accounts[0].id)

    expect(switchTo).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'refreshed-access-token',
        refreshToken: 'refresh-new',
        lastRefresh: '2026-07-16T00:00:00Z'
      })
    )
  })

  it('switches an unexpired credential without repeating network validation', async () => {
    const fixture = await setup()
    await writeFile(
      join(fixture.accountDirectory, 'fast-switch.json'),
      JSON.stringify({
        type: 'codex',
        access_token: jwt({ sub: 'fast-switch-user', exp: Math.floor(Date.now() / 1_000) + 3_600 }),
        refresh_token: 'refresh-fast',
        email: 'fast-switch@example.com'
      })
    )
    const test = vi.fn()
    const switchTo = vi.fn().mockResolvedValue({ ok: true, message: 'ok', backupPath: null })
    const manager = new AccountManager({
      settings: () => fixture.settings,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test },
      switcher: { switchTo, restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })
    const scan = await manager.scanDirectory()

    await expect(manager.switchAccount(scan.accounts[0].id)).resolves.toMatchObject({ ok: true })

    expect(test).not.toHaveBeenCalled()
    expect(switchTo).toHaveBeenCalledWith(expect.objectContaining({ email: 'fast-switch@example.com' }))
  })

  it.each([
    { status: 'invalid' as const, detail: '凭据已失效' },
    { status: 'needs_refresh' as const, detail: '凭据需要刷新' }
  ])('silently retests a credential with cached status $status before switching', async ({ status, detail }) => {
    const fixture = await setup()
    await writeFile(
      join(fixture.accountDirectory, 'invalid-switch.json'),
      JSON.stringify({
        type: 'codex',
        access_token: jwt({ sub: 'invalid-switch-user', exp: Math.floor(Date.now() / 1_000) + 3_600 }),
        email: 'invalid-switch@example.com'
      })
    )
    const test = vi.fn(async (item: NormalizedCredential) => successfulResult(item.id))
    const switchTo = vi.fn().mockResolvedValue({ ok: true, message: 'ok', backupPath: null })
    const manager = new AccountManager({
      settings: () => fixture.settings,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test },
      switcher: { switchTo, restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })
    const scan = await manager.scanDirectory()
    await fixture.statusStore.set({
      ...successfulResult(scan.accounts[0].id),
      status,
      detail
    })

    await expect(manager.switchAccount(scan.accounts[0].id)).resolves.toMatchObject({ ok: true })

    expect(test).toHaveBeenCalledTimes(1)
    expect(switchTo).toHaveBeenCalledTimes(1)
  })

  it.each([
    { status: 'quota_exhausted_5h' as const, detail: '5 小时额度已耗尽' },
    { status: 'workspace_deactivated' as const, detail: 'Team/K12 工作区已停用' }
  ])('auto-switches from an unusable active account with status $status', async ({ status, detail }) => {
    const fixture = await setup()
    const activeDocument = {
      auth_mode: 'chatgpt',
      tokens: {
        id_token: jwt({ sub: 'active-user', email: 'active@example.com' }),
        access_token: jwt({ sub: 'active-user', email: 'active@example.com' }),
        refresh_token: 'refresh-active',
        account_id: 'workspace-active'
      }
    }
    const candidateDocument = {
      auth_mode: 'chatgpt',
      tokens: {
        id_token: jwt({ sub: 'candidate-user', email: 'candidate@example.com' }),
        access_token: jwt({ sub: 'candidate-user', email: 'candidate@example.com' }),
        refresh_token: 'refresh-candidate',
        account_id: 'workspace-candidate'
      }
    }
    await mkdir(join(fixture.root, 'codex'), { recursive: true })
    await writeFile(fixture.settings.authPath, JSON.stringify(activeDocument))
    await writeFile(join(fixture.accountDirectory, 'active.json'), JSON.stringify(activeDocument))
    await writeFile(join(fixture.accountDirectory, 'candidate.json'), JSON.stringify(candidateDocument))
    const switchTo = vi.fn().mockResolvedValue({ ok: true, message: 'switched', backupPath: 'backup' })
    const tester = vi.fn(async (credential: NormalizedCredential) =>
      credential.email === 'active@example.com'
        ? { ...successfulResult(credential.id), status, detail }
        : successfulResult(credential.id)
    )
    const manager = new AccountManager({
      settings: () => fixture.settings,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: tester },
      switcher: { switchTo, restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })
    const scan = await manager.scanDirectory()
    const candidate = scan.accounts.find((account) => account.email === 'candidate@example.com')!

    const result = await manager.autoSwitch([candidate.id])

    expect(result).toMatchObject({ ok: true, switched: true, switchedAccountId: candidate.id })
    expect(switchTo).toHaveBeenCalledWith(expect.objectContaining({ email: 'candidate@example.com' }))
    expect(tester).toHaveBeenCalledTimes(2)
  })

  it('resolves an imported account source by opaque account id', async () => {
    const fixture = await setup()
    const sourcePath = join(fixture.accountDirectory, 'person.json')
    await writeFile(
      sourcePath,
      JSON.stringify({
        access_token: jwt({ sub: 'source-user' }),
        email: 'source@example.com'
      })
    )
    const manager = new AccountManager({
      settings: () => fixture.settings,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })
    const scan = await manager.scanDirectory()

    await expect(manager.getSourcePath(scan.accounts[0].id)).resolves.toBe(sourcePath)
    await expect(manager.getSourcePath('missing-account')).resolves.toBeNull()
  })

  it('keeps imported accounts when original source files are deleted', async () => {
    const fixture = await setup()
    const scannedPath = join(fixture.accountDirectory, 'scanned.json')
    const externalPath = join(fixture.root, 'external.json')
    await writeFile(scannedPath, JSON.stringify({
      access_token: jwt({ sub: 'scanned-user' }),
      email: 'scanned@example.com'
    }))
    await writeFile(externalPath, JSON.stringify({
      access_token: jwt({ sub: 'external-user' }),
      email: 'external@example.com'
    }))
    const managedImportDirectory = join(fixture.root, 'app', 'imports')
    const manager = new AccountManager({
      settings: () => fixture.settings,
      managedImportDirectory,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })
    await manager.importFiles([scannedPath], { archiveSources: true })
    await manager.importFiles([externalPath], { archiveSources: true })
    await unlink(scannedPath)

    const result = await manager.scanDirectory()

    expect(result.accounts.map((item) => item.email)).toEqual([
      'external@example.com',
      'scanned@example.com'
    ])
    expect(result.accounts.every((item) => item.sourcePath.startsWith(managedImportDirectory))).toBe(true)
    expect(await readFile(externalPath, 'utf8')).toContain('external@example.com')
  })

  it('treats a clean aa scan as authoritative when a managed file is removed', async () => {
    const fixture = await setup()
    const externalPath = join(fixture.root, 'authoritative.json')
    const managedImportDirectory = join(fixture.root, 'app', 'aa')
    await writeFile(externalPath, JSON.stringify({
      access_token: jwt({ sub: 'authoritative-user' }),
      email: 'authoritative@example.com'
    }))
    const manager = new AccountManager({
      settings: () => fixture.settings,
      managedImportDirectory,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })
    const imported = await manager.importFiles([externalPath], { archiveSources: true })
    const account = imported.accounts[0]
    await fixture.statusStore.set(successfulResult(account.id))
    await unlink(account.sourcePath)

    const scanned = await manager.scanDirectory()

    expect(scanned.accounts).toEqual([])
    expect(await fixture.vault.list()).toEqual([])
    expect(await fixture.statusStore.getAll()).toEqual({})
    expect(await readFile(externalPath, 'utf8')).toContain('authoritative@example.com')
  })

  it('rebuilds a missing aa directory from the encrypted vault after reinstall', async () => {
    const fixture = await setup()
    const externalPath = join(fixture.root, 'reinstall.json')
    const managedImportDirectory = join(fixture.root, 'app', 'aa')
    await writeFile(externalPath, JSON.stringify({
      access_token: jwt({ sub: 'reinstall-user' }),
      email: 'reinstall@example.com'
    }))
    const manager = new AccountManager({
      settings: () => fixture.settings,
      managedImportDirectory,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })
    await manager.importFiles([externalPath], { archiveSources: true })
    await rm(managedImportDirectory, { recursive: true, force: true })

    await manager.rebuildManagedLibraryFromVault()
    const scanned = await manager.scanDirectory()

    expect(scanned.accounts.map((account) => account.email)).toEqual(['reinstall@example.com'])
    expect(await readdir(managedImportDirectory)).toEqual(['reinstall@example.com_unknown.json'])
  })

  it('does not drop vault accounts when a managed aa file is temporarily malformed', async () => {
    const fixture = await setup()
    const externalPath = join(fixture.root, 'malformed-managed.json')
    const managedImportDirectory = join(fixture.root, 'app', 'aa')
    await writeFile(externalPath, JSON.stringify({
      access_token: jwt({ sub: 'malformed-managed-user' }),
      email: 'malformed-managed@example.com'
    }))
    const manager = new AccountManager({
      settings: () => fixture.settings,
      managedImportDirectory,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })
    const imported = await manager.importFiles([externalPath], { archiveSources: true })
    await truncate(imported.accounts[0].sourcePath, 2)

    const scanned = await manager.scanDirectory()

    expect(scanned.errors).toHaveLength(1)
    expect(scanned.accounts.map((account) => account.email)).toEqual(['malformed-managed@example.com'])
  })

  it('splits multi-account imports and removes exactly the deleted account file', async () => {
    const fixture = await setup()
    const externalPath = join(fixture.root, 'multi.json')
    const managedImportDirectory = join(fixture.root, 'app', 'aa')
    const deletedStore = new DeletedCredentialStore(join(fixture.root, 'app', 'deleted.json'))
    const source = JSON.stringify([
      { access_token: jwt({ sub: 'managed-a' }), email: 'managed-a@example.com' },
      { access_token: jwt({ sub: 'managed-b' }), email: 'managed-b@example.com' }
    ])
    await writeFile(externalPath, source)
    const manager = new AccountManager({
      settings: () => fixture.settings,
      managedImportDirectory,
      deletedStore,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })
    const imported = await manager.importFiles([externalPath], { archiveSources: true })
    const managedPath = imported.accounts[0].sourcePath

    await manager.deleteAccounts([imported.accounts[0].id])

    const remaining = await manager.scanDirectory()
    expect(remaining.accounts.map((account) => account.email)).toEqual(['managed-b@example.com'])
    expect(await readFile(externalPath, 'utf8')).toBe(source)
    await expect(stat(managedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    const remainingPath = remaining.accounts[0].sourcePath
    expect(await readFile(remainingPath, 'utf8')).toContain('managed-b@example.com')

    await manager.deleteAccounts([remaining.accounts[0].id])
    await expect(stat(remainingPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('migrates the legacy imports directory into aa', async () => {
    const fixture = await setup()
    const legacy = join(fixture.root, 'app', 'imports')
    const managedImportDirectory = join(fixture.root, 'app', 'aa')
    await mkdir(legacy, { recursive: true })
    await writeFile(
      join(legacy, 'legacy.json'),
      JSON.stringify({ access_token: jwt({ sub: 'legacy-user' }), email: 'legacy@example.com' })
    )
    const manager = new AccountManager({
      settings: () => fixture.settings,
      managedImportDirectory,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })

    await manager.migrateManagedDirectory(legacy)

    const accounts = await manager.listAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0].sourcePath).toBe(join(managedImportDirectory, 'legacy@example.com_unknown.json'))
    await expect(stat(join(legacy, 'legacy.json'))).resolves.toMatchObject({ isFile: expect.any(Function) })
  })

  it('persists account deletion across automatic scans and restores it on manual import', async () => {
    const fixture = await setup()
    const sourcePath = join(fixture.accountDirectory, 'deleted.json')
    const deletedStore = new DeletedCredentialStore(join(fixture.root, 'app', 'deleted.json'))
    await writeFile(
      sourcePath,
      JSON.stringify({
        access_token: jwt({ sub: 'deleted-user' }),
        email: 'deleted@example.com'
      })
    )
    const manager = new AccountManager({
      settings: () => fixture.settings,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      deletedStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })
    const scan = await manager.scanDirectory()
    const id = scan.accounts[0].id
    await fixture.statusStore.set(successfulResult(id))

    const deleted = await manager.deleteAccounts([id])

    expect(deleted.deleted).toBe(1)
    expect(await manager.listAccounts()).toEqual([])
    expect(await fixture.statusStore.getAll()).toEqual({})
    expect((await manager.scanDirectory()).accounts).toEqual([])

    const restored = await manager.importFiles([sourcePath])
    expect(restored.accounts).toHaveLength(1)
    expect(restored.accounts[0]).toMatchObject({ email: 'deleted@example.com', status: 'untested' })
  })
})
