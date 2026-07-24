import { describe, expect, it, vi } from 'vitest'
import { isAbsolute, resolve } from 'node:path'
import {
  buildModelCatalog,
  CUSTOM_MODEL_AVAILABLE_IN_PLANS,
  customApiModelsUrl,
  fetchOpenAiCompatibleModelIds,
  modelCatalogConfigPath,
  MODEL_CATALOG_RELATIVE_PATH,
  probeCustomApiModel
} from './model-catalog'
import { customApiChatCompletionsUrl, customApiResponsesUrl } from '../../shared/custom-api'

describe('model catalog helpers', () => {
  it('exposes an absolute config path for model_catalog_json', () => {
    const codexHome = resolve('fixtures', 'codex-home')
    const configPath = modelCatalogConfigPath(codexHome)

    expect(configPath).toBe(resolve(codexHome, 'account-switcher-model-catalog.json'))
    expect(isAbsolute(configPath)).toBe(true)
    expect(MODEL_CATALOG_RELATIVE_PATH).toBe('account-switcher-model-catalog.json')
  })

  it('preserves the exact normalized input order and adds picker metadata', () => {
    const catalog = buildModelCatalog(['b-model', 'a-model', 'b-model'], 'a-model')
    expect(catalog.models.map((model) => model.slug)).toEqual(['b-model', 'a-model'])
    expect(catalog.models[0]).toMatchObject({
      slug: 'b-model',
      display_name: 'b-model',
      visibility: 'list',
      supported_in_api: true,
      priority: 1,
      base_instructions: expect.any(String),
      available_in_plans: CUSTOM_MODEL_AVAILABLE_IN_PLANS,
      supports_reasoning_summary_parameter: true
    })
    expect(catalog.models[0].base_instructions.length).toBeGreaterThan(20)
    expect(catalog.models.every((model) => typeof model.base_instructions === 'string')).toBe(true)
    expect(catalog.models[0].prefer_websockets).toBe(false)
    expect(catalog.models[0].supports_reasoning_summaries).toBe(true)
    expect(catalog.models[0].effective_context_window_percent).toBe(100)
    expect(catalog.models[0].multi_agent_version).toBe('v2')
    expect(Boolean(catalog.models[0].model_messages)).toBe(true)
    expect(catalog.models.every((model) => model.include_skills_usage_instructions === true)).toBe(true)
    expect(catalog.models.every((model) => model.use_responses_lite === false)).toBe(true)
    expect(catalog.models.every((model) => model.support_verbosity === true)).toBe(true)
    expect(catalog.models.every((model) => model.supports_parallel_tool_calls === true)).toBe(true)
    expect(catalog.models[0].supported_reasoning_levels.map((level) => level.effort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh'
    ])
  })

  it('never injects a preferred model that was not explicitly supplied', () => {
    expect(() => buildModelCatalog([], 'grok-4.5')).toThrow('至少需要一个有效模型名')
    expect(() => buildModelCatalog(['model-a', 'model-b'], 'grok-4.5')).toThrow(
      '不会自动添加未明确输入的模型'
    )
  })

  it('normalizes models URL from a base URL', () => {
    expect(customApiModelsUrl('http://127.0.0.1:18317')).toBe('http://127.0.0.1:18317/v1/models')
    expect(customApiModelsUrl('http://127.0.0.1:18317/v1')).toBe('http://127.0.0.1:18317/v1/models')
    expect(customApiResponsesUrl('http://127.0.0.1:18317/v1')).toBe('http://127.0.0.1:18317/v1/responses')
    expect(customApiChatCompletionsUrl('http://127.0.0.1:18317/v1')).toBe(
      'http://127.0.0.1:18317/v1/chat/completions'
    )
  })

  it('parses OpenAI-compatible /v1/models responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'grok-4.5' }, { id: 'gpt-custom' }, { id: 'grok-4.5' }, { id: '!!bad!!' }, { id: ' spaced ' }]
      })
    })

    const listed = await fetchOpenAiCompatibleModelIds({
      baseUrl: 'http://127.0.0.1:18317/v1',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(listed.models).toEqual(['grok-4.5', 'gpt-custom', 'spaced'])
    expect(listed.baseUrl).toBe('http://127.0.0.1:18317/v1')
    expect(listed.modelsUrl).toBe('http://127.0.0.1:18317/v1/models')
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

  it('falls through common models path suffixes until one works', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 'only-on-openai-v1' }] })
      })

    const listed = await fetchOpenAiCompatibleModelIds({
      baseUrl: 'http://127.0.0.1:18317',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(listed.models).toEqual(['only-on-openai-v1'])
    expect(listed.modelsUrl).toMatch(/\/models$/)
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([
        'http://127.0.0.1:18317/v1/models',
        'http://127.0.0.1:18317/api/v1/models'
      ])
    )
  })

  it('probes the filled model via /v1/responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'resp_1', status: 'completed', output_text: 'hello back' })
    })

    const result = await probeCustomApiModel({
      baseUrl: 'http://127.0.0.1:18317/v1',
      apiKey: 'sk-test',
      model: 'grok-4.5',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(result).toMatchObject({
      endpoint: 'responses',
      baseUrl: 'http://127.0.0.1:18317/v1',
      probeUrl: 'http://127.0.0.1:18317/v1/responses',
      output: 'hello back'
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:18317/v1/responses',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"input":"hi"')
      })
    )
  })

  it('rejects a chat-completions-only provider for direct Codex configuration', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'http://127.0.0.1:18317/openai/v1/chat/completions') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] })
        }
      }
      return { ok: false, status: 404, text: async () => 'not found' }
    })

    await expect(probeCustomApiModel({
      baseUrl: 'http://127.0.0.1:18317',
      apiKey: 'sk-test',
      model: 'gpt-custom',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })).rejects.toThrow('需要有效的 Responses 响应')
    expect(fetchImpl).not.toHaveBeenCalledWith(
      'http://127.0.0.1:18317/openai/v1/chat/completions',
      expect.anything()
    )
  })

  it('accepts pasted full chat completions URLs and still probes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 'resp_1',
        object: 'response',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi!' }] }]
      })
    })

    const result = await probeCustomApiModel({
      baseUrl: 'http://127.0.0.1:18317/v1/chat/completions',
      apiKey: 'sk-test',
      model: 'grok-4.5',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(result.probeUrl).toBe('http://127.0.0.1:18317/v1/responses')
    expect(result.baseUrl).toBe('http://127.0.0.1:18317/v1')
  })

  it('returns empty models when every common /models path fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({})
    })

    const listed = await fetchOpenAiCompatibleModelIds({
      baseUrl: 'http://127.0.0.1:18317',
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(listed.models).toEqual([])
    expect(listed.baseUrl).toBe('http://127.0.0.1:18317/v1')
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(3)
  })

  it('fails model probe when every common path is rejected', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { message: 'invalid api key' } })
    })

    await expect(
      probeCustomApiModel({
        baseUrl: 'http://127.0.0.1:18317/v1',
        apiKey: 'bad',
        model: 'grok-4.5',
        fetchImpl: fetchImpl as unknown as typeof fetch
      })
    ).rejects.toThrow(/invalid api key/)
  })
})
