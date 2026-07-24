import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import {
  LOCAL_API_SERVER_HOST,
  apiUpstreamAuthHeaders,
  applyApiUpstreamAuthQuery,
  buildOpenAiUpstreamUrl,
  normalizeLocalApiServerConfig,
  type ApiUpstreamInput,
  type CredentialSourceInput,
  type LocalApiServerRuntimeConfig,
  type LocalApiServerStatus,
  type ModelRoute,
  type ModelRouteTarget
} from '../../shared/api-server'
import {
  translateChatCompletionsRequestToResponses,
  translateChatCompletionsResponseToResponses,
  translateOpenAiSseStream,
  translateResponsesRequestToChatCompletions,
  translateResponsesResponseToChatCompletions,
  type OpenAiProtocolTranslationDirection
} from './openai-protocol-translation'
import {
  clientResponseContentType,
  translateAnthropicRequestToChat,
  translateAnthropicResponseToChat,
  translateAnthropicSseToChat,
  translateChatRequestToAnthropic,
  translateChatRequestToGemini,
  translateChatRequestToInteractions,
  translateChatRequestToOllama,
  translateChatResponseForClient,
  translateChatSseForClient,
  translateGeminiRequestToChat,
  translateGeminiResponseToChat,
  translateGeminiSseToChat,
  translateInteractionsRequestToChat,
  translateInteractionsResponseToChat,
  translateInteractionsSseToChat,
  translateOllamaChatRequestToChat,
  translateOllamaGenerateRequestToChat,
  translateOllamaResponseToChat,
  translateOllamaStreamToChat,
  type NativeClientProtocol,
  type UpstreamResponseProtocol
} from './protocol-compatibility'

const MAX_REQUEST_BYTES = 16 * 1024 * 1024
const RETRYABLE_UPSTREAM_STATUSES = new Set([401, 403, 429])
const PROTOCOL_FALLBACK_STATUSES = new Set([400, 404, 405, 415, 422, 501])

type SupportedEndpoint = '/v1/responses' | '/v1/responses/compact' | '/v1/chat/completions'

interface ApiRequestPlan {
  /** Endpoint to call on the selected upstream (not necessarily OpenAI). */
  endpoint: string
  query?: string
  requestBody: Record<string, unknown>
  responseDirection?: OpenAiProtocolTranslationDirection
  /** Set for native protocol upstreams; response is normalized before relay. */
  responseProtocol?: UpstreamResponseProtocol
}

type FetchLike = typeof fetch

interface ApiRouteCandidate {
  kind: 'api'
  upstream: Required<ApiUpstreamInput>
  target: ModelRouteTarget
}

interface CredentialRouteCandidate {
  kind: 'credential'
  source: CredentialSourceInput
  target: ModelRouteTarget
}

type RouteCandidate = ApiRouteCandidate | CredentialRouteCandidate

export interface CredentialUpstreamResolution {
  url: string
  headers: Record<string, string>
  /** Safe provider-specific body changes, for example forcing store=false. */
  bodyPatch?: Record<string, unknown>
}

export interface CredentialUpstreamResolveRequest {
  source: CredentialSourceInput
  endpoint: '/v1/responses' | '/v1/responses/compact'
}

export type CredentialUpstreamResolver = (
  request: CredentialUpstreamResolveRequest
) => Promise<CredentialUpstreamResolution | null>

function cloneRuntimeConfig(config: LocalApiServerRuntimeConfig): LocalApiServerRuntimeConfig {
  const normalized = normalizeLocalApiServerConfig(config)
  return {
    ...normalized,
    accessKeys: normalized.accessKeys.map((entry) => {
      if (!entry.key) throw new Error(`访问密钥“${entry.label}”缺少密钥内容`)
      return { ...entry, key: entry.key }
    }),
    upstreams: normalized.upstreams.map((entry) => {
      return {
        ...entry,
        apiKey: entry.apiKey ?? '',
        authMode: entry.authMode ?? 'auto',
        authHeaderName: entry.authHeaderName ?? '',
        authHeaderPrefix: entry.authHeaderPrefix ?? '',
        authQueryParam: entry.authQueryParam ?? 'api_key'
      }
    }),
    credentialSources: (normalized.credentialSources ?? []).map((entry) => ({
      ...entry,
      models: [...entry.models]
    })),
    routes: normalized.routes.map((route) => ({
      ...route,
      targets: route.targets.map((target) => ({ ...target }))
    }))
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization?.trim() ?? ''
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim()
  const apiKeyHeader = request.headers['x-api-key']
  const apiKey = (Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader)?.trim()
  return bearer || apiKey || ''
}

function websocketUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  else throw new Error('上游 WebSocket 地址必须使用 HTTP 或 HTTPS')
  return url.toString()
}

function websocketModel(payload: Record<string, unknown>): string {
  if (typeof payload.model === 'string') return payload.model.trim()
  const response = payload.response
  return response && typeof response === 'object' && !Array.isArray(response)
    && typeof (response as Record<string, unknown>).model === 'string'
    ? String((response as Record<string, unknown>).model).trim()
    : ''
}

function rewriteWebsocketModel(
  payload: Record<string, unknown>,
  model: string
): Record<string, unknown> {
  const response = payload.response
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    return { ...payload, response: { ...(response as Record<string, unknown>), model } }
  }
  return { ...payload, model }
}

function sendWebsocketError(
  socket: WebSocket,
  message: string,
  code: string,
  type = 'invalid_request_error'
): void {
  if (socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({ type: 'error', error: { message, type, param: null, code } }))
}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.headersSent || response.writableEnded) return
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  })
  response.end(body)
}

function writeOpenAiError(
  response: ServerResponse,
  status: number,
  message: string,
  code: string,
  type = 'invalid_request_error'
): void {
  writeJson(response, status, { error: { message, type, param: null, code } })
}

