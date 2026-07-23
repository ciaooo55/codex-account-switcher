import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'

export interface ModelGatewaySlot {
  clientModel: string
  upstreamModel: string
}

const MODEL_SHELL_POOL = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.3-codex-spark',
  'gpt-5.2'
] as const

const SHELL_SET = new Set<string>(MODEL_SHELL_POOL)

function normalizeModels(models: readonly string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const value of models) {
    const model = value.trim()
    if (!model || seen.has(model.toLowerCase())) continue
    seen.add(model.toLowerCase())
    normalized.push(model)
  }
  return normalized
}

/** Matches Coc's policy: keep official names, allocate free official shells, then keep overflow IDs. */
export function allocateModelGatewaySlots(models: readonly string[]): ModelGatewaySlot[] {
  const used = new Set<string>()
  const slots: ModelGatewaySlot[] = []
  const deferred: string[] = []
  for (const upstreamModel of normalizeModels(models)) {
    const key = upstreamModel.toLowerCase()
    if (SHELL_SET.has(key) && !used.has(key)) {
      used.add(key)
      slots.push({ clientModel: upstreamModel, upstreamModel })
    } else {
      deferred.push(upstreamModel)
    }
  }
  for (const upstreamModel of deferred) {
    const shell = MODEL_SHELL_POOL.find((candidate) => !used.has(candidate))
    if (shell) {
      used.add(shell)
      slots.push({ clientModel: shell, upstreamModel })
    } else {
      slots.push({ clientModel: upstreamModel, upstreamModel })
    }
  }
  return slots
}

interface GatewayConfiguration {
  upstreamBaseUrl: string
  upstreamApiKey: string
  token: string
  slots: ModelGatewaySlot[]
}

function gatewayError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ error: { message, type: 'gateway_error' } }))
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > 32 * 1024 * 1024) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function rewriteModel(body: Buffer, slots: readonly ModelGatewaySlot[]): Buffer {
  if (body.length === 0) return body
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown
  } catch {
    return body
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body
  const record = parsed as Record<string, unknown>
  const requestedModel = record.model
  if (typeof requestedModel !== 'string') return body
  const slot = slots.find((entry) => entry.clientModel.toLowerCase() === requestedModel.toLowerCase())
  if (!slot || slot.upstreamModel === requestedModel) return body
  record.model = slot.upstreamModel
  return Buffer.from(JSON.stringify(record))
}

export class CustomApiGateway {
  private server: Server | null = null
  private port: number | null = null
  private configuration: GatewayConfiguration | null = null

  async configure(configuration: GatewayConfiguration): Promise<{ baseUrl: string; token: string }> {
    this.configuration = configuration
    if (!this.server) await this.start()
    return { baseUrl: `http://127.0.0.1:${this.port}/v1`, token: configuration.token }
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    this.port = null
    this.configuration = null
    if (!server) return
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }

  private async start(): Promise<void> {
    this.server = createServer((request, response) => void this.handle(request, response))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => {
        this.server!.off('error', reject)
        const address = this.server!.address()
        if (!address || typeof address === 'string') {
          reject(new Error('本地模型网关未获得监听端口'))
          return
        }
        this.port = address.port
        resolve()
      })
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const configuration = this.configuration
    if (!configuration || !this.port) return gatewayError(response, 503, '本地模型网关尚未配置')
    const authorization = request.headers.authorization?.trim()
    if (authorization !== `Bearer ${configuration.token}`) {
      return gatewayError(response, 401, '本地模型网关认证失败')
    }
    const originalUrl = new URL(request.url ?? '/', `http://127.0.0.1:${this.port}`)
    if (!originalUrl.pathname.startsWith('/v1/')) return gatewayError(response, 404, '仅支持 /v1 路径')
    try {
      const originalBody = await readBody(request)
      const body = rewriteModel(originalBody, configuration.slots)
      const upstream = new URL(configuration.upstreamBaseUrl.replace(/\/+$/, '') + originalUrl.pathname.slice(3))
      upstream.search = originalUrl.search
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) {
        if (!value || ['host', 'content-length', 'authorization', 'connection'].includes(name.toLowerCase())) continue
        headers.set(name, Array.isArray(value) ? value.join(', ') : value)
      }
      headers.set('authorization', `Bearer ${configuration.upstreamApiKey}`)
      const upstreamResponse = await fetch(upstream, {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method ?? '') ? undefined : body,
        // Node's fetch requires duplex whenever a request body is supplied.
        duplex: 'half'
      } as RequestInit & { duplex: 'half' })
      const responseHeaders: Record<string, string> = {}
      upstreamResponse.headers.forEach((value, name) => {
        // Undici may transparently decode upstream bodies. Do not pass through
        // encoding/length headers that no longer describe the piped response.
        if (!['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding'].includes(name.toLowerCase())) {
          responseHeaders[name] = value
        }
      })
      response.writeHead(upstreamResponse.status, responseHeaders)
      if (!upstreamResponse.body) {
        response.end()
        return
      }
      Readable.fromWeb(upstreamResponse.body as import('node:stream/web').ReadableStream)
        .on('error', () => response.destroy())
        .pipe(response)
    } catch (error) {
      gatewayError(response, 502, error instanceof Error ? `上游转发失败：${error.message}` : '上游转发失败')
    }
  }
}
