import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type {
  GrokCredential,
  NormalizedAgentIdentityCredential,
  NormalizedCredential
} from '../../shared/types'
import { CredentialUpstreamRegistry } from './credential-upstream-resolver'

function codex(id: string, token = `secret-${id}`): NormalizedCredential {
  return {
    id,
    email: `${id}@example.com`,
    accountId: `account-${id}`,
    subject: id,
    accessToken: token,
    refreshToken: null,
    idToken: null,
    authKind: 'oauth',
    planType: 'team',
    lastRefresh: null,
    accessExpiresAt: null,
    idExpiresAt: null,
    canRefresh: false,
    sourcePath: 'fixture.json',
    sourceFormat: 'json',
    sourceDialect: 'codex',
    secretExtensions: {
      schemaVersion: 1,
      accountType: 'oauth',
      credentials: { access_token: token },
      extra: { should_not_leak: token },
      modelMapping: { public: 'gpt-real' },
      concurrency: 10,
      priority: 7,
      rateMultiplier: 1,
      autoPauseOnExpired: true,
      metadata: { private: token }
    }
  }
}

function grok(id: string, token = `grok-secret-${id}`): GrokCredential {
  return {
    id,
    email: `${id}@example.com`,
    subject: id,
    teamId: null,
    accessToken: token,
    refreshToken: null,
    idToken: null,
    tokenType: 'Bearer',
    clientId: 'client',
    baseUrl: 'https://grok.com',
    tokenEndpoint: 'https://grok.com/token',
    scope: null,
    planType: null,
    lastRefresh: null,
    expiresAt: null,
    sourcePath: 'grok.json',
    sourceFormat: 'json',
    sourceDialect: 'generic',
    billingSnapshot: null,
    usageSnapshot: null
  }
}

function agentIdentity(id: string, taskId: string | null = 'task-existing'): NormalizedAgentIdentityCredential {
  const { privateKey } = generateKeyPairSync('ed25519')
  return {
    credentialKind: 'agent_identity',
    id,
    email: `${id}@example.com`,
    accountId: `account-${id}`,
    subject: `user-${id}`,
    authKind: 'agent_identity',
    agentIdentity: {
      runtimeId: `runtime-${id}`,
      privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      taskId,
      accountId: `account-${id}`,
      userId: `user-${id}`
    },
    planType: 'team',
    expiresAt: null,
    sourcePath: 'agent.json',
    sourceFormat: 'json',
    sourceDialect: 'cockpit',
    secretExtensions: {
      schemaVersion: 1,
      accountType: 'agent_identity',
      credentials: { agent_private_key: 'must-not-leak' },
      extra: null,
      modelMapping: { public: 'gpt-real' },
      concurrency: null,
      priority: 4,
      rateMultiplier: null,
      autoPauseOnExpired: null,
      metadata: { private: 'must-not-leak' }
    }
  }
}

