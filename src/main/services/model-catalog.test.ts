import { describe, expect, it, vi } from 'vitest'
import {
  buildModelCatalog,
  customApiModelsUrl,
  fetchOpenAiCompatibleModelIds
} from './model-catalog'

describe('model catalog helpers', () => {
  it('builds a preferred-first catalog with list visibility', () => {
    const catalog = buildModelCatalog(['b-model', 'a-model', 'b-model'], 'a-model')
    expect(catalog.models.map((model) => model.slug)).toEqual(['a-model', 'b-model'])
    expect(catalog.models[0]).toMatchObject({
      slug: 'a-model',
      display_name: 'a-model',
      visibility: 'list',
      supported_in_api: true,
      priority: 1
    })
    expect(catalog.models[0].supported_reasoning_levels.map((level) => level.effort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh'
    ])
  })

  it('always includes the preferred model even when remote list is empty', () => {
    const catalog = buildModelCatalog([], 'grok-4.5')
    expect(catalog.models).toHaveLength(1)
    expect(catalog.models[0].slug).toBe('grok-4.5')
  })

  it('normalizes models URL from a base URL', () => {
    expect(customApiModelsUrl('http://127.0.0.1:18317')).toBe('http://127.0.0.1:18317/v1/models')
    expect(customApiModelsUrl('http://127.0.0.1:18317/v1')).toBe('http://127.0.0.1:18317/v1/models')
  })

  it('parses OpenAI-compatible /v1/models responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'grok-4.5' }, { id: 'gpt-custom' }, { id: 'grok-4.5' }, { id: '!!bad!!' }, { id: ' spaced ' }]
      })
    })

    const ids = await fetchOpenAiCompatibleModelIds({
      baseUrl: 'http://127.0.0.1:18317/v1',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(ids).toEqual(['grok-4.5', 'gpt-custom', 'spaced'])
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:18317/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-test'
        })
      })
    )
  })
})
