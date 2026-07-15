import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedCredential, SecretCipher } from '../../shared/types'
import { CredentialSwitcher } from './switcher'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const cipher: SecretCipher = {
  encrypt: (plainText) => Buffer.from(plainText).toString('base64'),
  decrypt: (encryptedText) => Buffer.from(encryptedText, 'base64').toString('utf8')
}

function credential(overrides: Partial<NormalizedCredential> = {}): NormalizedCredential {
  return {
    id: 'account-a',
    email: 'person@example.com',
    accountId: 'workspace-a',
    subject: 'user-a',
    accessToken: 'access-a',
    refreshToken: 'refresh-a',
    idToken: 'id-a',
    planType: 'plus',
    lastRefresh: '2026-07-14T12:00:00Z',
    accessExpiresAt: '2026-10-14T12:00:00Z',
    idExpiresAt: '2026-10-14T12:00:00Z',
    canRefresh: true,
    sourcePath: 'account.json',
    sourceFormat: 'json',
    sourceDialect: 'cpa',
    ...overrides
  }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-switcher-switch-'))
  tempDirs.push(dir)
  const authPath = join(dir, 'auth.json')
  const configPath = join(dir, 'config.toml')
  const backupDir = join(dir, 'backups')
  await writeFile(authPath, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'api-secret' }))
  await writeFile(
    configPath,
    'model_provider = "custom"\nmodel = "custom-model"\n\n[model_providers.custom]\nbase_url = "http://localhost"\n'
  )
  return { dir, authPath, configPath, backupDir }
}

describe('CredentialSwitcher', () => {
  it('atomically writes ChatGPT auth, patches config and keeps encrypted backups', async () => {
    const paths = await fixture()
    const switcher = new CredentialSwitcher({ ...paths, cipher, backupRetention: 20 })

    const result = await switcher.switchTo(credential())

    expect(result.ok).toBe(true)
    expect(JSON.parse(await readFile(paths.authPath, 'utf8'))).toEqual({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: 'id-a',
        access_token: 'access-a',
        refresh_token: 'refresh-a',
        account_id: 'workspace-a'
      },
      last_refresh: '2026-07-14T12:00:00Z'
    })
    expect(await readFile(paths.configPath, 'utf8')).toContain('model_provider = "openai"')
    const backupRaw = await readFile(result.backupPath!, 'utf8')
    expect(backupRaw).not.toContain('api-secret')
  })

  it('writes CPA access-only credentials in the Codex external token shape', async () => {
    const paths = await fixture()
    const switcher = new CredentialSwitcher({ ...paths, cipher, backupRetention: 20 })

    const result = await switcher.switchTo(
      credential({
        idToken: null,
        refreshToken: null,
        canRefresh: false,
        planType: 'k12'
      })
    )

    expect(result).toMatchObject({ ok: true })
    expect(result.message).toContain('CPA/Team 临时登录')
    expect(JSON.parse(await readFile(paths.authPath, 'utf8'))).toMatchObject({
      auth_mode: 'chatgptAuthTokens',
      tokens: {
        id_token: 'access-a',
        access_token: 'access-a',
        refresh_token: '',
        account_id: 'workspace-a'
      }
    })
  })

  it('rejects access-only credentials without an account id and restores prior config', async () => {
    const paths = await fixture()
    const switcher = new CredentialSwitcher({ ...paths, cipher, backupRetention: 20 })

    const result = await switcher.switchTo(
      credential({
        accountId: null,
        idToken: null,
        refreshToken: null,
        canRefresh: false
      })
    )

    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain('缺少 account_id')
    expect(JSON.parse(await readFile(paths.authPath, 'utf8')).auth_mode).toBe('apikey')
    expect(await readFile(paths.configPath, 'utf8')).toContain('model_provider = "custom"')
  })

  it('rolls back auth and config when post-write validation fails', async () => {
    const paths = await fixture()
    const validate = vi.fn().mockResolvedValue(false)
    const switcher = new CredentialSwitcher({
      ...paths,
      cipher,
      backupRetention: 20,
      validate
    })

    const result = await switcher.switchTo(credential())

    expect(result.ok).toBe(false)
    expect(JSON.parse(await readFile(paths.authPath, 'utf8')).auth_mode).toBe('apikey')
    expect(await readFile(paths.configPath, 'utf8')).toContain('model_provider = "custom"')
  })

  it('restores the latest API/proxy configuration without losing unrelated later config edits', async () => {
    const paths = await fixture()
    const switcher = new CredentialSwitcher({ ...paths, cipher, backupRetention: 20 })
    await switcher.switchTo(credential())
    await writeFile(
      paths.configPath,
      `${await readFile(paths.configPath, 'utf8')}\n[features]\ngoals = false\n`
    )

    const restored = await switcher.restoreLatest()

    expect(restored.ok).toBe(true)
    expect(JSON.parse(await readFile(paths.authPath, 'utf8')).auth_mode).toBe('apikey')
    expect(await readFile(paths.configPath, 'utf8')).toContain('model_provider = "custom"')
    expect(await readFile(paths.configPath, 'utf8')).toContain('goals = false')
  })

  it('restores the most recent API mode even after multiple ChatGPT account switches', async () => {
    const paths = await fixture()
    const switcher = new CredentialSwitcher({ ...paths, cipher, backupRetention: 20 })
    await switcher.switchTo(credential())
    await switcher.switchTo(credential({ id: 'account-b', accessToken: 'access-b' }))

    const restored = await switcher.restoreApiMode()

    expect(restored.ok).toBe(true)
    expect(JSON.parse(await readFile(paths.authPath, 'utf8'))).toMatchObject({
      auth_mode: 'apikey',
      OPENAI_API_KEY: 'api-secret'
    })
    expect(await readFile(paths.configPath, 'utf8')).toContain('model_provider = "custom"')
  })
})
