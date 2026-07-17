import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, SecretCipher } from '../../shared/types'
import { CredentialVault } from '../storage/vault'
import { StatusStore } from '../storage/status-store'
import { GrokStatusStore } from '../storage/grok-status-store'
import { AccountManager } from './account-manager'
import { GrokAccountManager } from './grok-account-manager'
import { combineLibraryImportResults } from './library-import'

const roots: string[] = []
const cipher: SecretCipher = {
  encrypt: (value) => Buffer.from(value).toString('base64'),
  decrypt: (value) => Buffer.from(value, 'base64').toString('utf8')
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('local library import boundaries', () => {
  it('splits a mixed source into aa/codex and aa/grok without changing the source or CPA directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mixed-account-library-'))
    roots.push(root)
    const aa = join(root, 'aa')
    const codexDirectory = join(aa, 'codex')
    const grokDirectory = join(aa, 'grok')
    const cpaDirectory = join(root, 'cpa')
    const source = join(root, 'mixed.md')
    await mkdir(cpaDirectory, { recursive: true })
    await writeFile(join(cpaDirectory, 'keep.json'), '{"keep":true}\n')

    const sourceText = `# mixed\n\n\`\`\`json\n${JSON.stringify({ accounts: [
      {
        platform: 'openai',
        type: 'oauth',
        credentials: {
          access_token: jwt({ iss: 'https://auth.openai.com', sub: 'codex-user', email: 'codex@example.com' }),
          refresh_token: 'codex-refresh',
          email: 'codex@example.com',
          plan_type: 'plus'
        }
      },
      {
        platform: 'grok',
        type: 'oauth',
        credentials: {
          access_token: jwt({ iss: 'https://auth.x.ai', sub: 'grok-user' }),
          refresh_token: 'grok-refresh',
          email: 'grok@example.com',
          plan_type: 'SuperGrok'
        }
      }
    ] })}\n\`\`\``
    await writeFile(source, sourceText)

    const settings: AppSettings = {
      accountDirectory: root,
      authPath: join(root, '.codex', 'auth.json'),
      configPath: join(root, '.codex', 'config.toml'),
      concurrency: 2,
      timeoutMs: 1_000,
      backupRetention: 20,
      deepTestModel: 'gpt-5.4',
      autoSwitchEnabled: false,
      autoSwitchIntervalSeconds: 300,
      autoSwitchAccountIds: [],
      autoSwitchRestartCodex: false,
      grokDirectory: cpaDirectory,
      customApiBaseUrl: 'https://api.openai.com/v1',
      customApiModel: 'gpt-5.4'
    }
    const codex = new AccountManager({
      settings: () => settings,
      vault: new CredentialVault(join(root, 'vault.json'), cipher),
      statusStore: new StatusStore(join(root, 'status.json')),
      managedImportDirectory: codexDirectory,
      tester: { test: vi.fn() },
      switcher: { switchTo: vi.fn(), restoreLatest: vi.fn(), restoreApiMode: vi.fn() }
    })
    const grok = new GrokAccountManager({
      directory: () => grokDirectory,
      fileNameStyle: 'library',
      concurrency: () => 2,
      statusStore: new GrokStatusStore(join(root, 'grok-status.json')),
      tester: { test: vi.fn() }
    })

    const first = combineLibraryImportResults(
      await codex.importFiles([source], { archiveSources: true }),
      await grok.importFiles([source])
    )
    const second = combineLibraryImportResults(
      await codex.importFiles([source], { archiveSources: true }),
      await grok.importFiles([source])
    )

    expect(first).toMatchObject({ codexImported: 1, grokImported: 1, errors: [] })
    expect(second).toMatchObject({ codexImported: 0, codexSkipped: 1, grokImported: 0, grokSkipped: 1 })
    expect(await readdir(codexDirectory)).toEqual(['codex@example.com_plus.json'])
    expect(await readdir(grokDirectory)).toEqual(['grok@example.com_supergrok.json'])
    expect(await readFile(source, 'utf8')).toBe(sourceText)
    expect(await readdir(cpaDirectory)).toEqual(['keep.json'])
    expect(await readFile(join(cpaDirectory, 'keep.json'), 'utf8')).toBe('{"keep":true}\n')
  })
})
