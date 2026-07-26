import { createServer, type RequestListener, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import type { LocalApiServerRuntimeConfig } from '../../shared/api-server'
import { generateLocalApiAccessKey, LocalApiServer } from './local-api-server'

const cleanup: Array<() => Promise<unknown>> = []

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

async function reservePort(): Promise<number> {
  // WHATWG Fetch intentionally blocks a small set of historically unsafe
  // ports (for example 6667). Avoid a rare, unrelated test flake when the OS
  // happens to hand one to us.
  const forbidden = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 69, 79, 110, 111, 113, 119, 135, 139, 143, 389, 465, 512, 513, 514, 587, 636, 993, 995, 2049, 3659, 4045, 6000, 6665, 6666, 6667, 6668, 6669, 6697])
  while (true) {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = (server.address() as AddressInfo).port
    await closeServer(server)
    if (!forbidden.has(port)) return port
  }
}

async function mockUpstream(
  handler: RequestListener
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanup.push(() => closeServer(server))
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` }
}

async function mockWebsocketUpstream(
  onConnection: (socket: WebSocket, request: import('node:http').IncomingMessage) => void
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer()
  const websocketServer = new WebSocketServer({ server, path: '/v1/responses' })
  websocketServer.on('connection', onConnection)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  cleanup.push(async () => {
    for (const client of websocketServer.clients) client.terminate()
    await new Promise<void>((resolve) => websocketServer.close(() => resolve()))
    await closeServer(server)
  })
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` }
}

async function openedWebsocket(url: string, apiKey?: string): Promise<WebSocket> {
  const socket = new WebSocket(url, apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : undefined)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return socket
}

function config(
  port: number,
  upstreams: LocalApiServerRuntimeConfig['upstreams'],
  strategy: 'single' | 'priority' | 'round_robin' = 'priority'
): LocalApiServerRuntimeConfig {
  return {
    port,
    autoStart: false,
    accessKeys: [
      { id: 'full', label: 'Full', key: 'sk-local', enabled: true, allowedModels: [], allowedSourceIds: [] },
      { id: 'limited', label: 'Limited', key: 'sk-limited', enabled: true, allowedModels: ['xxx'], allowedSourceIds: [] }
    ],
    upstreams,
    credentialSources: [],
    routes: [
      {
        publicModel: 'xxx',
        strategy,
        sourceMode: 'api_only',
        targets: upstreams.map((upstream, index) => ({
          sourceId: upstream.id,
          upstreamModel: `real-${index + 1}`,
          priority: index + 1,
          enabled: true
        }))
      },
      {
        publicModel: 'other',
        strategy: 'single',
        sourceMode: 'api_only',
        targets: upstreams.slice(0, 1).map((upstream) => ({
          sourceId: upstream.id,
          upstreamModel: 'other-real',
          priority: 1,
          enabled: true
        }))
      }
    ]
  }
}

function upstream(
  id: string,
  baseUrl: string,
  protocol: LocalApiServerRuntimeConfig['upstreams'][number]['protocol'] = 'auto'
) {
  return {
    id,
    name: id,
    baseUrl,
    apiKey: `sk-${id}`,
    protocol,
    authMode: 'auto' as const,
    authHeaderName: '',
    authHeaderPrefix: '',
    authQueryParam: 'api_key',
    models: ['real-1', 'real-2', 'other-real'],
    priority: 1,
    enabled: true
  }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).reverse().map((operation) => operation()))
})