function writeClientProtocolError(
  response: ServerResponse,
  protocol: NativeClientProtocol,
  status: number,
  message: string,
  code = 'invalid_request_error'
): void {
  if (protocol === 'anthropic') {
    writeJson(response, status, { type: 'error', error: { type: code, message } })
    return
  }
  if (protocol === 'gemini' || protocol === 'interactions') {
    writeJson(response, status, { error: { code: status, status: status === 404 ? 'NOT_FOUND' : 'INVALID_ARGUMENT', message } })
    return
  }
  if (protocol === 'ollama_chat' || protocol === 'ollama_generate') {
    writeJson(response, status, { error: message })
    return
  }
  writeOpenAiError(response, status, message, code)
}

function roughTokenCount(value: unknown): number {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  // This is intentionally labelled as an estimate. It avoids pretending to
  // know a provider-specific tokenizer while letting SDK preflight calls work.
  return Math.max(1, Math.ceil(serialized.length / 4))
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new Error('request_too_large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function parseUpstreamError(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown }
    if (typeof parsed.error?.message === 'string') return redactUpstreamMessage(parsed.error.message)
    if (typeof parsed.message === 'string') return redactUpstreamMessage(parsed.message)
  } catch {
    // Non-JSON upstream errors are intentionally not reflected verbatim.
  }
  return `上游请求失败（HTTP ${status}）`
}

function redactUpstreamMessage(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|rk|pk|AIza)[-_A-Za-z0-9]{8,}\b/g, '[REDACTED]')
    .slice(0, 1000)
}

function isRetryableStatus(status: number): boolean {
  return RETRYABLE_UPSTREAM_STATUSES.has(status) || status >= 500
}

function endpointSupported(upstream: Required<ApiUpstreamInput>, endpoint: string): boolean {
  if (endpoint === '/v1/responses/compact') {
    return upstream.protocol === 'auto' || upstream.protocol === 'responses'
  }
  return true
}

function translatedPlan(
  endpoint: SupportedEndpoint,
  body: Record<string, unknown>,
  upstreamProtocol: Required<ApiUpstreamInput>['protocol']
): ApiRequestPlan {
  if (endpoint === '/v1/responses/compact') return { endpoint, requestBody: body }
  if (endpoint === '/v1/responses' && upstreamProtocol === 'chat_completions') {
    return {
      endpoint: '/v1/chat/completions',
      requestBody: translateResponsesRequestToChatCompletions(body),
      responseDirection: 'chat_to_responses'
    }
  }
  if (endpoint === '/v1/chat/completions' && upstreamProtocol === 'responses') {
    return {
      endpoint: '/v1/responses',
      requestBody: translateChatCompletionsRequestToResponses(body),
      responseDirection: 'responses_to_chat'
    }
  }
  return { endpoint, requestBody: body }
}

function apiRequestPlans(
  upstream: Required<ApiUpstreamInput>,
  endpoint: SupportedEndpoint,
  body: Record<string, unknown>,
  upstreamModel: string
): ApiRequestPlan[] {
  const chatBody = endpoint === '/v1/chat/completions'
    ? body
    : translateResponsesRequestToChatCompletions(body)
  if (upstream.protocol === 'anthropic_messages') {
    return [{
      endpoint: '/v1/messages',
      requestBody: translateChatRequestToAnthropic(chatBody),
      responseProtocol: 'anthropic_messages'
    }]
  }
  if (upstream.protocol === 'gemini') {
    return [{
      endpoint: `/v1beta/models/${encodeURIComponent(upstreamModel)}:${body.stream === true ? 'streamGenerateContent' : 'generateContent'}`,
      ...(body.stream === true ? { query: 'alt=sse' } : {}),
      requestBody: translateChatRequestToGemini(chatBody),
      responseProtocol: 'gemini'
    }]
  }
  if (upstream.protocol === 'gemini_interactions') {
    return [{
      endpoint: '/v1beta/interactions',
      requestBody: translateChatRequestToInteractions({ ...chatBody, model: upstreamModel }),
      responseProtocol: 'gemini_interactions'
    }]
  }
  if (upstream.protocol === 'ollama') {
    return [{
      endpoint: '/api/chat',
      requestBody: translateChatRequestToOllama(chatBody),
      responseProtocol: 'ollama'
    }]
  }
  if (upstream.protocol !== 'auto' || endpoint === '/v1/responses/compact') {
    return [translatedPlan(endpoint, body, upstream.protocol)]
  }
  const alternate = endpoint === '/v1/responses'
    ? translatedPlan(endpoint, body, 'chat_completions')
    : translatedPlan(endpoint, body, 'responses')
  return [{ endpoint, requestBody: body }, alternate]
}

function responseHeaders(upstream: Response): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of [
    'content-type',
    'content-length',
    'cache-control',
    'openai-processing-ms',
    'request-id',
    'x-request-id'
  ]) {
    const value = upstream.headers.get(name)
    if (value) result[name] = value
  }
  return result
}

/**
 * Build a native-provider URL without retaining an accidentally pasted /v1
 * suffix. OpenAI-compatible paths keep the existing exact-path behaviour;
 * native adapters always start at the provider root (/v1, /v1beta and /api
 * are endpoint families rather than user-controlled base paths).
 */
function buildProviderUpstreamUrl(
  upstream: Required<ApiUpstreamInput>,
  endpoint: string,
  query?: string
): string {
  if (upstream.protocol === 'auto' || upstream.protocol === 'responses' || upstream.protocol === 'chat_completions') {
    const url = new URL(buildOpenAiUpstreamUrl(upstream.baseUrl, endpoint))
    if (query) url.search = query
    return url.toString()
  }
  const url = new URL(upstream.baseUrl)
  const current = url.pathname.replace(/\/+$/, '')
  const root = /(?:^|\/)(?:v1|v1beta|api)$/i.test(current)
    ? current.replace(/\/(?:v1|v1beta|api)$/i, '')
    : current
  url.pathname = `${root}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`.replace(/\/{2,}/g, '/')
  url.search = query ?? ''
  return url.toString()
}

