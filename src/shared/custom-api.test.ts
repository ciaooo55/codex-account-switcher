import { describe, expect, it } from 'vitest'
import {
  customApiChatCompletionsUrl,
  customApiModelsUrl,
  customApiModelsUrlCandidates,
  customApiProbeTargets,
  customApiResponsesUrl,
  expandCustomApiBaseUrls,
  normalizeCustomApiBaseUrl,
  stripCustomApiEndpointSuffix,
  parseCustomApiPaste
} from './custom-api'

describe('custom API URL helpers', () => {
  it('parses plain text url and key paste', () => {
    const r = parseCustomApiPaste('https://api.example.com/v1\nsk-abc123def456ghi789jkl012mno345pqr678')
    expect(r.baseUrl).toBe('https://api.example.com/v1')
    expect(r.apiKey).toBe('sk-abc123def456ghi789jkl012mno345pqr678')
  })

  it('parses base64-encoded json paste', () => {
    const json = JSON.stringify({ base_url: 'https://api.example.com/v1', api_key: 'sk-secret-key-1234567890' })
    const b64 = Buffer.from(json).toString('base64')
    const r = parseCustomApiPaste(b64)
    expect(r.baseUrl).toBe('https://api.example.com/v1')
    expect(r.apiKey).toBe('sk-secret-key-1234567890')
  })

  it('parses key=value pairs', () => {
    const r = parseCustomApiPaste('url=https://api.example.com/v1\nkey=sk-mykey123456789012345678')
    expect(r.baseUrl).toBe('https://api.example.com/v1')
    expect(r.apiKey).toBe('sk-mykey123456789012345678')
  })

  it('parses url-safe base64 without padding', () => {
    const json = JSON.stringify({ url: 'https://api.example.com/v1', key: 'sk-urlsafekey1234567890' })
    const b64 = Buffer.from(json).toString('base64url')
    const r = parseCustomApiPaste(b64)
    expect(r.baseUrl).toBe('https://api.example.com/v1')
    expect(r.apiKey).toBe('sk-urlsafekey1234567890')
  })

  it('handles a lone url', () => {
    const r = parseCustomApiPaste('https://api.example.com/v1')
    expect(r.baseUrl).toBe('https://api.example.com/v1')
    expect(r.apiKey).toBeNull()
  })

  it('reports nothing for garbage', () => {
    const r = parseCustomApiPaste('hello world')
    expect(r.baseUrl).toBeNull()
    expect(r.apiKey).toBeNull()
  })

  it('normalizes root to /v1 and strips full endpoint suffixes', () => {
    expect(normalizeCustomApiBaseUrl('http://127.0.0.1:18317')).toBe('http://127.0.0.1:18317/v1')
    expect(normalizeCustomApiBaseUrl('http://127.0.0.1:18317/v1')).toBe('http://127.0.0.1:18317/v1')
    expect(normalizeCustomApiBaseUrl('http://127.0.0.1:18317/v1/')).toBe('http://127.0.0.1:18317/v1')
    expect(normalizeCustomApiBaseUrl('http://127.0.0.1:18317/v1/chat/completions')).toBe(
      'http://127.0.0.1:18317/v1'
    )
    expect(normalizeCustomApiBaseUrl('http://127.0.0.1:18317/v1/responses')).toBe(
      'http://127.0.0.1:18317/v1'
    )
    expect(normalizeCustomApiBaseUrl('http://127.0.0.1:18317/v1/models')).toBe(
      'http://127.0.0.1:18317/v1'
    )
    expect(normalizeCustomApiBaseUrl('https://proxy.example.com/openai/v1/chat/completions')).toBe(
      'https://proxy.example.com/openai/v1'
    )
  })

  it('strips only the terminal endpoint segment', () => {
    expect(stripCustomApiEndpointSuffix('/v1/chat/completions')).toBe('/v1')
    expect(stripCustomApiEndpointSuffix('/chat/completions')).toBe('/')
    expect(stripCustomApiEndpointSuffix('/api/v1/models')).toBe('/api/v1')
  })

  it('expands common base path candidates including /v1 variants', () => {
    const bases = expandCustomApiBaseUrls('http://127.0.0.1:18317')
    expect(bases[0]).toBe('http://127.0.0.1:18317/v1')
    expect(bases).toEqual(
      expect.arrayContaining([
        'http://127.0.0.1:18317/v1',
        'http://127.0.0.1:18317/api/v1',
        'http://127.0.0.1:18317/openai/v1',
        'http://127.0.0.1:18317/v1/openai',
        'http://127.0.0.1:18317'
      ])
    )
  })

  it('builds model and completion URLs from the normalized base', () => {
    expect(customApiModelsUrl('http://127.0.0.1:18317')).toBe('http://127.0.0.1:18317/v1/models')
    expect(customApiResponsesUrl('http://127.0.0.1:18317/v1')).toBe(
      'http://127.0.0.1:18317/v1/responses'
    )
    expect(customApiChatCompletionsUrl('http://127.0.0.1:18317/v1')).toBe(
      'http://127.0.0.1:18317/v1/chat/completions'
    )
  })

  it('lists models URL candidates across common suffixes', () => {
    const urls = customApiModelsUrlCandidates('http://127.0.0.1:18317/v1/chat/completions')
    expect(urls[0]).toBe('http://127.0.0.1:18317/v1/models')
    expect(urls).toEqual(
      expect.arrayContaining([
        'http://127.0.0.1:18317/v1/models',
        'http://127.0.0.1:18317/api/v1/models',
        'http://127.0.0.1:18317/openai/v1/models',
        'http://127.0.0.1:18317/models'
      ])
    )
  })

  it('lists probe targets for responses then chat/completions on each base', () => {
    const targets = customApiProbeTargets('http://127.0.0.1:18317')
    expect(targets.some((t) => t.url === 'http://127.0.0.1:18317/v1/responses')).toBe(true)
    expect(targets.some((t) => t.url === 'http://127.0.0.1:18317/v1/chat/completions')).toBe(true)
    expect(targets.some((t) => t.url === 'http://127.0.0.1:18317/api/v1/responses')).toBe(true)
    expect(targets.some((t) => t.url === 'http://127.0.0.1:18317/openai/v1/chat/completions')).toBe(
      true
    )
    expect(targets.some((t) => t.url === 'http://127.0.0.1:18317/responses')).toBe(true)
    const firstChat = targets.findIndex((t) => t.endpoint === 'chat_completions')
    const lastResponses = targets.map((t) => t.endpoint).lastIndexOf('responses')
    expect(firstChat).toBeGreaterThan(lastResponses)
  })
})
