import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
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
    deepTestModel: 'gpt-5.4'
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

  it('archives manually imported source files without modifying their bytes', async () => {
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

    expect(archived).toEqual(['external-source.txt'])
    expect(await readFile(join(managedImportDirectory, archived[0]), 'utf8')).toBe(source)
    expect(await readFile(externalPath, 'utf8')).toBe(source)
    expect(result.accounts[0].sourcePath).toBe(join(managedImportDirectory, archived[0]))
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
    expect((await readdir(managedImportDirectory)).sort()).toEqual(['accounts.md', 'third.txt'])
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

  it('cleans pasted text, imports valid accounts and stores a reusable Sub2API file', async () => {
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
    expect(stored.type).toBe('sub2api-data')
    expect(stored.accounts).toHaveLength(1)
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
        access_token: jwt({ sub: 'refresh-user' }),
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
    await manager.scanDirectory()
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