function apiUpstreamHeaders(
  upstream: Required<ApiUpstreamInput>,
  incoming: IncomingMessage
): Record<string, string> {
  const common = {
    'content-type': 'application/json',
    accept: incoming.headers.accept ?? '*/*'
  }
  const auth = apiUpstreamAuthHeaders(upstream)
  if (upstream.protocol === 'anthropic_messages') {
    return {
      ...common,
      ...auth,
      'anthropic-version': '2023-06-01',
      ...(incoming.headers['anthropic-version'] ? { 'anthropic-version': String(incoming.headers['anthropic-version']) } : {})
    }
  }
  if (upstream.protocol === 'gemini' || upstream.protocol === 'gemini_interactions') return { ...common, ...auth }
  return {
    ...common,
    ...auth,
    ...(incoming.headers['openai-beta'] ? { 'openai-beta': String(incoming.headers['openai-beta']) } : {})
  }
}

async function relayResponse(upstream: Response, response: ServerResponse): Promise<void> {
  response.writeHead(upstream.status, responseHeaders(upstream))
  if (!upstream.body) {
    response.end()
    return
  }
  const reader = upstream.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!response.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => response.once('drain', resolve))
      }
    }
    response.end()
  } finally {
    reader.releaseLock()
  }
}

async function relayTranslatedResponse(
  upstream: Response,
  response: ServerResponse,
  direction: OpenAiProtocolTranslationDirection,
  upstreamModel: string
): Promise<void> {
  const contentType = upstream.headers.get('content-type')?.toLowerCase() ?? ''
  if (contentType.includes('text/event-stream')) {
    if (!upstream.body) throw new Error('上游流式响应缺少响应体')
    const headers = responseHeaders(upstream)
    delete headers['content-length']
    headers['content-type'] = 'text/event-stream; charset=utf-8'
    response.writeHead(upstream.status, headers)
    const translated = translateOpenAiSseStream(upstream.body, direction, { model: upstreamModel })
    const reader = translated.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!response.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => response.once('drain', resolve))
        }
      }
      response.end()
    } finally {
      reader.releaseLock()
    }
    return
  }

  const payload = await upstream.json()
  const translated = direction === 'chat_to_responses'
    ? translateChatCompletionsResponseToResponses(payload)
    : translateResponsesResponseToChatCompletions(payload)
  writeJson(response, upstream.status, translated)
}

function nativeResponseToChat(
  payload: unknown,
  protocol: UpstreamResponseProtocol
): Record<string, unknown> {
  if (protocol === 'anthropic_messages') return translateAnthropicResponseToChat(payload)
  if (protocol === 'gemini') return translateGeminiResponseToChat(payload)
  if (protocol === 'gemini_interactions') return translateInteractionsResponseToChat(payload)
  if (protocol === 'ollama') return translateOllamaResponseToChat(payload)
  throw new Error('未知的原生上游响应协议')
}

function nativeStreamToChat(
  stream: ReadableStream<Uint8Array>,
  protocol: UpstreamResponseProtocol
): ReadableStream<Uint8Array> {
  if (protocol === 'anthropic_messages') return translateAnthropicSseToChat(stream)
  if (protocol === 'gemini') return translateGeminiSseToChat(stream)
  if (protocol === 'gemini_interactions') return translateInteractionsSseToChat(stream)
  if (protocol === 'ollama') return translateOllamaStreamToChat(stream)
  throw new Error('未知的原生上游流式协议')
}

async function relayStream(
  stream: ReadableStream<Uint8Array>,
  upstream: Response,
  response: ServerResponse,
  contentType: string
): Promise<void> {
  const headers = responseHeaders(upstream)
  delete headers['content-length']
  headers['content-type'] = contentType
  response.writeHead(upstream.status, headers)
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!response.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => response.once('drain', resolve))
      }
    }
    response.end()
  } finally {
    reader.releaseLock()
  }
}

/**
 * Relay one successful plan. Native upstreams are first normalized to Chat;
 * a native caller is then adapted from that same Chat form. This prevents
 * protocol pair explosions (Anthropic->Gemini, Gemini->Ollama, etc.).
 */
async function relayPlanResponse(
  upstream: Response,
  response: ServerResponse,
  canonicalEndpoint: SupportedEndpoint,
  plan: ApiRequestPlan,
  clientProtocol: NativeClientProtocol,
  upstreamModel: string
): Promise<void> {
  const contentType = upstream.headers.get('content-type')?.toLowerCase() ?? ''
  const streaming = contentType.includes('text/event-stream')
    || (plan.responseProtocol === 'ollama' && contentType.includes('application/x-ndjson'))

  if (clientProtocol === 'openai' && !plan.responseProtocol) {
    if (plan.responseDirection) {
      await relayTranslatedResponse(upstream, response, plan.responseDirection, upstreamModel)
    } else {
      await relayResponse(upstream, response)
    }
    return
  }

  if (streaming) {
    if (!upstream.body) throw new Error('上游流式响应缺少响应体')
    let chatStream: ReadableStream<Uint8Array>
    if (plan.responseProtocol) {
      chatStream = nativeStreamToChat(upstream.body, plan.responseProtocol)
    } else if (plan.responseDirection === 'responses_to_chat') {
      chatStream = translateOpenAiSseStream(upstream.body, 'responses_to_chat', { model: upstreamModel })
    } else if (plan.responseDirection === 'chat_to_responses') {
      // A native client is always normalized through Chat. This branch is
      // defensive for future callers that accidentally pair it with a
      // Responses canonical request.
      chatStream = translateOpenAiSseStream(upstream.body, 'responses_to_chat', { model: upstreamModel })
    } else {
      chatStream = upstream.body
    }

    if (clientProtocol !== 'openai') {
      await relayStream(
        translateChatSseForClient(chatStream, clientProtocol),
        upstream,
        response,
        clientResponseContentType(clientProtocol)
      )
      return
    }
    if (canonicalEndpoint === '/v1/responses') {
      await relayStream(
        translateOpenAiSseStream(chatStream, 'chat_to_responses', { model: upstreamModel }),
        upstream,
        response,
        'text/event-stream; charset=utf-8'
      )
      return
    }
    await relayStream(chatStream, upstream, response, 'text/event-stream; charset=utf-8')
    return
  }

  const payload = await upstream.json()
  let chatPayload: Record<string, unknown>
  if (plan.responseProtocol) {
    chatPayload = nativeResponseToChat(payload, plan.responseProtocol)
  } else if (plan.responseDirection === 'responses_to_chat') {
    chatPayload = translateResponsesResponseToChatCompletions(payload)
  } else if (plan.responseDirection === 'chat_to_responses') {
    chatPayload = translateChatCompletionsResponseToResponses(payload)
  } else {
    chatPayload = payload as Record<string, unknown>
  }

  if (clientProtocol !== 'openai') {
    // All native incoming endpoints call the Chat canonical route. Do not
    // silently fabricate a conversion if a future route violates that rule.
    if (canonicalEndpoint !== '/v1/chat/completions') {
      throw new Error('原生客户端只能通过 Chat 兼容路由转发')
    }
    writeJson(response, upstream.status, translateChatResponseForClient(chatPayload, clientProtocol))
    return
  }
  if (canonicalEndpoint === '/v1/responses' && plan.responseProtocol) {
    writeJson(response, upstream.status, translateChatCompletionsResponseToResponses(chatPayload))
    return
  }
  writeJson(response, upstream.status, chatPayload)
}

