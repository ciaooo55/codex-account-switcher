import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NormalizedAgentIdentityCredential, SecretCipher } from '../../shared/types'
import { AgentIdentityVault } from './agent-identity-vault'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const cipher: SecretCipher = {
  encrypt: (plainText) => Buffer.from([...plainText].reverse().join('')).toString('base64'),
  decrypt: (encryptedText) => [...Buffer.from(encryptedText, 'base64').toString('utf8')].reverse().join('')
}

function identity(overrides: Partial<NormalizedAgentIdentityCredential> = {}): NormalizedAgentIdentityCredential {
  return {
    credentialKind: 'agent_identity',
    id: 'agent-a',
    email: 'agent@example.invalid',
    accountId: 'workspace-a',
    subject: 'user-a',
    authKind: 'agent_identity',
    agentIdentity: {
      runtimeId: 'runtime-secret',
      privateKey: 'private-key-secret',
      taskId: 'task-secret',
      accountId: 'workspace-a',
      userId: 'user-a'
    },
    planType: 'team',
    expiresAt: null,
    sourcePath: 'agent.json',
    sourceFormat: 'json',
    sourceDialect: 'cockpit',
    secretExtensions: {
      schemaVersion: 1,
      accountType: 'agent_identity',
      credentials: { agent_private_key: 'private-key-secret' },
      extra: null,
      modelMapping: { public: 'gpt-real' },
      concurrency: null,
      priority: 1,
      rateMultiplier: null,
      autoPauseOnExpired: null,
      metadata: {}
    },
    ...overrides
  }
}

describe('AgentIdentityVault', () => {
  it('encrypts private key material and restores task updates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-switcher-agent-vault-'))
    tempDirs.push(dir)
    const path = join(dir, 'agent-identities.json')
    const vault = new AgentIdentityVault(path, cipher)

    await vault.upsertMany([identity()])
    const raw = await readFile(path, 'utf8')
    expect(raw).not.toContain('private-key-secret')
    expect(raw).not.toContain('task-secret')

    await vault.upsertMany([identity({ agentIdentity: { ...identity().agentIdentity, taskId: 'task-rotated' } })])
    expect((await new AgentIdentityVault(path, cipher).get('agent-a'))?.agentIdentity.taskId).toBe('task-rotated')
  })
})
