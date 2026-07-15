import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NormalizedCredential, SecretCipher } from '../../shared/types'
import { CredentialVault } from './vault'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function credential(overrides: Partial<NormalizedCredential> = {}): NormalizedCredential {
  return {
    id: 'account-a',
    email: 'person@example.com',
    accountId: 'workspace-a',
    subject: 'user-a',
    accessToken: 'access-secret-value',
    refreshToken: 'refresh-secret-value',
    idToken: 'id-secret-value',
    planType: 'plus',
    lastRefresh: '2026-07-14T12:00:00Z',
    accessExpiresAt: '2026-10-14T12:00:00Z',
    idExpiresAt: '2026-10-14T12:00:00Z',
    canRefresh: true,
    sourcePath: 'account.json',
    sourceFormat: 'json',
    ...overrides
  }
}

const cipher: SecretCipher = {
  encrypt: (plainText) => Buffer.from([...plainText].reverse().join('')).toString('base64'),
  decrypt: (encryptedText) =>
    [...Buffer.from(encryptedText, 'base64').toString('utf8')].reverse().join('')
}

describe('CredentialVault', () => {
  it('persists credentials without writing plaintext tokens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-switcher-vault-'))
    tempDirs.push(dir)
    const path = join(dir, 'vault.json')
    const vault = new CredentialVault(path, cipher)

    await vault.upsertMany([credential()])

    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain('access-secret-value')
    expect(raw).not.toContain('refresh-secret-value')
    expect(await vault.get('account-a')).toMatchObject({ email: 'person@example.com' })
  })

  it('updates an existing identity and survives a new vault instance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-switcher-vault-'))
    tempDirs.push(dir)
    const path = join(dir, 'vault.json')
    const vault = new CredentialVault(path, cipher)

    await vault.upsertMany([credential()])
    await vault.upsertMany([
      credential({ accessToken: 'rotated-access', lastRefresh: '2026-07-15T12:00:00Z' })
    ])

    const reloaded = new CredentialVault(path, cipher)
    expect(await reloaded.list()).toHaveLength(1)
    expect((await reloaded.get('account-a'))?.accessToken).toBe('rotated-access')
  })

  it('removes selected local entries without exposing the remaining credential', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-switcher-vault-'))
    tempDirs.push(dir)
    const path = join(dir, 'vault.json')
    const vault = new CredentialVault(path, cipher)
    await vault.upsertMany([
      credential(),
      credential({ id: 'account-b', email: 'second@example.com', accessToken: 'second-secret' })
    ])

    await vault.removeMany(['account-a'])

    expect((await vault.list()).map((item) => item.id)).toEqual(['account-b'])
    expect(await readFile(path, 'utf8')).not.toContain('second-secret')
  })
})
