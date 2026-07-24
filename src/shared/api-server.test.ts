import { describe, expect, it } from 'vitest'
import {
  buildOpenAiUpstreamUrl,
  normalizeLocalApiServerConfig,
  normalizeModelIds
} from './api-server'

describe('api server shared configuration', () => {
  it('normalizes model IDs and rejects invalid or duplicate routes', () => {
    expect(normalizeModelIds([' gpt-x ', 'gpt-x', 'bad model', 'vendor/model'])).toEqual([
      'gpt-x',
      'vendor/model'
    ])

    expect(() => normalizeLocalApiServerConfig({
      port: 0,
      autoStart: false,
      accessKeys: [],
      upstreams: [],
      routes: []
    })).toThrow('1 到 65535')
  })

  it('builds the correct endpoint for root, /v1, and nested /v1 bases', () => {
    expect(buildOpenAiUpstreamUrl('https://api.example.com', '/v1/responses')).toBe(
      'https://api.example.com/v1/responses'
    )
    expect(buildOpenAiUpstreamUrl('https://api.example.com/v1/', '/v1/responses')).toBe(
      'https://api.example.com/v1/responses'
    )
    expect(buildOpenAiUpstreamUrl('https://api.example.com/openai/v1', '/v1/chat/completions')).toBe(
      'https://api.example.com/openai/v1/chat/completions'
    )
  })

  it('accepts stable credential references only in compatible route modes', () => {
    const input = {
      port: 8888,
      autoStart: false,
      accessKeys: [],
      upstreams: [],
      credentialSources: [{
        id: 'cpa-codex:abc',
        provider: 'cpa-codex' as const,
        credentialId: 'abc',
        label: 'CPA account',
        models: [' gpt-real '],
        priority: 1.8,
        enabled: true
      }],
      routes: [{
        publicModel: 'xxx',
        strategy: 'priority' as const,
        sourceMode: 'credential_only' as const,
        targets: [{ sourceId: 'cpa-codex:abc', upstreamModel: 'gpt-real', priority: 1, enabled: true }]
      }]
    }
    expect(normalizeLocalApiServerConfig(input)).toMatchObject({
      credentialSources: [{ id: 'cpa-codex:abc', models: ['gpt-real'], priority: 1 }]
    })
    expect(() => normalizeLocalApiServerConfig({
      ...input,
      routes: [{ ...input.routes[0], sourceMode: 'api_only' }]
    })).toThrow('类型不匹配')
    expect(() => normalizeLocalApiServerConfig({
      ...input,
      credentialSources: [{ ...input.credentialSources[0], id: 'codex:abc' }]
    })).toThrow('凭证来源 ID')
  })

  it('accepts explicit native upstream protocols and a no-auth local upstream', () => {
    const input = {
      port: 8888,
      autoStart: false,
      accessKeys: [],
      upstreams: [{
        id: 'ollama', name: 'Local Ollama', baseUrl: 'http://127.0.0.1:11434', apiKey: '',
        protocol: 'ollama' as const, models: ['llama-local'], priority: 1, enabled: true
      }],
      routes: [{
        publicModel: 'local-model', strategy: 'single' as const, sourceMode: 'api_only' as const,
        targets: [{ sourceId: 'ollama', upstreamModel: 'llama-local', priority: 1, enabled: true }]
      }]
    }
    expect(normalizeLocalApiServerConfig(input)).toMatchObject({
      upstreams: [{ protocol: 'ollama', apiKey: '' }]
    })
  })

  it('keeps an explicit Codex loopback binding and rejects malformed values', () => {
    const input = {
      port: 8888,
      autoStart: false,
      accessKeys: [{ id: 'codex-key', label: 'Codex', key: 'sk-local', enabled: true, allowedModels: [] }],
      upstreams: [],
      codexBinding: { accessKeyId: ' codex-key ', model: ' xxx ', enforce: true },
      routes: [{ publicModel: 'xxx', strategy: 'single' as const, sourceMode: 'api_only' as const, targets: [] }]
    }
    expect(normalizeLocalApiServerConfig(input)).toMatchObject({
      codexBinding: { accessKeyId: 'codex-key', model: 'xxx', enforce: true }
    })
    expect(() => normalizeLocalApiServerConfig({
      ...input,
      codexBinding: { accessKeyId: 'bad id', model: 'xxx', enforce: true }
    })).toThrow('Codex API 服务绑定无效')
  })
})
