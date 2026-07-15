import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AppSettings,
  NormalizedCredential,
  SecretCipher,
  TestResult
} from '../../shared/types'
import { CredentialVault } from '../storage/vault'
import { StatusStore } from '../storage/status-store'
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
    expect(progress).toHaveBeenLastCalledWith({ done: 5, total: 5 })
    expect((await manager.listAccounts()).every((item) => item.status === 'valid')).toBe(true)
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

  it('reconciles deleted files from the scanned directory but keeps external imports', async () => {
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
    const manager = new AccountManager({
      settings: () => fixture.settings,
      vault: fixture.vault,
      statusStore: fixture.statusStore,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })
    await manager.scanDirectory()
    await manager.importFiles([externalPath])
    await unlink(scannedPath)

    const result = await manager.scanDirectory()

    expect(result.accounts.map((item) => item.email)).toEqual(['external@example.com'])
    expect(await readFile(externalPath, 'utf8')).toContain('external@example.com')
  })
})
