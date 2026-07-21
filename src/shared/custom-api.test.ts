import { describe, expect, it } from 'vitest'
import {
  customApiChatCompletionsUrl,
  customApiModelsUrl,
  customApiModelsUrlCandidates,
  customApiProbeTargets,
  customApiResponsesUrl,
  expandCustomApiBaseUrls,
  normalizeCustomApiBaseUrl,
  stripCustomApiEndpointSuffix
} from './custom-api'

describe('custom API URL helpers', () => {
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
