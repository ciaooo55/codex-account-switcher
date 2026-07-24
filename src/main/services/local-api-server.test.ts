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
      { id: 'full', label: 'Full', key: 'sk-local', enabled: true, allowedModels: [] },
      { id: 'limited', label: 'Limited', key: 'sk-limited', enabled: true, allowedModels: ['xxx'] }
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
    await expect(models.json()).resolves.toEqual({
      object: 'list',
      data: [{ id: 'xxx', object: 'model', created: 0, owned_by: 'local-api-server' }]
    })

    const health = await fetch(`http://127.0.0.1:${port}/health`)
    await expect(health.json()).resolves.toMatchObject({ status: 'ok', running: true, port })
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
    const service = new LocalApiServer(config(port, []))
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
      accessKeys: [{ id: 'full', label: 'Full', key: 'sk-local', enabled: true, allowedModels: [] }],
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
    const service = new LocalApiServer(runtime, request, async ({ source }) => ({
      url: `https://credentials.invalid/${source.credentialId}`,
      headers: { authorization: `Bearer live-${source.credentialId}`, 'content-type': 'application/json' },
      bodyPatch: { store: false }
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
        body: { model: 'real-1', input: 'hello', store: false }
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
