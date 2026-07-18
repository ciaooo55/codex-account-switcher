import type {
  CredentialParseOptions,
  NormalizedCredential,
  RefreshTokenClientMode
} from '../../shared/types'
import { parseCredentialText } from '../accounts/parser'

export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const MOBILE_OAUTH_CLIENT_ID = 'app_LlGpXReQgckcGGUo2JrYvtJK'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const REFRESH_SCOPE = 'openid profile email'
const USER_AGENT = 'codex-cli/0.91.0'

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface RefreshTokenImporterOptions {
  fetchImpl?: FetchImplementation
  tokenUrl?: string
  timeoutMs?: number
  now?: () => Date
}

export interface RefreshTokenImportResolution {
  credentials: NormalizedCredential[]
  errors: string[]
  total: number
}

interface ExchangeSuccess {
  ok: true
  payload: Record<string, unknown>
}

interface ExchangeFailure {
  ok: false
  status: number | null
  detail: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function safeError(payload: unknown, status: number): string {
  const root = asRecord(payload)
  const nested = asRecord(root?.error)
  const detail = [
    stringValue(root?.error),
    stringValue(root?.error_description),
    stringValue(root?.message),
    stringValue(nested?.code),
    stringValue(nested?.message)
  ].filter((value): value is string => Boolean(value)).join(': ')
  return (detail || `HTTP ${status}`)
    .replace(/rt\.[A-Za-z0-9._*-]+/gi, 'rt.[redacted]')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .slice(0, 240)
}

function clientIds(mode: RefreshTokenClientMode): string[] {
  if (mode === 'codex') return [CODEX_OAUTH_CLIENT_ID]
  if (mode === 'mobile') return [MOBILE_OAUTH_CLIENT_ID]
  return [CODEX_OAUTH_CLIENT_ID, MOBILE_OAUTH_CLIENT_ID]
}

function clientLabel(clientId: string): string {
  return clientId === MOBILE_OAUTH_CLIENT_ID ? 'Mobile RT' : 'Codex RT'
}

function isInvalidClient(failure: ExchangeFailure): boolean {
  return /invalid[_ ]client/i.test(failure.detail)
}

export function extractOpenAIRefreshTokens(text: string): string[] {
  const matches = text.match(/rt\.1\.[A-Za-z0-9._*\\-]+/g) ?? []
  return [...new Set(matches
    .map((token) => token.replace(/[\\*]/g, ''))
    .filter((token) => /^rt\.1\.[A-Za-z0-9._-]{16,}$/.test(token)))]
}

export class OpenAIRefreshTokenImporter {
  private readonly fetchImpl: FetchImplementation
  private readonly tokenUrl: string
  private readonly timeoutMs: number
  private readonly now: () => Date

  constructor(options: RefreshTokenImporterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.tokenUrl = options.tokenUrl ?? TOKEN_URL
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.now = options.now ?? (() => new Date())
  }

  async resolve(
    text: string,
    mode: RefreshTokenClientMode,
    source: CredentialParseOptions = { sourcePath: 'pasted-refresh-token.txt', format: 'paste' }
  ): Promise<RefreshTokenImportResolution> {
    const tokens = extractOpenAIRefreshTokens(text)
    const credentials: NormalizedCredential[] = []
    const errors: string[] = []
    const unavailableClients = new Map<string, ExchangeFailure>()

    for (let index = 0; index < tokens.length; index += 1) {
      const refreshToken = tokens[index]
      let failure: ExchangeFailure | null = null
      const attempts: Array<{ clientId: string; failure: ExchangeFailure }> = []
      let resolved = false
      for (const clientId of clientIds(mode)) {
        const exchanged = unavailableClients.get(clientId) ??
          await this.exchange(refreshToken, clientId)
        if (!exchanged.ok) {
          failure = exchanged
          attempts.push({ clientId, failure: exchanged })
          if (isInvalidClient(exchanged)) unavailableClients.set(clientId, exchanged)
          if (exchanged.status === null || exchanged.status >= 500) break
          continue
        }
        const accessToken = stringValue(exchanged.payload.access_token)
        if (!accessToken) {
          failure = { ok: false, status: 200, detail: '刷新响应缺少 access_token' }
          continue
        }
        const checkedAt = this.now()
        const expiresIn = numberValue(exchanged.payload.expires_in)
        const parsed = parseCredentialText(JSON.stringify({
          access_token: accessToken,
          refresh_token: stringValue(exchanged.payload.refresh_token) ?? refreshToken,
          id_token: stringValue(exchanged.payload.id_token),
          client_id: clientId,
          last_refresh: checkedAt.toISOString(),
          ...(expiresIn !== null && expiresIn > 0
            ? { expires_at: new Date(checkedAt.getTime() + expiresIn * 1_000).toISOString() }
            : {})
        }), source).credentials[0]
        if (!parsed) {
          failure = { ok: false, status: 200, detail: '刷新结果无法转换为 Codex 凭据' }
          continue
        }
        credentials.push({ ...parsed, oauthClientId: clientId })
        resolved = true
        break
      }
      if (!resolved) {
        const detail = attempts.length > 1
          ? attempts.map((attempt) =>
              `${clientLabel(attempt.clientId)}：${attempt.failure.detail}`
            ).join('；')
          : failure?.detail ?? 'Refresh Token 验证失败'
        errors.push(`#${index + 1}：${detail}`)
      }
    }

    if (tokens.length === 0) errors.push('没有识别到 OpenAI Refresh Token（应以 rt.1. 开头）')
    return { credentials, errors, total: tokens.length }
  }

  private async exchange(refreshToken: string, clientId: string): Promise<ExchangeSuccess | ExchangeFailure> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          scope: REFRESH_SCOPE
        }),
        signal: controller.signal
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        return { ok: false, status: response.status, detail: safeError(payload, response.status) }
      }
      const record = asRecord(payload)
      return record
        ? { ok: true, payload: record }
        : { ok: false, status: response.status, detail: '刷新接口返回了无效 JSON' }
    } catch (error) {
      return {
        ok: false,
        status: null,
        detail: error instanceof Error && error.name === 'AbortError'
          ? '刷新请求超时'
          : '无法连接 OpenAI OAuth 刷新接口'
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