export function generateLocalApiAccessKey(): string {
  return `sk-cas-${randomBytes(24).toString('base64url')}`
}

export class LocalApiServer {
  private server: Server | null = null
  private readonly websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_REQUEST_BYTES })
  private config: LocalApiServerRuntimeConfig
  private startedAt: string | null = null
  private lastError: string | null = null
  private readonly roundRobinOffsets = new Map<string, number>()
  private readonly sourceCooldowns = new Map<string, number>()

  constructor(
    initialConfig: LocalApiServerRuntimeConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly resolveCredentialUpstream?: CredentialUpstreamResolver
  ) {
    this.config = cloneRuntimeConfig(initialConfig)
  }

  status(): LocalApiServerStatus {
    return {
      running: Boolean(this.server?.listening),
      host: LOCAL_API_SERVER_HOST,
      port: this.config.port,
      pid: this.server?.listening ? process.pid : null,
      startedAt: this.server?.listening ? this.startedAt : null,
      error: this.lastError
    }
  }

  async start(): Promise<LocalApiServerStatus> {
    if (this.server?.listening) return this.status()
    try {
      const server = await this.listen(this.config.port)
      this.server = server
      this.startedAt = new Date().toISOString()
      this.lastError = null
      return this.status()
    } catch (error) {
      this.lastError = this.describeListenError(error, this.config.port)
      throw new Error(this.lastError)
    }
  }

  async stop(): Promise<LocalApiServerStatus> {
    const server = this.server
    this.server = null
    for (const client of this.websocketServer.clients) client.terminate()
    if (server) await this.closeServer(server)
    this.startedAt = null
    return this.status()
  }

  async restart(): Promise<LocalApiServerStatus> {
    await this.stop()
    return this.start()
  }

  /**
   * Hot-updates routes and secrets. A port change is transactional: the old
   * listener remains alive unless the exact requested port can be bound.
   */
  async updateConfiguration(next: LocalApiServerRuntimeConfig): Promise<LocalApiServerStatus> {
    const normalized = cloneRuntimeConfig(next)
    if (!this.server?.listening || normalized.port === this.config.port) {
      this.config = normalized
      this.roundRobinOffsets.clear()
      this.sourceCooldowns.clear()
      this.lastError = null
      return this.status()
    }

    let replacement: Server
    try {
      replacement = await this.listen(normalized.port)
    } catch (error) {
      this.lastError = this.describeListenError(error, normalized.port)
      throw new Error(this.lastError)
    }

    const previous = this.server
    this.config = normalized
    this.server = replacement
    this.startedAt = new Date().toISOString()
    this.roundRobinOffsets.clear()
    this.sourceCooldowns.clear()
    this.lastError = null
    await this.closeServer(previous)
    return this.status()
  }

  private async listen(port: number): Promise<Server> {
    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error) => {
        if (!response.headersSent) {
          writeOpenAiError(response, 500, '本地 API 服务处理请求失败', 'internal_error', 'server_error')
        } else if (!response.writableEnded) {
          response.destroy(error instanceof Error ? error : undefined)
        }
      })
    })
    server.on('upgrade', (request, socket, head) => {
      void this.handleWebsocketUpgrade(request, socket, head).catch(() => {
        if (!socket.destroyed) socket.destroy()
      })
    })
    server.on('error', (error) => {
      if (server === this.server && server.listening) this.lastError = error.message
    })
    return new Promise<Server>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve(server)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, LOCAL_API_SERVER_HOST)
    })
  }

  private async handleWebsocketUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> {
    const requestUrl = new URL(request.url ?? '/', `http://${LOCAL_API_SERVER_HOST}`)
    if (!['/v1/responses', '/responses', '/backend-api/codex/responses'].includes(requestUrl.pathname)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const key = this.authenticate(request)
    if (!key) {
      const body = JSON.stringify({
        error: {
          message: '缺少或无效的 API Key',
          type: 'authentication_error',
          param: null,
          code: 'invalid_api_key'
        }
      })
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\n'
        + 'Connection: close\r\n'
        + 'Content-Type: application/json; charset=utf-8\r\n'
        + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
      )
      return
    }
    this.websocketServer.handleUpgrade(request, socket, head, (client) => {
      this.websocketServer.emit('connection', client, request)
      this.handleWebsocketClient(client, request, key)
    })
  }

  private handleWebsocketClient(
    client: WebSocket,
    request: IncomingMessage,
    key: LocalApiServerRuntimeConfig['accessKeys'][number]
  ): void {
    let publicModel = ''
    let upstreamPromise: Promise<{ socket: WebSocket; upstreamModel: string }> | null = null

    const closeUpstream = (): void => {
      if (!upstreamPromise) return
      void upstreamPromise.then(({ socket }) => {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1000, '本地客户端已断开')
        }
      }).catch(() => undefined)
    }
    client.once('close', closeUpstream)

    client.on('message', (data: RawData, isBinary: boolean) => {
      void (async () => {
        if (isBinary) {
          sendWebsocketError(client, 'Responses WebSocket 仅接受 JSON 文本帧', 'invalid_websocket_message')
          return
        }
        let payload: Record<string, unknown>
        try {
          const parsed = JSON.parse(data.toString()) as unknown
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
          payload = parsed as Record<string, unknown>
        } catch {
          sendWebsocketError(client, 'WebSocket 消息必须是有效的 JSON 对象', 'invalid_json')
          return
        }

        const requestedModel = websocketModel(payload)
        if (!upstreamPromise) {
          if (!requestedModel) {
            sendWebsocketError(client, '首个 response.create 消息必须提供 model', 'missing_model')
            return
          }
          if (key.allowedModels.length > 0 && !key.allowedModels.includes(requestedModel)) {
            sendWebsocketError(client, `模型“${requestedModel}”不存在或当前密钥无权访问`, 'model_not_found')
            return
          }
          const route = this.config.routes.find((entry) => entry.publicModel === requestedModel)
          if (!route) {
            sendWebsocketError(client, `模型“${requestedModel}”未配置`, 'model_not_found')
            return
          }
          publicModel = requestedModel
          const incompatibleApiIds = new Set(
            this.config.upstreams
              .filter((entry) => entry.protocol !== 'auto' && entry.protocol !== 'responses')
              .map((entry) => entry.id)
          )
          const websocketRoute: ModelRoute = {
            ...route,
            targets: route.targets.filter((target) => !incompatibleApiIds.has(target.sourceId))
          }
          const candidates = this.routeCandidates(websocketRoute, '/v1/responses')
          if (candidates.length === 0) {
            sendWebsocketError(client, `模型“${requestedModel}”没有可用的 Responses WebSocket 上游`, 'no_available_upstream', 'server_error')
            return
          }
          upstreamPromise = this.connectWebsocketUpstream(candidates, request, client)
        } else if (requestedModel && requestedModel !== publicModel) {
          sendWebsocketError(client, '同一 WebSocket 连接不能切换公开模型，请新建连接', 'model_mismatch')
          return
        }

        try {
          const upstream = await upstreamPromise
          if (client.readyState !== WebSocket.OPEN || upstream.socket.readyState !== WebSocket.OPEN) return
          const forwarded = requestedModel
            ? rewriteWebsocketModel(payload, upstream.upstreamModel)
            : payload
          upstream.socket.send(JSON.stringify(forwarded))
        } catch {
          upstreamPromise = null
          sendWebsocketError(client, '无法建立 Responses WebSocket 上游连接', 'upstream_websocket_error', 'server_error')
        }
      })()
    })
  }

  private async connectWebsocketUpstream(
    candidates: RouteCandidate[],
    request: IncomingMessage,
    client: WebSocket
  ): Promise<{ socket: WebSocket; upstreamModel: string }> {
    let lastError: unknown = null
    for (const candidate of candidates) {
      try {
        const credentialResolution = candidate.kind === 'credential'
          ? await this.resolveCredentialUpstream?.({ source: candidate.source, endpoint: '/v1/responses' })
          : null
        if (candidate.kind === 'credential' && !credentialResolution) continue
        const rawUrl = candidate.kind === 'api'
          ? buildOpenAiUpstreamUrl(candidate.upstream.baseUrl, '/v1/responses')
          : credentialResolution!.url
        const url = candidate.kind === 'api'
          ? applyApiUpstreamAuthQuery(rawUrl, candidate.upstream)
          : rawUrl
        const headers = candidate.kind === 'api'
          ? {
              ...apiUpstreamAuthHeaders(candidate.upstream),
              ...(request.headers['openai-beta']
                ? { 'openai-beta': String(request.headers['openai-beta']) }
                : {})
            }
          : credentialResolution!.headers
        const upstream = await this.openWebsocket(websocketUrl(url), headers)
        upstream.on('message', (data: RawData, isBinary: boolean) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
        })
        upstream.once('close', (code, reason) => {
          if (client.readyState !== WebSocket.OPEN) return
          const safeCode = code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006
            ? code
            : 1011
          client.close(safeCode, reason.toString().slice(0, 120))
        })
        upstream.once('error', () => {
          if (client.readyState === WebSocket.OPEN) client.close(1011, '上游 WebSocket 连接错误')
        })
        return { socket: upstream, upstreamModel: candidate.target.upstreamModel }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof Error ? lastError : new Error('没有可用的 WebSocket 上游')
  }

  private async openWebsocket(url: string, headers: Record<string, string>): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url, { headers, handshakeTimeout: 15_000, maxPayload: MAX_REQUEST_BYTES })
      const onOpen = (): void => {
        cleanup()
        resolve(socket)
      }
      const onError = (error: Error): void => {
        cleanup()
        socket.terminate()
        reject(error)
      }
      const onUnexpectedResponse = (_request: IncomingMessage, response: IncomingMessage): void => {
        cleanup()
        response.resume()
        socket.terminate()
        reject(new Error(`WebSocket 上游拒绝连接（HTTP ${response.statusCode ?? 502}）`))
      }
      const cleanup = (): void => {
        socket.off('open', onOpen)
        socket.off('error', onError)
        socket.off('unexpected-response', onUnexpectedResponse)
      }
      socket.once('open', onOpen)
      socket.once('error', onError)
      socket.once('unexpected-response', onUnexpectedResponse)
    })
  }

  private async closeServer(server: Server): Promise<void> {
    if (!server.listening) return
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
      server.closeIdleConnections()
    })
  }

  private describeListenError(error: unknown, port: number): string {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE') return `端口 ${port} 已被占用，API 服务未切换到其他端口`
    if (code === 'EACCES') return `没有权限监听端口 ${port}`
    return error instanceof Error ? error.message : `无法监听端口 ${port}`
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET'
    const requestUrl = new URL(request.url ?? '/', `http://${LOCAL_API_SERVER_HOST}`)

    if (method === 'GET' && requestUrl.pathname === '/health') {
      writeJson(response, 200, { status: 'ok', ...this.status() })
      return
    }

    const key = this.authenticate(request)
    if (!key) {
      response.setHeader('www-authenticate', 'Bearer')
      writeOpenAiError(response, 401, '缺少或无效的 API Key', 'invalid_api_key', 'authentication_error')
      return
    }

    const modelListPaths = new Set(['/v1/models', '/models', '/backend-api/codex/models'])
    if (method === 'GET' && modelListPaths.has(requestUrl.pathname)) {
      const allowed = new Set(key.allowedModels)
      const models = this.config.routes
        .filter((route) => allowed.size === 0 || allowed.has(route.publicModel))
        .map((route) => ({ id: route.publicModel, object: 'model', created: 0, owned_by: 'local-api-server' }))
      writeJson(response, 200, { object: 'list', data: models })
      return
    }

    const availableModels = this.config.routes
      .filter((route) => key.allowedModels.length === 0 || key.allowedModels.includes(route.publicModel))
      .map((route) => route.publicModel)

    if (method === 'GET' && requestUrl.pathname === '/v1beta/models') {
      writeJson(response, 200, {
        models: availableModels.map((name) => ({
          name: `models/${name}`,
          displayName: name,
          supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'interactions', 'countTokens']
        }))
      })
      return
    }

    const geminiModelInfo = /^\/v1beta\/models\/([^/]+)$/i.exec(requestUrl.pathname)
    if (method === 'GET' && geminiModelInfo) {
      const model = decodeURIComponent(geminiModelInfo[1]).replace(/^models\//, '')
      if (!availableModels.includes(model)) {
        writeClientProtocolError(response, 'gemini', 404, `模型“${model}”不存在或当前密钥无权访问`, 'model_not_found')
      } else {
        writeJson(response, 200, {
          name: `models/${model}`,
          displayName: model,
          supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'interactions', 'countTokens']
        })
      }
      return
    }

    if (method === 'GET' && requestUrl.pathname === '/api/tags') {
      writeJson(response, 200, {
        models: availableModels.map((name) => ({ name, model: name, modified_at: '', size: 0, digest: '', details: {} }))
      })
      return
    }

    if (method === 'GET' && requestUrl.pathname === '/api/version') {
      writeJson(response, 200, { version: '0.14.0-local-router' })
      return
    }

    if (method === 'POST' && (requestUrl.pathname === '/v1/messages/count_tokens' || requestUrl.pathname === '/messages/count_tokens')) {
      try {
        const body = JSON.parse((await readRequestBody(request)).toString('utf8')) as Record<string, unknown>
        writeJson(response, 200, { input_tokens: roughTokenCount(body.messages ?? body.input ?? body) })
      } catch {
        writeClientProtocolError(response, 'anthropic', 400, '请求体必须是有效的 JSON 对象')
      }
      return
    }

    const geminiCount = /^\/v1beta\/models\/[^/:]+:countTokens$/i.test(requestUrl.pathname)
    if (method === 'POST' && geminiCount) {
      try {
        const body = JSON.parse((await readRequestBody(request)).toString('utf8')) as Record<string, unknown>
        writeJson(response, 200, { totalTokens: roughTokenCount(body.contents ?? body) })
      } catch {
        writeClientProtocolError(response, 'gemini', 400, '请求体必须是有效的 JSON 对象')
      }
      return
    }

    if (method === 'POST' && requestUrl.pathname === '/api/show') {
      try {
        const body = JSON.parse((await readRequestBody(request)).toString('utf8')) as Record<string, unknown>
        const model = typeof body.model === 'string' ? body.model.trim() : ''
        if (!model || !availableModels.includes(model)) {
          writeClientProtocolError(response, 'ollama_chat', 404, `模型“${model || '未提供'}”不存在或当前密钥无权访问`, 'model_not_found')
        } else {
          writeJson(response, 200, { modelfile: `FROM ${model}`, parameters: '', template: '', details: {}, model_info: {}, capabilities: ['completion', 'tools'] })
        }
      } catch {
        writeClientProtocolError(response, 'ollama_chat', 400, '请求体必须是有效的 JSON 对象')
      }
      return
    }

    if (method === 'POST' && [
      '/v1/alpha/search', '/alpha/search', '/backend-api/codex/alpha/search'
    ].includes(requestUrl.pathname)) {
      // Search needs an account-specific backend contract and has no stable
      // public-model field to route safely. Returning a truthful error is
      // preferable to sending a request through an arbitrary model route.
      writeOpenAiError(response, 501, '当前本地路由只支持模型请求；alpha/search 需要专用上游实现', 'unsupported_endpoint', 'server_error')
      return
    }

    const directEndpoint: SupportedEndpoint | null = requestUrl.pathname === '/v1/responses'
      || requestUrl.pathname === '/responses'
      || requestUrl.pathname === '/backend-api/codex/responses'
      ? '/v1/responses'
      : requestUrl.pathname === '/v1/responses/compact'
        || requestUrl.pathname === '/responses/compact'
        || requestUrl.pathname === '/backend-api/codex/responses/compact'
        ? '/v1/responses/compact'
        : requestUrl.pathname === '/v1/chat/completions' || requestUrl.pathname === '/chat/completions'
          ? '/v1/chat/completions'
          : null
    const anthropicEndpoint = requestUrl.pathname === '/v1/messages' || requestUrl.pathname === '/messages'
    const ollamaChatEndpoint = requestUrl.pathname === '/api/chat'
    const ollamaGenerateEndpoint = requestUrl.pathname === '/api/generate'
    const geminiEndpoint = /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/i.exec(requestUrl.pathname)
    const interactionsEndpoint = requestUrl.pathname === '/v1beta/interactions'
    if (method !== 'POST' || (!directEndpoint && !anthropicEndpoint && !ollamaChatEndpoint && !ollamaGenerateEndpoint && !geminiEndpoint && !interactionsEndpoint)) {
      writeOpenAiError(response, 404, '请求的 API 接口不存在', 'not_found')
      return
    }

    let rawBody: Buffer
    let body: Record<string, unknown>
    try {
      rawBody = await readRequestBody(request)
      body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>
      if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('invalid json object')
    } catch (error) {
      if ((error as Error).message === 'request_too_large') {
        writeOpenAiError(response, 413, '请求体超过 16 MiB 限制', 'request_too_large')
      } else {
        writeOpenAiError(response, 400, '请求体必须是有效的 JSON 对象', 'invalid_json')
      }
      return
    }

    let endpoint: SupportedEndpoint = directEndpoint ?? '/v1/chat/completions'
    let clientProtocol: NativeClientProtocol = 'openai'
    try {
      if (anthropicEndpoint) {
        body = translateAnthropicRequestToChat(body)
        clientProtocol = 'anthropic'
      } else if (geminiEndpoint) {
        body = {
          ...translateGeminiRequestToChat(body, decodeURIComponent(geminiEndpoint[1])),
          stream: geminiEndpoint[2] === 'streamGenerateContent'
        }
        clientProtocol = 'gemini'
      } else if (interactionsEndpoint) {
        body = translateInteractionsRequestToChat(body)
        clientProtocol = 'interactions'
      } else if (ollamaChatEndpoint) {
        body = translateOllamaChatRequestToChat(body)
        clientProtocol = 'ollama_chat'
      } else if (ollamaGenerateEndpoint) {
        body = translateOllamaGenerateRequestToChat(body)
        clientProtocol = 'ollama_generate'
      }
    } catch (error) {
      writeClientProtocolError(
        response,
        anthropicEndpoint ? 'anthropic' : geminiEndpoint ? 'gemini' : interactionsEndpoint ? 'interactions' : ollamaGenerateEndpoint ? 'ollama_generate' : ollamaChatEndpoint ? 'ollama_chat' : 'openai',
        400,
        error instanceof Error ? error.message : '请求格式无效'
      )
      return
    }

    const publicModel = typeof body.model === 'string' ? body.model.trim() : ''
    if (!publicModel) {
      writeClientProtocolError(response, clientProtocol, 400, '必须提供 model', 'missing_model')
      return
    }
    if (key.allowedModels.length > 0 && !key.allowedModels.includes(publicModel)) {
      writeClientProtocolError(response, clientProtocol, 404, `模型“${publicModel}”不存在或当前密钥无权访问`, 'model_not_found')
      return
    }
    const route = this.config.routes.find((entry) => entry.publicModel === publicModel)
    if (!route) {
      writeClientProtocolError(response, clientProtocol, 404, `模型“${publicModel}”未配置`, 'model_not_found')
      return
    }

    const candidates = this.routeCandidates(route, endpoint)
    if (candidates.length === 0) {
      writeClientProtocolError(response, clientProtocol, 503, `模型“${publicModel}”没有可用的兼容上游`, 'no_available_upstream')
      return
    }

    await this.forwardWithFailover(
      request,
      response,
      endpoint,
      body,
      candidates,
      clientProtocol
    )
  }

  private authenticate(request: IncomingMessage): LocalApiServerRuntimeConfig['accessKeys'][number] | null {
    const supplied = bearerToken(request)
    if (!supplied) return null
    return this.config.accessKeys.find((entry) => entry.enabled && constantTimeEqual(entry.key, supplied)) ?? null
  }

  private routeCandidates(route: ModelRoute, endpoint: string): RouteCandidate[] {
    const upstreams = new Map(this.config.upstreams.map((entry) => [entry.id, entry]))
    const credentialSources = new Map(this.config.credentialSources.map((entry) => [entry.id, entry]))
    let candidates = route.targets.flatMap((target): RouteCandidate[] => {
      const upstream = upstreams.get(target.sourceId)
      if (upstream) {
        const cooldownUntil = this.sourceCooldowns.get(upstream.id) ?? 0
        if (cooldownUntil > Date.now()) return []
        if (cooldownUntil) this.sourceCooldowns.delete(upstream.id)
        if (
          route.sourceMode === 'credential_only' ||
          !target.enabled ||
          !upstream.enabled ||
          !endpointSupported(upstream, endpoint)
        ) return []
        return [{ kind: 'api', upstream, target }]
      }
      const source = credentialSources.get(target.sourceId)
      if (
        !source ||
        route.sourceMode === 'api_only' ||
        !target.enabled ||
        !source.enabled
      ) return []
      const cooldownUntil = this.sourceCooldowns.get(source.id) ?? 0
      if (cooldownUntil > Date.now()) return []
      if (cooldownUntil) this.sourceCooldowns.delete(source.id)
      // Grok CLI credentials expose Responses but not the Codex compact API.
      if (endpoint === '/v1/responses/compact' && (source.provider === 'grok' || source.provider === 'cpa-grok')) {
        return []
      }
      return [{ kind: 'credential', source, target }]
    })
    candidates.sort((left, right) =>
      left.target.priority - right.target.priority
      || (left.kind === 'api' ? left.upstream.priority : left.source.priority)
        - (right.kind === 'api' ? right.upstream.priority : right.source.priority)
      || (left.kind === 'api' ? left.upstream.id : left.source.id)
        .localeCompare(right.kind === 'api' ? right.upstream.id : right.source.id)
    )
    if (route.strategy === 'single') return candidates.slice(0, 1)
    if (route.strategy === 'round_robin' && candidates.length > 1) {
      const offset = this.roundRobinOffsets.get(route.publicModel) ?? 0
      this.roundRobinOffsets.set(route.publicModel, (offset + 1) % candidates.length)
      candidates = [...candidates.slice(offset), ...candidates.slice(0, offset)]
    }
    return candidates
  }

  private async forwardWithFailover(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    endpoint: SupportedEndpoint,
    body: Record<string, unknown>,
    candidates: RouteCandidate[],
    clientProtocol: NativeClientProtocol = 'openai'
  ): Promise<void> {
    let lastStatus = 502
    let lastMessage = '所有上游均请求失败'

    for (const [index, candidate] of candidates.entries()) {
      const abortController = new AbortController()
      const onClientClose = (): void => {
        if (!outgoing.writableEnded) abortController.abort()
      }
      outgoing.once('close', onClientClose)
      try {
        const credentialResolution = candidate.kind === 'credential'
          ? await this.resolveCredentialUpstream?.({
              source: candidate.source,
              endpoint: endpoint === '/v1/chat/completions' ? '/v1/responses' : endpoint
            })
          : undefined
        if (candidate.kind === 'credential' && !credentialResolution) {
          lastStatus = 503
          lastMessage = '凭证上游当前不可用或不支持此接口'
          continue
        }
        const upstreamHeaders = candidate.kind === 'api'
          ? apiUpstreamHeaders(candidate.upstream, incoming)
          : credentialResolution!.headers
        const plans: ApiRequestPlan[] = candidate.kind === 'api'
          ? apiRequestPlans(candidate.upstream, endpoint, body, candidate.target.upstreamModel)
          : endpoint === '/v1/chat/completions'
            ? [{
                endpoint: '/v1/responses',
                requestBody: {
                  ...translateChatCompletionsRequestToResponses(body),
                  ...(credentialResolution!.bodyPatch ?? {})
                },
                responseDirection: 'responses_to_chat'
              }]
            : [{
                endpoint,
                requestBody: { ...body, ...(credentialResolution!.bodyPatch ?? {}) }
              }]

        for (const [planIndex, plan] of plans.entries()) {
          const upstreamBody = Buffer.from(JSON.stringify({
            ...plan.requestBody,
            ...(candidate.kind === 'api' && (candidate.upstream.protocol === 'gemini' || candidate.upstream.protocol === 'gemini_interactions')
              ? {}
              : { model: candidate.target.upstreamModel })
          }))
          const rawUpstreamUrl = candidate.kind === 'api'
            ? buildProviderUpstreamUrl(candidate.upstream, plan.endpoint, plan.query)
            : credentialResolution!.url
          const upstreamUrl = candidate.kind === 'api'
            ? applyApiUpstreamAuthQuery(rawUpstreamUrl, candidate.upstream)
            : rawUpstreamUrl
          const upstream = await this.fetchImpl(upstreamUrl, {
            method: 'POST',
            headers: upstreamHeaders,
            body: upstreamBody,
            signal: abortController.signal
          })

          if (upstream.ok) {
            this.sourceCooldowns.delete(
              candidate.kind === 'api' ? candidate.upstream.id : candidate.source.id
            )
            await relayPlanResponse(
              upstream,
              outgoing,
              endpoint,
              plan,
              clientProtocol,
              candidate.target.upstreamModel
            )
            return
          }

          lastStatus = upstream.status
          const errorBody = await upstream.text()
          lastMessage = candidate.kind === 'credential'
            ? `凭证上游请求失败（HTTP ${upstream.status}）`
            : parseUpstreamError(errorBody, upstream.status)
          const hasProtocolFallback = candidate.kind === 'api'
            && planIndex < plans.length - 1
            && PROTOCOL_FALLBACK_STATUSES.has(upstream.status)
          if (hasProtocolFallback) continue
          break
        }
        if (isRetryableStatus(lastStatus)) {
          const duration = lastStatus === 401 || lastStatus === 403
            ? 5 * 60_000
            : lastStatus === 429
              ? 60_000
              : 10_000
          this.sourceCooldowns.set(
            candidate.kind === 'api' ? candidate.upstream.id : candidate.source.id,
            Date.now() + duration
          )
        }
        if (!isRetryableStatus(lastStatus) || index === candidates.length - 1) break
      } catch (error) {
        // Once any successful upstream bytes have reached the client, trying a
        // second target would splice two responses together and may double bill.
        if (outgoing.headersSent) {
          if (!outgoing.writableEnded) outgoing.destroy(error instanceof Error ? error : undefined)
          return
        }
        if (abortController.signal.aborted) return
        lastStatus = 502
        // Resolver/provider exceptions may contain credential material. Never
        // reflect their text to the client or a renderer-visible status.
        lastMessage = candidate.kind === 'credential'
          ? '无法连接凭证上游'
          : error instanceof Error && error.name !== 'TypeError'
            ? error.message.slice(0, 1000)
            : '无法连接上游 API'
        this.sourceCooldowns.set(
          candidate.kind === 'api' ? candidate.upstream.id : candidate.source.id,
          Date.now() + 10_000
        )
        if (index === candidates.length - 1) break
      } finally {
        outgoing.off('close', onClientClose)
      }
    }

    const clientStatus = lastStatus === 401 || lastStatus === 403 || lastStatus === 429
      ? lastStatus
      : 502
    const code = lastStatus === 429 ? 'rate_limit_exceeded' : 'upstream_error'
    const type = lastStatus === 429 ? 'rate_limit_error' : 'server_error'
    writeOpenAiError(outgoing, clientStatus, lastMessage, code, type)
  }
}
