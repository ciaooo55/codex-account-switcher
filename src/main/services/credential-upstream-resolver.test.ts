import { describe, expect, it } from 'vitest'
import type { GrokCredential, NormalizedCredential } from '../../shared/types'
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

describe('CredentialUpstreamRegistry', () => {
  it('discovers only sanitized references and retains safe route preferences', async () => {
    const credential = codex('abc', 'at-super-secret')
    const registry = new CredentialUpstreamRegistry({
      codex: async () => [credential],
      cpaCodex: async () => [],
      grok: async () => [],
      cpaGrok: async () => []
    })
    const discovered = await registry.discover()

    expect(discovered).toEqual([{
      id: 'codex:abc',
      provider: 'codex',
      credentialId: 'abc',
      label: 'abc@example.com',
      models: ['public', 'gpt-real'],
      priority: 7,
      enabled: false
    }])
    expect(JSON.stringify(discovered)).not.toContain('at-super-secret')
    expect(JSON.stringify(discovered)).not.toContain('should_not_leak')

    const configured = [{ ...discovered[0], models: ['manual-model'], enabled: true, priority: 2, label: 'Primary' }]
    await expect(registry.discover(configured)).resolves.toEqual([
      { ...configured[0], models: ['manual-model', 'public', 'gpt-real'] }
    ])
  })

  it('resolves live Codex and Grok tokens only when constructing upstream requests', async () => {
    let currentCodex = codex('codex-id', 'at-first')
    const grokCredential = grok('grok-id', 'xai-live')
    const registry = new CredentialUpstreamRegistry({
      codex: async () => [currentCodex],
      cpaCodex: async () => [],
      grok: async () => [grokCredential],
      cpaGrok: async () => []
    })
    const source = {
      id: 'codex:codex-id', provider: 'codex' as const, credentialId: 'codex-id',
      label: 'Codex', models: [], priority: 1, enabled: true
    }
    const first = await registry.resolve({ source, endpoint: '/v1/responses' })
    expect(first).toMatchObject({
      url: 'https://chatgpt.com/backend-api/codex/responses',
      headers: {
        authorization: 'Bearer at-first',
        'chatgpt-account-id': 'account-codex-id',
        originator: 'codex-tui'
      },
      bodyPatch: { store: false }
    })

    currentCodex = codex('codex-id', 'at-refreshed')
    const refreshed = await registry.resolve({ source, endpoint: '/v1/responses/compact' })
    expect(refreshed?.url).toBe('https://chatgpt.com/backend-api/codex/responses/compact')
    expect(refreshed?.headers.authorization).toBe('Bearer at-refreshed')
    expect(refreshed?.headers['openai-beta']).toBe('responses=experimental')

    const grokSource = {
      id: 'grok:grok-id', provider: 'grok' as const, credentialId: 'grok-id',
      label: 'Grok', models: [], priority: 1, enabled: true
    }
    const resolvedGrok = await registry.resolve({ source: grokSource, endpoint: '/v1/responses' })
    expect(resolvedGrok).toMatchObject({
      url: 'https://cli-chat-proxy.grok.com/v1/responses',
      headers: {
        authorization: 'Bearer xai-live',
        'x-xai-token-auth': 'xai-grok-cli',
        'x-grok-client-version': '0.2.93'
      }
    })
    await expect(registry.resolve({ source: grokSource, endpoint: '/v1/responses/compact' }))
      .resolves.toBeNull()
  })
})