describe('LocalApiServer', () => {
  it('generates strong sk-cas access keys', () => {
    const first = generateLocalApiAccessKey()
    const second = generateLocalApiAccessKey()
    expect(first).toMatch(/^sk-cas-[A-Za-z0-9_-]{32}$/)
    expect(second).not.toBe(first)
  })

  it('authenticates Bearer and x-api-key clients and filters /v1/models by key', async () => {
    const port = await reservePort()
    const service = new LocalApiServer(config(port, []))
    cleanup.push(() => service.stop())
    const status = await service.start()

    expect(status).toMatchObject({ running: true, host: '127.0.0.1', port, pid: process.pid, error: null })
    expect(status.startedAt).toEqual(expect.any(String))
    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/models`)
    expect(unauthorized.status).toBe(401)
    await expect(unauthorized.json()).resolves.toMatchObject({ error: { code: 'invalid_api_key' } })

    const models = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { 'x-api-key': 'sk-limited' }
    })
    // A route without any enabled backing source is deliberately not
    // advertised: clients should never be offered a model that must fail.
    await expect(models.json()).resolves.toEqual({ object: 'list', data: [] })

    const health = await fetch(`http://127.0.0.1:${port}/health`)
    await expect(health.json()).resolves.toMatchObject({ status: 'ok', running: true, port })
  })

  it('keeps a secret-free in-memory service activity snapshot', async () => {
    const port = await reservePort()
    const service = new LocalApiServer(config(port, []))
    cleanup.push(() => service.stop())
    await service.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: 'Bearer sk-limited' }
    })
    expect(response.status).toBe(200)
    await response.json()

    const metrics = service.metrics()
    expect(metrics).toMatchObject({ totalRequests: 1, successfulRequests: 1, failedRequests: 0 })
    expect(metrics.recentRequests[0]).toMatchObject({
      endpoint: '/v1/models', accessKeyId: 'limited', sourceId: null, status: 200
    })
    expect(JSON.stringify(metrics)).not.toContain('sk-limited')
  })

  it('extracts upstream token usage and calculates cost only from configured model pricing', async () => {
    const mock = await mockUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'priced', object: 'chat.completion', model: 'real-1',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 500,
          prompt_tokens_details: { cached_tokens: 200 }
        }
      }))
    })
    const port = await reservePort()
    const runtime = config(port, [upstream('first', mock.baseUrl, 'chat_completions')])
    runtime.routes[0].pricing = { inputPerMillion: 10, cachedInputPerMillion: 2, outputPerMillion: 20 }
    const service = new LocalApiServer(runtime)
    cleanup.push(() => service.stop())
    await service.start()

    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', messages: [{ role: 'user', content: 'hello' }] })
    })
    expect(response.status).toBe(200)
    await response.json()
    expect(service.metrics().recentRequests[0]).toMatchObject({
      model: 'xxx', inputTokens: 1000, cachedInputTokens: 200, outputTokens: 500,
      estimatedCostUsd: 0.0184
    })
  })

  it('limits a client key to its selected API source pool', async () => {
    const first = await mockUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'first', object: 'response', status: 'completed', output_text: 'first source' }))
    })
    const second = await mockUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'second', object: 'response', status: 'completed', output_text: 'second source' }))
    })
    const port = await reservePort()
    const runtime = config(port, [upstream('first', first.baseUrl), upstream('second', second.baseUrl)])
    runtime.accessKeys.push({
      id: 'second-only', label: 'Second only', key: 'sk-second-only', enabled: true,
      allowedModels: [], allowedSourceIds: ['second']
    })
    const service = new LocalApiServer(runtime)
    cleanup.push(() => service.stop())
    await service.start()

    const models = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: 'Bearer sk-second-only' }
    })
    await expect(models.json()).resolves.toEqual({
      object: 'list', data: [{ id: 'xxx', object: 'model', created: 0, owned_by: 'local-api-server' }]
    })

    const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-second-only', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', input: 'hello' })
    })
    await expect(response.json()).resolves.toMatchObject({ output_text: 'second source' })
  })

  it('forwards third-party gateway keys through configured custom headers or query parameters', async () => {
    const seen: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> = []
    const mock = await mockUpstream(async (request, response) => {
      seen.push({ url: request.url ?? '', headers: request.headers })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'response-auth', object: 'response', status: 'completed', output_text: 'gateway works'
      }))
    })
    const port = await reservePort()
    const custom = {
      ...upstream('gateway', mock.baseUrl),
      authMode: 'custom' as const,
      authHeaderName: 'x-provider-key',
      authHeaderPrefix: 'Token '
    }
    const service = new LocalApiServer(config(port, [custom]))
    cleanup.push(() => service.stop())
    await service.start()

    const invoke = async (): Promise<Response> => fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', input: 'hi' })
    })
    expect((await invoke()).status).toBe(200)
    expect(seen.at(-1)?.headers['x-provider-key']).toBe('Token sk-gateway')
    expect(seen.at(-1)?.headers.authorization).toBeUndefined()

    await service.updateConfiguration(config(port, [{
      ...upstream('gateway', mock.baseUrl),
      authMode: 'query' as const,
      authHeaderName: '',
      authHeaderPrefix: '',
      authQueryParam: 'token'
    }]))
    expect((await invoke()).status).toBe(200)
    expect(seen.at(-1)?.url).toContain('token=sk-gateway')
    expect(seen.at(-1)?.headers.authorization).toBeUndefined()
  })

  it('exposes the same configured public models through OpenAI, Gemini and Ollama catalogs', async () => {
    const port = await reservePort()
    // Listing is source-aware, so provide one enabled route source without
    // requiring a live upstream request for this catalog-only assertion.
    const service = new LocalApiServer(config(port, [upstream('catalog', 'http://127.0.0.1:9/v1')]))
    cleanup.push(() => service.stop())
    await service.start()
    const headers = { authorization: 'Bearer sk-limited' }

    const [openai, gemini, ollama] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/models`, { headers }),
      fetch(`http://127.0.0.1:${port}/v1beta/models`, { headers }),
      fetch(`http://127.0.0.1:${port}/api/tags`, { headers })
    ])
    await expect(openai.json()).resolves.toMatchObject({ data: [{ id: 'xxx' }] })
    await expect(gemini.json()).resolves.toMatchObject({ models: [{ name: 'models/xxx' }] })
    await expect(ollama.json()).resolves.toMatchObject({ models: [{ name: 'xxx', model: 'xxx' }] })
  })

  it('accepts Anthropic, Gemini and Ollama clients while keeping the public model name private to this service', async () => {
    const seen: Array<{ path: string; body: Record<string, unknown> }> = []
    const mock = await mockUpstream(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      seen.push({ path: request.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'chatcmpl-native', object: 'chat.completion', created: 1, model: 'real-1',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello native' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 }
      }))
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('first', mock.baseUrl, 'chat_completions')]))
    cleanup.push(() => service.stop())
    await service.start()
    const headers = { authorization: 'Bearer sk-local', 'content-type': 'application/json' }

    const anthropic = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'xxx', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] })
    })
    await expect(anthropic.json()).resolves.toMatchObject({
      type: 'message', role: 'assistant', model: 'real-1', content: [{ type: 'text', text: 'hello native' }]
    })

    const gemini = await fetch(`http://127.0.0.1:${port}/v1beta/models/xxx:generateContent`, {
      method: 'POST', headers,
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] })
    })
    await expect(gemini.json()).resolves.toMatchObject({
      candidates: [{ content: { role: 'model', parts: [{ text: 'hello native' }] } }]
    })

    const ollama = await fetch(`http://127.0.0.1:${port}/api/generate`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'xxx', prompt: 'hello', stream: false })
    })
    await expect(ollama.json()).resolves.toMatchObject({ model: 'real-1', response: 'hello native', done: true })
    expect(seen).toEqual([
      expect.objectContaining({ path: '/v1/chat/completions', body: expect.objectContaining({ model: 'real-1', messages: [{ role: 'user', content: 'hello' }] }) }),
      expect.objectContaining({ path: '/v1/chat/completions', body: expect.objectContaining({ model: 'real-1', messages: [{ role: 'user', content: 'hello' }] }) }),
      expect.objectContaining({ path: '/v1/chat/completions', body: expect.objectContaining({ model: 'real-1', messages: [{ role: 'user', content: 'hello' }] }) })
    ])
  })

  it('accepts legacy OpenAI Completions clients and normalizes them through Chat', async () => {
    const seen: Array<{ path: string; body: Record<string, unknown> }> = []
    const mock = await mockUpstream(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      seen.push({ path: request.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'chatcmpl-legacy', object: 'chat.completion', created: 1, model: 'real-1',
        choices: [{ index: 0, message: { role: 'assistant', content: 'legacy works' }, finish_reason: 'stop' }]
      }))
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('first', mock.baseUrl, 'chat_completions')]))
    cleanup.push(() => service.stop())
    await service.start()
    const result = await fetch(`http://127.0.0.1:${port}/v1/completions`, {
      method: 'POST', headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', prompt: 'hello legacy', max_tokens: 32 })
    })
    expect(result.status).toBe(200)
    await expect(result.json()).resolves.toMatchObject({
      object: 'text_completion', choices: [{ text: 'legacy works', finish_reason: 'stop' }]
    })
    expect(seen).toEqual([expect.objectContaining({
      path: '/v1/chat/completions',
      body: expect.objectContaining({ model: 'real-1', messages: [{ role: 'user', content: 'hello legacy' }] })
    })])
  })

  it('uses legacy Completions-only third-party upstreams for public Responses routes', async () => {
    let seen: { path: string; body: Record<string, unknown>; authorization: string | undefined } | null = null
    const mock = await mockUpstream(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      seen = {
        path: request.url ?? '',
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        authorization: request.headers.authorization
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'cmpl-upstream', object: 'text_completion', model: 'real-1',
        choices: [{ index: 0, text: 'from legacy upstream', finish_reason: 'stop' }]
      }))
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('legacy', mock.baseUrl, 'completions')]))
    cleanup.push(() => service.stop())
    await service.start()
    const result = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', input: 'hello' })
    })
    expect(result.status).toBe(200)
    await expect(result.json()).resolves.toMatchObject({
      object: 'response', output: [{ type: 'message', content: [{ type: 'output_text', text: 'from legacy upstream' }] }]
    })
    expect(seen).toEqual(expect.objectContaining({
      path: '/v1/completions', authorization: 'Bearer sk-legacy',
      body: expect.objectContaining({ model: 'real-1', prompt: 'User: hello' })
    }))
  })

  it('relays OpenAI Embeddings through a routed third-party upstream without exposing its key', async () => {
    let seen: { path: string; authorization: string | undefined; body: Record<string, unknown> } | null = null
    const mock = await mockUpstream(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      seen = {
        path: request.url ?? '', authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }], model: 'real-1', usage: { prompt_tokens: 1, total_tokens: 1 } }))
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('embed', mock.baseUrl, 'auto')]))
    cleanup.push(() => service.stop())
    await service.start()
    const result = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
      method: 'POST', headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', input: 'embedding text', dimensions: 2 })
    })
    expect(result.status).toBe(200)
    await expect(result.json()).resolves.toMatchObject({ data: [{ embedding: [0.1, 0.2] }] })
    expect(seen).toEqual(expect.objectContaining({
      path: '/v1/embeddings', authorization: 'Bearer sk-embed',
      body: { model: 'real-1', input: 'embedding text', dimensions: 2 }
    }))
  })

  it('relays OpenAI image generation through the selected third-party model route', async () => {
    let seen: { path: string; authorization: string | undefined; body: Record<string, unknown> } | null = null
    const mock = await mockUpstream(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      seen = {
        path: request.url ?? '',
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ created: 1, data: [{ url: 'https://images.example/generated.png' }] }))
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('image', mock.baseUrl, 'auto')]))
    cleanup.push(() => service.stop())
    await service.start()

    const result = await fetch(`http://127.0.0.1:${port}/v1/images/generations`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', prompt: 'a local API service dashboard', size: '1024x1024' })
    })

    expect(result.status).toBe(200)
    await expect(result.json()).resolves.toEqual({ created: 1, data: [{ url: 'https://images.example/generated.png' }] })
    expect(seen).toEqual(expect.objectContaining({
      path: '/v1/images/generations',
      authorization: 'Bearer sk-image',
      body: { model: 'real-1', prompt: 'a local API service dashboard', size: '1024x1024' }
    }))
  })

  it('relays OpenAI audio speech as binary through the selected third-party model route', async () => {
    let seen: { path: string; authorization: string | undefined; body: Record<string, unknown> } | null = null
    const audioBytes = Buffer.from([0x49, 0x44, 0x33, 0x04, 0xff, 0x00, 0x91])
    const mock = await mockUpstream(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      seen = {
        path: request.url ?? '',
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      }
      response.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audioBytes.length })
      response.end(audioBytes)
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('audio-speech', mock.baseUrl, 'auto')]))
    cleanup.push(() => service.stop())
    await service.start()

    const result = await fetch(`http://127.0.0.1:${port}/v1/audio/speech`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', input: 'hello', voice: 'alloy', response_format: 'mp3' })
    })

    expect(result.status).toBe(200)
    expect(result.headers.get('content-type')).toContain('audio/mpeg')
    expect(Buffer.from(await result.arrayBuffer())).toEqual(audioBytes)
    expect(seen).toEqual(expect.objectContaining({
      path: '/v1/audio/speech',
      authorization: 'Bearer sk-audio-speech',
      body: { model: 'real-1', input: 'hello', voice: 'alloy', response_format: 'mp3' }
    }))
  })

  it.each(['/v1/audio/transcriptions', '/v1/audio/translations'] as const)(
    'relays multipart %s without corrupting audio bytes',
    async (endpoint) => {
      let seen: { path: string; authorization: string | undefined; body: Buffer } | null = null
      const mock = await mockUpstream(async (request, response) => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        seen = { path: request.url ?? '', authorization: request.headers.authorization, body: Buffer.concat(chunks) }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ text: 'transcribed locally' }))
      })
      const port = await reservePort()
      const service = new LocalApiServer(config(port, [upstream('audio-upload', mock.baseUrl, 'auto')]))
      cleanup.push(() => service.stop())
      await service.start()

      const boundary = '----codex-switcher-audio-boundary'
      const audioBytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x11])
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nxxx\r\n`, 'utf8'),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.wav"\r\nContent-Type: audio/wav\r\n\r\n`, 'utf8'),
        audioBytes,
        Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
      ])
      const result = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
        method: 'POST',
        headers: { authorization: 'Bearer sk-local', 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: new Uint8Array(body)
      })

      expect(result.status).toBe(200)
      await expect(result.json()).resolves.toEqual({ text: 'transcribed locally' })
      expect(seen).toEqual(expect.objectContaining({ path: endpoint, authorization: 'Bearer sk-audio-upload' }))
      const uploaded = seen as unknown as { body: Buffer }
      expect(uploaded.body.includes(Buffer.from('\r\nreal-1\r\n'))).toBe(true)
      expect(uploaded.body.includes(audioBytes)).toBe(true)
      expect(uploaded.body.includes(Buffer.from('sk-local'))).toBe(false)
    }
  )

  it.each([
    '/v1/videos',
    '/v1/videos/generations',
    '/v1/videos/edits',
    '/v1/videos/extensions'
  ] as const)('relays %s through the selected third-party model route', async (endpoint) => {
    let seen: { path: string; authorization: string | undefined; body: Record<string, unknown> } | null = null
    const mock = await mockUpstream(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      seen = {
        path: request.url ?? '',
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'video_e2e', model: 'real-1', status: 'queued' }))
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('video', mock.baseUrl, 'auto')]))
    cleanup.push(() => service.stop())
    await service.start()

    const result = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', prompt: 'animate a local API service dashboard', seconds: 4 })
    })

    expect(result.status).toBe(200)
    await expect(result.json()).resolves.toEqual({ id: 'video_e2e', model: 'real-1', status: 'queued' })
    expect(seen).toEqual(expect.objectContaining({
      path: endpoint,
      authorization: 'Bearer sk-video',
      body: { model: 'real-1', prompt: 'animate a local API service dashboard', seconds: 4 }
    }))
  })

  it('keeps a video upstream affinity for retrieval and binary content requests', async () => {
    const calls: Array<{ path: string; authorization: string | undefined; body: string }> = []
    const mock = await mockUpstream(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const path = request.url ?? ''
      calls.push({ path, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString('utf8') })
      if (path === '/v1/videos/generations') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'video_local_123', model: 'real-1', status: 'queued' }))
        return
      }
      if (path === '/v1/videos/video_local_123') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'video_local_123', model: 'real-1', status: 'completed' }))
        return
      }
      if (path === '/v1/videos/video_local_123/content') {
        const bytes = Buffer.from([0, 1, 2, 3, 4, 255])
        response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': bytes.length })
        response.end(bytes)
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'unexpected upstream path' } }))
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('video-cache', mock.baseUrl, 'auto')]))
    cleanup.push(() => service.stop())
    await service.start()

    const headers = { authorization: 'Bearer sk-local', 'content-type': 'application/json' }
    const create = await fetch(`http://127.0.0.1:${port}/v1/videos/generations`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'xxx', prompt: 'create a clip' })
    })
    expect(create.status).toBe(200)
    const status = await fetch(`http://127.0.0.1:${port}/v1/videos/video_local_123`, {
      headers: { authorization: 'Bearer sk-local' }
    })
    expect(status.status).toBe(200)
    await expect(status.json()).resolves.toMatchObject({ id: 'video_local_123', status: 'completed' })
    const content = await fetch(`http://127.0.0.1:${port}/v1/videos/video_local_123/content`, {
      headers: { authorization: 'Bearer sk-local' }
    })
    expect(content.headers.get('content-type')).toContain('video/mp4')
    expect(Buffer.from(await content.arrayBuffer())).toEqual(Buffer.from([0, 1, 2, 3, 4, 255]))
    expect(calls).toEqual([
      expect.objectContaining({ path: '/v1/videos/generations', authorization: 'Bearer sk-video-cache', body: JSON.stringify({ model: 'real-1', prompt: 'create a clip' }) }),
      expect.objectContaining({ path: '/v1/videos/video_local_123', authorization: 'Bearer sk-video-cache', body: '' }),
      expect.objectContaining({ path: '/v1/videos/video_local_123/content', authorization: 'Bearer sk-video-cache', body: '' })
    ])
  })

  it('relays multipart OpenAI video creation without re-encoding binary media', async () => {
    let seen: { path: string; authorization: string | undefined; body: Buffer } | null = null
    const mock = await mockUpstream(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      seen = { path: request.url ?? '', authorization: request.headers.authorization, body: Buffer.concat(chunks) }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'video_multipart_1', status: 'queued' }))
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('video-multipart', mock.baseUrl, 'auto')]))
    cleanup.push(() => service.stop())
    await service.start()

    const boundary = '----codex-switcher-video-boundary'
    const sourceBytes = Buffer.from([0, 255, 1, 2, 3])
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nxxx\r\n`, 'utf8'),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nmake a clip\r\n`, 'utf8'),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="input_reference"; filename="source.mp4"\r\nContent-Type: video/mp4\r\n\r\n`, 'utf8'),
      sourceBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    ])
    const result = await fetch(`http://127.0.0.1:${port}/v1/videos`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: new Uint8Array(body)
    })

    expect(result.status).toBe(200)
    expect(seen).toEqual(expect.objectContaining({ path: '/v1/videos', authorization: 'Bearer sk-video-multipart' }))
    const multipartSeen = seen as unknown as { body: Buffer }
    expect(multipartSeen.body.includes(Buffer.from('\r\nreal-1\r\n'))).toBe(true)
    expect(multipartSeen.body.includes(sourceBytes)).toBe(true)
  })

  it('relays OpenAI image edits without corrupting multipart image bytes or leaking the client key', async () => {
    type SeenImageEdit = { path: string; authorization: string | undefined; contentType: string | undefined; body: Buffer }
    const seen: SeenImageEdit[] = []
    const mock = await mockUpstream(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      seen.push({
        path: request.url ?? '',
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks)
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ created: 1, data: [{ b64_json: 'image-data' }] }))
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('image-edit', mock.baseUrl, 'auto')]))
    cleanup.push(() => service.stop())
    await service.start()

    const boundary = '----codex-switcher-image-boundary'
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a, 0x42])
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nxxx\r\n`, 'utf8'),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nrestore this image\r\n`, 'utf8'),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="input.png"\r\nContent-Type: image/png\r\n\r\n`, 'utf8'),
      imageBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    ])

    const result = await fetch(`http://127.0.0.1:${port}/v1/images/edits`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-local',
        'content-type': `multipart/form-data; boundary=${boundary}`
      },
      body: new Uint8Array(multipart)
    })

    expect(result.status).toBe(200)
    await expect(result.json()).resolves.toEqual({ created: 1, data: [{ b64_json: 'image-data' }] })
    const expectedBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nreal-1\r\n`, 'utf8'),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nrestore this image\r\n`, 'utf8'),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="input.png"\r\nContent-Type: image/png\r\n\r\n`, 'utf8'),
      imageBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
    ])
    expect(seen).toEqual([expect.objectContaining({
      path: '/v1/images/edits',
      authorization: 'Bearer sk-image-edit',
      contentType: `multipart/form-data; boundary=${boundary}`
    })])
    const multipartSeen = seen[0]!
    expect(multipartSeen.body.equals(expectedBody)).toBe(true)
    expect(multipartSeen.body.includes(Buffer.from('sk-local'))).toBe(false)
  })

  it('returns an OpenAI error when an image edit is not multipart or has no model field', async () => {
    const port = await reservePort()
    const service = new LocalApiServer(config(port, []))
    cleanup.push(() => service.stop())
    await service.start()

    const nonMultipart = await fetch(`http://127.0.0.1:${port}/v1/images/edits`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx' })
    })
    expect(nonMultipart.status).toBe(415)
    await expect(nonMultipart.json()).resolves.toMatchObject({ error: { code: 'unsupported_media_type' } })

    const boundary = '----codex-switcher-missing-model'
    const missingModel = await fetch(`http://127.0.0.1:${port}/v1/images/edits`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer sk-local',
        'content-type': `multipart/form-data; boundary=${boundary}`
      },
      body: `--${boundary}\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nno model\r\n--${boundary}--\r\n`
    })
    expect(missingModel.status).toBe(400)
    await expect(missingModel.json()).resolves.toMatchObject({ error: { code: 'missing_model' } })
  })

  it('returns legacy Completion SSE while its selected upstream streams Chat chunks', async () => {
    const mock = await mockUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'chat-stream', model: 'real-1', choices: [{ index: 0, delta: { role: 'assistant', content: 'hel' }, finish_reason: null }] })}\n\n`)
      response.end(`data: ${JSON.stringify({ id: 'chat-stream', model: 'real-1', choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }] })}\n\n`)
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('first', mock.baseUrl, 'chat_completions')]))
    cleanup.push(() => service.stop())
    await service.start()
    const result = await fetch(`http://127.0.0.1:${port}/v1/completions`, {
      method: 'POST', headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', prompt: 'stream it', stream: true })
    })
    expect(result.headers.get('content-type')).toContain('text/event-stream')
    const text = await result.text()
    expect(text).toContain('"object":"text_completion"')
    expect(text).toContain('"text":"hel"')
    expect(text).toContain('"text":"lo"')
    expect(text).toContain('data: [DONE]')
  })

  it('accepts Gemini Interactions clients and routes them through the public model', async () => {
    const seen: Array<{ path: string; body: Record<string, unknown> }> = []
    const mock = await mockUpstream(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      seen.push({ path: request.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'chatcmpl-interactions', object: 'chat.completion', model: 'real-1',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello interactions' }, finish_reason: 'stop' }]
      }))
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('first', mock.baseUrl, 'chat_completions')]))
    cleanup.push(() => service.stop())
    await service.start()
    const result = await fetch(`http://127.0.0.1:${port}/v1beta/interactions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', input: [{ type: 'user_input', content: [{ type: 'text', text: 'hi' }] }] })
    })
    expect(result.status).toBe(200)
    await expect(result.json()).resolves.toMatchObject({
      object: 'interaction', model: 'real-1', status: 'completed',
      steps: [{ type: 'model_output', content: [{ type: 'text', text: 'hello interactions' }] }]
    })
    expect(seen).toEqual([expect.objectContaining({
      path: '/v1/chat/completions',
      body: expect.objectContaining({ model: 'real-1', messages: [{ role: 'user', content: 'hi' }] })
    })])
  })

  it('uses a Gemini Interactions upstream with x-goog-api-key and its real model name', async () => {
    let seen: { path: string; key: string | undefined; body: Record<string, unknown> } | null = null
    const mock = await mockUpstream(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      seen = {
        path: request.url ?? '', key: Array.isArray(request.headers['x-goog-api-key']) ? request.headers['x-goog-api-key'][0] : request.headers['x-goog-api-key'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'interaction_upstream', model: 'real-1', status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'from interactions' }] }]
      }))
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('gemini', mock.baseUrl, 'gemini_interactions')]))
    cleanup.push(() => service.stop())
    await service.start()
    const result = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST', headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', input: 'hi' })
    })
    expect(result.status).toBe(200)
    await expect(result.json()).resolves.toMatchObject({
      object: 'response', output: [{ type: 'message', content: [{ type: 'output_text', text: 'from interactions' }] }]
    })
    expect(seen).toEqual(expect.objectContaining({
      path: '/v1beta/interactions', key: 'sk-gemini',
      body: expect.objectContaining({ model: 'real-1', input: [{ type: 'user_input', content: [{ type: 'text', text: 'hi' }] }] })
    }))
  })

  it('uses native Anthropic upstreams without leaking its upstream API key to callers', async () => {
    let seen: { path: string; apiKey: string | undefined; body: Record<string, unknown> } | null = null
    const mock = await mockUpstream(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      seen = {
        path: request.url ?? '', apiKey: Array.isArray(request.headers['x-api-key']) ? request.headers['x-api-key'][0] : request.headers['x-api-key'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'msg_upstream', type: 'message', model: 'real-1', stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'from anthropic' }], usage: { input_tokens: 1, output_tokens: 2 }
      }))
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('native', mock.baseUrl, 'anthropic_messages')]))
    cleanup.push(() => service.stop())
    await service.start()
    const result = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', input: 'hello' })
    })
    expect(result.status).toBe(200)
    await expect(result.json()).resolves.toMatchObject({
      object: 'response', output: [{ type: 'message', content: [{ type: 'output_text', text: 'from anthropic' }] }]
    })
    expect(seen).toEqual(expect.objectContaining({
      path: '/v1/messages', apiKey: 'sk-native',
      body: expect.objectContaining({ model: 'real-1', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })
    }))
  })

  it('forwards to a no-auth Ollama upstream without inventing a Bearer key', async () => {
    let authorization: string | undefined
    const mock = await mockUpstream(async (request, response) => {
      authorization = request.headers.authorization
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ model: 'real-1', message: { role: 'assistant', content: 'local works' }, done: true }))
    })
    const port = await reservePort()
    const noAuth = upstream('ollama', mock.baseUrl, 'ollama')
    noAuth.apiKey = ''
    const service = new LocalApiServer(config(port, [noAuth]))
    cleanup.push(() => service.stop())
    await service.start()
    const result = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', messages: [{ role: 'user', content: 'hi' }] })
    })
    await expect(result.json()).resolves.toMatchObject({ choices: [{ message: { content: 'local works' } }] })
    expect(authorization).toBeUndefined()
  })

  it('converts Chat SSE into native Anthropic, Gemini and Ollama streams without opening a second local port', async () => {
    const mock = await mockUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-sse', model: 'real-1', choices: [{ index: 0, delta: { role: 'assistant', content: 'hel' }, finish_reason: null }] })}\n\n`)
      response.end(`data: ${JSON.stringify({ id: 'chatcmpl-sse', model: 'real-1', choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('first', mock.baseUrl, 'chat_completions')]))
    cleanup.push(() => service.stop())
    await service.start()
    const headers = { authorization: 'Bearer sk-local', 'content-type': 'application/json' }

    const anthro = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'xxx', max_tokens: 20, stream: true, messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(anthro.headers.get('content-type')).toContain('text/event-stream')
    await expect(anthro.text()).resolves.toContain('event: content_block_delta')

    const gemini = await fetch(`http://127.0.0.1:${port}/v1beta/models/xxx:streamGenerateContent`, {
      method: 'POST', headers,
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] })
    })
    expect(gemini.headers.get('content-type')).toContain('text/event-stream')
    await expect(gemini.text()).resolves.toContain('"text":"hel"')

    const ollama = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'xxx', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    })
    expect(ollama.headers.get('content-type')).toContain('application/x-ndjson')
    await expect(ollama.text()).resolves.toContain('"content":"hel"')
  })

  it('rewrites the public model and forwards to a /v1 base without duplicating the path', async () => {
    let observed: { path?: string; authorization?: string; body?: unknown } = {}
    const mock = await mockUpstream(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      observed = {
        path: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'response-1', object: 'response' }))
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('first', mock.baseUrl)]))
    cleanup.push(() => service.stop())
    await service.start()

    const result = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', input: 'hello' })
    })

    expect(result.status).toBe(200)
    await expect(result.json()).resolves.toMatchObject({ id: 'response-1' })
    expect(observed).toEqual({
      path: '/v1/responses',
      authorization: 'Bearer sk-first',
      body: { model: 'real-1', input: 'hello' }
    })
  })

  it('falls back from an incompatible Responses endpoint to translated Chat Completions', async () => {
    const observedPaths: string[] = []
    let translatedBody: Record<string, unknown> | null = null
    const mock = await mockUpstream(async (request, response) => {
      observedPaths.push(request.url ?? '')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      if (request.url === '/v1/responses') {
        response.writeHead(422, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'unsupported Responses shape' } }))
        return
      }
      translatedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'chatcmpl-fallback',
        object: 'chat.completion',
        created: 1,
        model: 'real-1',
        choices: [{ index: 0, message: { role: 'assistant', content: 'translated' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
      }))
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('first', mock.baseUrl, 'auto')]))
    cleanup.push(() => service.stop())
    await service.start()

    const result = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', input: 'hello' })
    })

    expect(result.status).toBe(200)
    await expect(result.json()).resolves.toMatchObject({
      id: 'chatcmpl-fallback',
      object: 'response',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'translated' }] }],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }
    })
    expect(observedPaths).toEqual(['/v1/responses', '/v1/chat/completions'])
    expect(translatedBody).toMatchObject({
      model: 'real-1',
      messages: [{ role: 'user', content: 'hello' }]
    })
  })

  it('compacts through a Chat-Completions-only upstream into a reusable Responses window', async () => {
    const observed: Array<{ path: string; body: Record<string, unknown> }> = []
    const mock = await mockUpstream(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      observed.push({
        path: request.url ?? '',
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'chatcmpl-compact', object: 'chat.completion', created: 7, model: 'real-1',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'Task: retain the parser decisions and continue the implementation.' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }
      }))
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('first', mock.baseUrl, 'chat_completions')]))
    cleanup.push(() => service.stop())
    await service.start()
    const headers = { authorization: 'Bearer sk-local', 'content-type': 'application/json' }

    const compact = await fetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'xxx',
        instructions: 'Keep the user-facing behavior stable.',
        input: [
          { role: 'user', content: 'Implement compact support.' },
          { role: 'assistant', content: [{ type: 'output_text', text: 'I inspected the gateway.' }] }
        ],
        // Older Codex builds have sent this flag. Compact remains JSON-only.
        stream: true,
        service_tier: 'priority',
        metadata: { conversation_id: 'private-local-test' }
      })
    })

    expect(compact.status).toBe(200)
    expect(compact.headers.get('content-type')).toContain('application/json')
    const compactPayload = await compact.json() as Record<string, unknown>
    expect(compactPayload).toMatchObject({
      id: 'chatcmpl-compact',
      object: 'response.compaction',
      created_at: 7,
      model: 'real-1',
      output: [{
        type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'Task: retain the parser decisions and continue the implementation.' }]
      }],
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 }
    })
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({ path: '/v1/chat/completions' })
    expect(observed[0].body).toMatchObject({
      model: 'real-1', stream: false, max_completion_tokens: 4096,
      messages: [
        { role: 'developer', content: expect.stringContaining('Compact the conversation') },
        { role: 'user', content: 'Implement compact support.' },
        { role: 'assistant', content: 'I inspected the gateway.' }
      ]
    })
    expect(observed[0].body).not.toHaveProperty('service_tier')
    expect(observed[0].body).not.toHaveProperty('metadata')

    // The fallback emits ordinary Responses items instead of a fake encrypted
    // token, so the returned window can be appended to the next local request.
    const resumed = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'xxx',
        input: [
          ...(compactPayload.output as unknown[]),
          { role: 'user', content: 'Continue from that summary.' }
        ]
      })
    })
    expect(resumed.status).toBe(200)
    await resumed.json()
    expect(observed[1]).toMatchObject({
      path: '/v1/chat/completions',
      body: {
        messages: [
          { role: 'assistant', content: 'Task: retain the parser decisions and continue the implementation.' },
          { role: 'user', content: 'Continue from that summary.' }
        ]
      }
    })
  })

  it('uses the Chat compact fallback for auto upstreams only after the native compact path rejects it', async () => {
    const observed: Array<{ path: string; body: Record<string, unknown> }> = []
    const mock = await mockUpstream(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      observed.push({ path: request.url ?? '', body })
      if (request.url === '/v1/responses/compact') {
        response.writeHead(422, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'compact is not implemented' } }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'chatcmpl-auto-compact', object: 'chat.completion', created: 9, model: 'real-1',
        choices: [{ index: 0, message: { role: 'assistant', content: 'A concise handoff.' }, finish_reason: 'stop' }]
      }))
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('first', mock.baseUrl, 'auto')]))
    cleanup.push(() => service.stop())
    await service.start()

    const compact = await fetch(`http://127.0.0.1:${port}/v1/responses/compact`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', input: 'make this compact', stream: true })
    })

    expect(compact.status).toBe(200)
    await expect(compact.json()).resolves.toMatchObject({
      id: 'chatcmpl-auto-compact', object: 'response.compaction',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'A concise handoff.' }] }]
    })
    expect(observed.map((entry) => entry.path)).toEqual([
      '/v1/responses/compact',
      '/v1/chat/completions'
    ])
    expect(observed[0].body).not.toHaveProperty('stream')
    expect(observed[1].body).toMatchObject({
      model: 'real-1', stream: false,
      messages: [
        { role: 'developer', content: expect.stringContaining('Compact the conversation') },
        { role: 'user', content: 'make this compact' }
      ]
    })
  })

  it('translates streaming Chat Completions events into Responses SSE', async () => {
    const mock = await mockUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-stream', created: 1, model: 'real-1',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'hel' }, finish_reason: null }]
      })}\n\n`)
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-stream', created: 1, model: 'real-1',
        choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: 'stop' }]
      })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('first', mock.baseUrl, 'chat_completions')]))
    cleanup.push(() => service.stop())
    await service.start()

    const result = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', input: 'hello', stream: true })
    })
    const text = await result.text()
    expect(result.headers.get('content-type')).toContain('text/event-stream')
    expect(text).toContain('event: response.output_text.delta')
    expect(text).toContain('"delta":"hel"')
    expect(text).toContain('"delta":"lo"')
    expect(text).toContain('event: response.completed')
  })

  it('fails over on 429 before sending a response and returns a standard error if all fail', async () => {
    let firstCalls = 0
    const first = await mockUpstream((_request, response) => {
      firstCalls += 1
      response.writeHead(429, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'quota exhausted' } }))
    })
    const second = await mockUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'fallback' } }] }))
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [
      upstream('first', first.baseUrl, 'chat_completions'),
      upstream('second', second.baseUrl, 'chat_completions')
    ]))
    cleanup.push(() => service.stop())
    await service.start()

    const result = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', messages: [{ role: 'user', content: 'hello' }] })
    })
    expect(result.status).toBe(200)
    await expect(result.json()).resolves.toMatchObject({ choices: [{ message: { content: 'fallback' } }] })
    expect(firstCalls).toBe(1)

    await service.updateConfiguration(config(port, [upstream('first', first.baseUrl, 'chat_completions')]))
    const failed = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', messages: [] })
    })
    expect(failed.status).toBe(429)
    await expect(failed.json()).resolves.toEqual({
      error: {
        message: 'quota exhausted',
        type: 'rate_limit_error',
        param: null,
        code: 'rate_limit_exceeded'
      }
    })
  })

  it('honors the configured maximum number of sources attempted', async () => {
    let secondCalls = 0
    const first = await mockUpstream((_request, response) => {
      response.writeHead(429, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'first exhausted' } }))
    })
    const second = await mockUpstream((_request, response) => {
      secondCalls += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'should not run' } }] }))
    })
    const port = await reservePort()
    const runtime = config(port, [
      upstream('first', first.baseUrl, 'chat_completions'),
      upstream('second', second.baseUrl, 'chat_completions')
    ])
    runtime.maxRetrySources = 1
    const service = new LocalApiServer(runtime)
    cleanup.push(() => service.stop())
    await service.start()

    const result = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', messages: [{ role: 'user', content: 'hello' }] })
    })
    expect(result.status).toBe(429)
    expect(secondCalls).toBe(0)
  })

  it('round-robins requests and transparently relays streaming responses', async () => {
    const first = await mockUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      response.write('data: first-1\n\n')
      response.end('data: first-2\n\n')
    })
    const second = await mockUpstream((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('data: second\n\n')
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [
      upstream('first', first.baseUrl, 'responses'),
      upstream('second', second.baseUrl, 'responses')
    ], 'round_robin'))
    cleanup.push(() => service.stop())
    await service.start()

    const invoke = () => fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', input: 'hello', stream: true })
    })
    const one = await invoke()
    expect(one.headers.get('content-type')).toBe('text/event-stream')
    await expect(one.text()).resolves.toBe('data: first-1\n\ndata: first-2\n\n')
    const two = await invoke()
    await expect(two.text()).resolves.toBe('data: second\n\n')
    const three = await invoke()
    await expect(three.text()).resolves.toContain('first-1')
  })

  it('keeps an identified conversation on the same healthy source while new sessions still round-robin', async () => {
    const calls: string[] = []
    const first = await mockUpstream((_request, response) => {
      calls.push('first')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'first-response', object: 'response', status: 'completed', output: [] }))
    })
    const second = await mockUpstream((_request, response) => {
      calls.push('second')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'second-response', object: 'response', status: 'completed', output: [] }))
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [
      upstream('first', first.baseUrl, 'responses'),
      upstream('second', second.baseUrl, 'responses')
    ], 'round_robin'))
    cleanup.push(() => service.stop())
    await service.start()

    const invoke = (session: string) => fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'xxx', input: 'hello', prompt_cache_key: session })
    })
    expect((await invoke('conversation-a')).status).toBe(200)
    expect((await invoke('conversation-a')).status).toBe(200)
    expect((await invoke('conversation-b')).status).toBe(200)
    expect(calls).toEqual(['first', 'first', 'second'])
  })

  it('routes Responses and translated Chat requests through live credential resolvers', async () => {
    const port = await reservePort()
    const sources: LocalApiServerRuntimeConfig['credentialSources'] = [
      {
        id: 'codex:first', provider: 'codex', credentialId: 'first', label: 'First',
        models: ['real-first'], priority: 1, enabled: true
      },
      {
        id: 'grok:second', provider: 'grok', credentialId: 'second', label: 'Second',
        models: ['real-second'], priority: 2, enabled: true
      }
    ]
    const runtime: LocalApiServerRuntimeConfig = {
      port,
      autoStart: false,
      accessKeys: [{ id: 'full', label: 'Full', key: 'sk-local', enabled: true, allowedModels: [], allowedSourceIds: [] }],
      upstreams: [],
      credentialSources: sources,
      routes: [{
        publicModel: 'credential-model',
        strategy: 'priority',
        sourceMode: 'credential_only',
        targets: sources.map((source, index) => ({
          sourceId: source.id,
          upstreamModel: `real-${index + 1}`,
          priority: index + 1,
          enabled: true
        }))
      }]
    }
    const calls: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = []
    const request: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      calls.push({
        url: String(input),
        authorization: headers.get('authorization'),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>
      })
      if (String(input).endsWith('/first')) {
        return new Response(JSON.stringify({ error: { message: 'secret should not be reflected' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(JSON.stringify({
        id: 'credential-response',
        object: 'response',
        status: 'completed',
        model: 'real-2',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'credential chat' }]
        }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const service = new LocalApiServer(runtime, request, async ({ source, upstreamModel }) => ({
      url: `https://credentials.invalid/${source.credentialId}`,
      headers: { authorization: `Bearer live-${source.credentialId}`, 'content-type': 'application/json' },
      bodyPatch: { store: false },
      // Mirrors a credential secretExtensions.model_mapping alias -> actual model.
      upstreamModel: upstreamModel === 'real-1' ? 'mapped-real-1' : upstreamModel
    }))
    cleanup.push(() => service.stop())
    await service.start()

    const result = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'credential-model', input: 'hello', store: true })
    })
    expect(result.status).toBe(200)
    await expect(result.json()).resolves.toMatchObject({ id: 'credential-response' })
    expect(calls).toEqual([
      {
        url: 'https://credentials.invalid/first',
        authorization: 'Bearer live-first',
        body: { model: 'mapped-real-1', input: 'hello', store: false }
      },
      {
        url: 'https://credentials.invalid/second',
        authorization: 'Bearer live-second',
        body: { model: 'real-2', input: 'hello', store: false }
      }
    ])

    const chat = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'credential-model', messages: [{ role: 'user', content: 'hello' }] })
    })
    expect(chat.status).toBe(200)
    await expect(chat.json()).resolves.toMatchObject({
      object: 'chat.completion',
      choices: [{ message: { content: 'credential chat' } }]
    })
    expect(calls).toHaveLength(3)
    expect(calls[2]).toMatchObject({
      url: 'https://credentials.invalid/second',
      authorization: 'Bearer live-second',
      body: {
        model: 'real-2',
        input: [{ role: 'user', content: 'hello' }],
        store: false
      }
    })
  })

  it('proxies authenticated Responses WebSockets and rewrites the public model', async () => {
    let authorization = ''
    let observed: Record<string, unknown> | null = null
    const mock = await mockWebsocketUpstream((socket, request) => {
      authorization = request.headers.authorization ?? ''
      socket.on('message', (data) => {
        observed = JSON.parse(data.toString()) as Record<string, unknown>
        socket.send(JSON.stringify({ type: 'response.completed', response: { id: 'resp-ws', model: 'real-1' } }))
      })
    })
    const port = await reservePort()
    const service = new LocalApiServer(config(port, [upstream('first', mock.baseUrl, 'responses')]))
    cleanup.push(() => service.stop())
    await service.start()

    const client = await openedWebsocket(`ws://127.0.0.1:${port}/v1/responses`, 'sk-local')
    cleanup.push(async () => client.terminate())
    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      client.once('message', (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>))
      client.once('error', reject)
    })
    client.send(JSON.stringify({
      type: 'response.create',
      response: { model: 'xxx', input: 'hello' }
    }))

    await expect(received).resolves.toMatchObject({ type: 'response.completed', response: { id: 'resp-ws' } })
    expect(authorization).toBe('Bearer sk-first')
    expect(observed).toMatchObject({
      type: 'response.create',
      response: { model: 'real-1', input: 'hello' }
    })
  })

  it('rejects unauthenticated WebSocket upgrades with an OpenAI error', async () => {
    const port = await reservePort()
    const service = new LocalApiServer(config(port, []))
    cleanup.push(() => service.stop())
    await service.start()

    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`)
    const rejected = new Promise<{ status: number; body: string }>((resolve, reject) => {
      client.once('unexpected-response', (_request, response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8')
        }))
      })
      client.once('error', reject)
    })
    const result = await rejected
    expect(result.status).toBe(401)
    expect(JSON.parse(result.body)).toMatchObject({ error: { code: 'invalid_api_key' } })
    client.terminate()
  })

  it('keeps the old listener and never picks a random port when a requested port is occupied', async () => {
    const oldPort = await reservePort()
    const occupiedPort = await reservePort()
    const blocker = createServer((_request, response) => response.end('occupied'))
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(occupiedPort, '127.0.0.1', resolve)
    })
    cleanup.push(() => closeServer(blocker))

    const service = new LocalApiServer(config(oldPort, []))
    cleanup.push(() => service.stop())
    await service.start()

    await expect(service.updateConfiguration(config(occupiedPort, []))).rejects.toThrow(
      `端口 ${occupiedPort} 已被占用`
    )
    expect(service.status()).toMatchObject({ running: true, port: oldPort })
    const oldHealth = await fetch(`http://127.0.0.1:${oldPort}/health`)
    expect(oldHealth.status).toBe(200)
    await expect((await fetch(`http://127.0.0.1:${occupiedPort}`)).text()).resolves.toBe('occupied')
  })
})
