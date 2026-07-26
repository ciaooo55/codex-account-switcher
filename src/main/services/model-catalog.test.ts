import { describe, expect, it, vi } from 'vitest'
import { isAbsolute, resolve } from 'node:path'
import {
  buildModelCatalog,
  CUSTOM_MODEL_AVAILABLE_IN_PLANS,
  customApiModelsUrl,
  discoverApiUpstream,
  fetchOpenAiCompatibleModelIds,
  modelCatalogConfigPath,
  MODEL_CATALOG_RELATIVE_PATH,
  probeApiUpstreamModel,
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

  it('uses configured custom and query authentication while discovering a gateway catalog', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'custom-gateway-model' }] })
    })

    const custom = await fetchOpenAiCompatibleModelIds({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'secret-key',
      authMode: 'custom',
      authHeaderName: 'x-provider-key',
      authHeaderPrefix: 'Token ',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })
    expect(custom.models).toEqual(['custom-gateway-model'])
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://gateway.example/v1/models',
      expect.objectContaining({ headers: expect.objectContaining({ 'x-provider-key': 'Token secret-key' }) })
    )

    fetchImpl.mockClear()
    await fetchOpenAiCompatibleModelIds({
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'query-secret',
      authMode: 'query',
      authQueryParam: 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://gateway.example/v1/models?token=query-secret',
      expect.objectContaining({ headers: expect.not.objectContaining({ Authorization: expect.anything() }) })
    )
  })

  it('accepts and identifies a chat-completions-only provider for the local API server', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'http://127.0.0.1:18317/v1/chat/completions') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ choices: [{ message: { content: 'chat works' } }] })
        }
      }
      return { ok: false, status: 404, text: async () => 'not found' }
    })

    const result = await probeCustomApiModel({
      baseUrl: 'http://127.0.0.1:18317/v1',
      apiKey: 'sk-test',
      model: 'gpt-custom',
      allowChatCompletions: true,
      fetchImpl: fetchImpl as unknown as typeof fetch
    })

    expect(result).toEqual({
      endpoint: 'chat_completions',
      baseUrl: 'http://127.0.0.1:18317/v1',
      probeUrl: 'http://127.0.0.1:18317/v1/chat/completions',
      output: 'chat works'
    })
  })

  it('automatically detects a Legacy Completions-only provider for the local API server', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://127.0.0.1:18317/v1/completions') {
        expect(init?.body).toContain('"prompt":"hi"')
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ choices: [{ text: 'legacy works' }] })
        }
      }
      return { ok: false, status: 404, text: async () => 'not found' }
    })
    const result = await probeCustomApiModel({
      baseUrl: 'http://127.0.0.1:18317/v1', apiKey: 'sk-test', model: 'legacy-model',
      allowChatCompletions: true, fetchImpl: fetchImpl as unknown as typeof fetch
    })
    expect(result).toEqual({
      endpoint: 'completions', baseUrl: 'http://127.0.0.1:18317/v1',
      probeUrl: 'http://127.0.0.1:18317/v1/completions', output: 'legacy works'
    })
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

  it('discovers and truly probes Gemini and Ollama upstreams without treating them as OpenAI', async () => {
    const geminiFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://gemini.example/v1beta/models') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ models: [{ name: 'models/gemini-test' }] }) }
      }
      if (url.includes(':generateContent')) {
        expect(init?.headers).toMatchObject({ 'x-goog-api-key': 'gem-key' })
        return { ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini works' }] } }] }) }
      }
      return { ok: false, status: 404, text: async () => '{}' }
    })
    const gemini = await discoverApiUpstream({
      baseUrl: 'https://gemini.example/v1', apiKey: 'gem-key', fetchImpl: geminiFetch as unknown as typeof fetch
    })
    expect(gemini).toMatchObject({ protocol: 'gemini', models: ['gemini-test'], baseUrl: 'https://gemini.example' })
    await expect(probeApiUpstreamModel({
      ...gemini, apiKey: 'gem-key', model: 'gemini-test', fetchImpl: geminiFetch as unknown as typeof fetch
    })).resolves.toMatchObject({ output: 'gemini works', probeUrl: 'https://gemini.example/v1beta/models/gemini-test:generateContent' })

    const ollamaFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'http://127.0.0.1:11434/api/tags') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ models: [{ name: 'llama-local' }] }) }
      }
      if (url === 'http://127.0.0.1:11434/api/chat') {
        expect(init?.headers).toMatchObject({ authorization: 'Bearer ollama-key' })
        return { ok: true, status: 200, text: async () => JSON.stringify({ message: { content: 'ollama works' } }) }
      }
      return { ok: false, status: 404, text: async () => '{}' }
    })
    const ollama = await discoverApiUpstream({
      baseUrl: 'http://127.0.0.1:11434', apiKey: 'ollama-key', fetchImpl: ollamaFetch as unknown as typeof fetch
    })
    expect(ollama).toMatchObject({ protocol: 'ollama', models: ['llama-local'], baseUrl: 'http://127.0.0.1:11434' })
    await expect(probeApiUpstreamModel({
      ...ollama, apiKey: 'ollama-key', model: 'llama-local', fetchImpl: ollamaFetch as unknown as typeof fetch
    })).resolves.toMatchObject({ output: 'ollama works', probeUrl: 'http://127.0.0.1:11434/api/chat' })
  })

  it('keeps explicit Gemini Interactions discovery and probes its native endpoint', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://interactions.example/v1beta/models') {
        expect(init?.headers).toMatchObject({ 'x-goog-api-key': 'interaction-key' })
        return { ok: true, status: 200, text: async () => JSON.stringify({ models: [{ name: 'models/gemini-interactions' }] }) }
      }
      if (url === 'https://interactions.example/v1beta/interactions') {
        expect(init?.headers).toMatchObject({ 'x-goog-api-key': 'interaction-key' })
        expect(init?.body).toContain('"model":"gemini-interactions"')
        return { ok: true, status: 200, text: async () => JSON.stringify({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'interaction works' }] }] }) }
      }
      return { ok: false, status: 404, text: async () => '{}' }
    })
    const listed = await discoverApiUpstream({
      baseUrl: 'https://interactions.example/v1', apiKey: 'interaction-key', protocol: 'gemini_interactions',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })
    expect(listed).toMatchObject({ protocol: 'gemini_interactions', models: ['gemini-interactions'], baseUrl: 'https://interactions.example' })
    await expect(probeApiUpstreamModel({
      ...listed, apiKey: 'interaction-key', model: 'gemini-interactions', fetchImpl: fetchImpl as unknown as typeof fetch
    })).resolves.toMatchObject({ output: 'interaction works', probeUrl: 'https://interactions.example/v1beta/interactions' })
  })

  it('preserves explicit Legacy Completions protocol and probes its endpoint', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === 'https://legacy.example/v1/models') {
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer legacy-key' })
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'legacy-model' }] }) }
      }
      if (url === 'https://legacy.example/v1/completions') {
        expect(init?.body).toContain('"prompt":"hi"')
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ text: 'legacy works' }] }) }
      }
      return { ok: false, status: 404, text: async () => '{}' }
    })
    const listed = await discoverApiUpstream({
      baseUrl: 'https://legacy.example/v1', apiKey: 'legacy-key', protocol: 'completions',
      fetchImpl: fetchImpl as unknown as typeof fetch
    })
    expect(listed).toMatchObject({ protocol: 'completions', models: ['legacy-model'] })
    await expect(probeApiUpstreamModel({
      ...listed, apiKey: 'legacy-key', model: 'legacy-model', fetchImpl: fetchImpl as unknown as typeof fetch
    })).resolves.toMatchObject({ output: 'legacy works', probeUrl: 'https://legacy.example/v1/completions' })
  })

  it('persists the protocol proven by an auto probe and never returns a query key in diagnostics', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'https://gateway.example/v1/chat/completions?token=query-secret') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'works' } }] }) }
      }
      return { ok: false, status: 404, text: async () => JSON.stringify({ error: { message: 'missing' } }) }
    })
    const result = await probeApiUpstreamModel({
      protocol: 'auto', baseUrl: 'https://gateway.example/v1', apiKey: 'query-secret',
      authMode: 'query', authQueryParam: 'token', model: 'chat-only', fetchImpl: fetchImpl as unknown as typeof fetch
    })
    expect(result).toMatchObject({ protocol: 'chat_completions', output: 'works' })
    expect(result.probeUrl).toBe('https://gateway.example/v1/chat/completions')
    expect(JSON.stringify(result)).not.toContain('query-secret')
  })

  it('redacts query authentication values from model discovery errors', async () => {
    const listed = await fetchOpenAiCompatibleModelIds({
      baseUrl: 'https://gateway.example/v1', apiKey: 'query-secret', authMode: 'query', authQueryParam: 'token',
      fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }) as unknown as typeof fetch
    })
    expect(listed.errors.join('\n')).not.toContain('query-secret')
    expect(listed.errors.join('\n')).toContain('https://gateway.example/v1/models')
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