describe('CredentialUpstreamRegistry', () => {
  it('discovers only sanitized references and retains safe route preferences', async () => {
    const credential = codex('abc', 'at-super-secret')
    const registry = new CredentialUpstreamRegistry({
      codex: async () => [credential],
      cpaCodex: async () => [],
      grok: async () => [],
      cpaGrok: async () => [],
      agentIdentity: async () => []
    })
    const discovered = await registry.discover()

    expect(discovered).toEqual([{
      id: 'codex:abc',
      provider: 'codex',
      credentialId: 'abc',
      label: 'abc@example.com',
      models: ['public'],
      priority: 7,
      enabled: false
    }])
    expect(JSON.stringify(discovered)).not.toContain('at-super-secret')
    expect(JSON.stringify(discovered)).not.toContain('should_not_leak')

    const configured = [{ ...discovered[0], models: ['manual-model'], enabled: true, priority: 2, label: 'Primary' }]
    await expect(registry.discover(configured)).resolves.toEqual([
      { ...configured[0], models: ['manual-model', 'public'] }
    ])
  })

  it('keeps setup/API/upstream records in the account library but never treats them as Codex Bearer sources', async () => {
    const unsafe = { ...codex('api-key-record'), authKind: 'api_key' as const }
    const registry = new CredentialUpstreamRegistry({
      codex: async () => [unsafe], cpaCodex: async () => [], grok: async () => [], cpaGrok: async () => [],
      agentIdentity: async () => []
    })
    await expect(registry.discover()).resolves.toEqual([])
    await expect(registry.resolve({
      source: { id: 'codex:api-key-record', provider: 'codex', credentialId: 'api-key-record', label: 'unsafe', models: ['x'], priority: 1, enabled: true },
      endpoint: '/v1/responses', upstreamModel: 'x'
    })).resolves.toBeNull()
  })

  it('resolves live Codex and Grok tokens only when constructing upstream requests', async () => {
    let currentCodex = codex('codex-id', 'at-first')
    const grokCredential = grok('grok-id', 'xai-live')
    const registry = new CredentialUpstreamRegistry({
      codex: async () => [currentCodex],
      cpaCodex: async () => [],
      grok: async () => [grokCredential],
      cpaGrok: async () => [],
      agentIdentity: async () => []
    })
    const source = {
      id: 'codex:codex-id', provider: 'codex' as const, credentialId: 'codex-id',
      label: 'Codex', models: [], priority: 1, enabled: true
    }
    const first = await registry.resolve({ source, endpoint: '/v1/responses', upstreamModel: 'public' })
    expect(first).toMatchObject({
      url: 'https://chatgpt.com/backend-api/codex/responses',
      upstreamModel: 'gpt-real',
      failureCooldownMs: { unauthorized: 86_400_000, rateLimited: 900_000 },
      headers: {
        authorization: 'Bearer at-first',
        'chatgpt-account-id': 'account-codex-id',
        originator: 'codex-tui'
      },
      bodyPatch: { store: false }
    })

    currentCodex = codex('codex-id', 'at-refreshed')
    const refreshed = await registry.resolve({ source, endpoint: '/v1/responses/compact', upstreamModel: 'public' })
    expect(refreshed?.url).toBe('https://chatgpt.com/backend-api/codex/responses/compact')
    expect(refreshed?.headers.authorization).toBe('Bearer at-refreshed')
    expect(refreshed?.headers['openai-beta']).toBe('responses=experimental')

    const grokSource = {
      id: 'grok:grok-id', provider: 'grok' as const, credentialId: 'grok-id',
      label: 'Grok', models: [], priority: 1, enabled: true
    }
    const resolvedGrok = await registry.resolve({ source: grokSource, endpoint: '/v1/responses', upstreamModel: 'grok-public' })
    expect(resolvedGrok).toMatchObject({
      url: 'https://cli-chat-proxy.grok.com/v1/responses',
      headers: {
        authorization: 'Bearer xai-live',
        'x-xai-token-auth': 'xai-grok-cli',
        'x-grok-client-version': '0.2.93'
      }
    })
    await expect(registry.resolve({ source: grokSource, endpoint: '/v1/responses/compact', upstreamModel: 'grok-public' }))
      .resolves.toBeNull()
  })

  it('uses a signed AgentAssertion and persists a registered task without exposing the private key', async () => {
    const identity = agentIdentity('agent-id', null)
    let persisted: NormalizedAgentIdentityCredential | null = null
    const fetchMock = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      expect(String(url)).toBe('https://auth.openai.com/api/accounts/v1/agent/runtime-agent-id/task/register')
      expect(init?.method).toBe('POST')
      const body = JSON.parse(String(init?.body)) as { timestamp: string; signature: string }
      expect(body.timestamp).toMatch(/Z$/)
      expect(body.signature).not.toContain(identity.agentIdentity.privateKey)
      return new Response(JSON.stringify({ task_id: 'task-registered' }), { status: 200 })
    }
    const registry = new CredentialUpstreamRegistry({
      codex: async () => [],
      cpaCodex: async () => [],
      grok: async () => [],
      cpaGrok: async () => [],
      agentIdentity: async () => [identity],
      updateAgentIdentity: async (updated) => { persisted = updated }
    }, fetchMock)
    const discovered = await registry.discover()
    expect(discovered).toEqual([{
      id: 'agent-identity:agent-id',
      provider: 'agent-identity',
      credentialId: 'agent-id',
      label: 'agent-id@example.com',
      models: ['public'],
      priority: 4,
      enabled: false
    }])
    expect(JSON.stringify(discovered)).not.toContain(identity.agentIdentity.privateKey)

    const source = { ...discovered[0], enabled: true }
    const resolved = await registry.resolve({ source, endpoint: '/v1/responses', upstreamModel: 'public' })
    expect((persisted as NormalizedAgentIdentityCredential | null)?.agentIdentity.taskId).toBe('task-registered')
    expect(resolved?.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(resolved?.headers.authorization).toMatch(/^AgentAssertion /)
    expect(resolved?.headers.authorization).not.toContain(identity.agentIdentity.privateKey)

    const envelope = JSON.parse(Buffer.from(resolved!.headers.authorization.slice('AgentAssertion '.length), 'base64url').toString('utf8')) as {
      agent_runtime_id: string
      task_id: string
      timestamp: string
      signature: string
    }
    const privateKey = Buffer.from(identity.agentIdentity.privateKey, 'base64')
    const publicKey = createPublicKey(createPrivateKey({ key: privateKey, format: 'der', type: 'pkcs8' }))
    expect(verify(null, Buffer.from(`${envelope.agent_runtime_id}:${envelope.task_id}:${envelope.timestamp}`), publicKey, Buffer.from(envelope.signature, 'base64'))).toBe(true)
  })
})
