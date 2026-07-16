import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { CredentialParseOptions, NormalizedCredential } from '../../shared/types'
import { parseCredentialText } from '../accounts/parser'
import { CODEX_OAUTH_CLIENT_ID } from './refresh-token-importer'

const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const REDIRECT_URI = 'http://localhost:1455/auth/callback'
const SCOPES = 'openid profile email offline_access'
const USER_AGENT = 'codex-cli/0.91.0'
const SESSION_TTL_MS = 30 * 60 * 1_000

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface OAuthImporterOptions {
  fetchImpl?: FetchImplementation
  tokenUrl?: string
  timeoutMs?: number
  now?: () => Date
}

interface OAuthSessionRecord {
  state: string
  codeVerifier: string
  createdAt: number
}

export interface OAuthAuthorizationSession {
  sessionId: string
  authUrl: string
  expiresAt: string
}

export interface OAuthAuthorizationResolution {
  credentials: NormalizedCredential[]
  errors: string[]
  total: number
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function safeOAuthError(payload: unknown, status: number): string {
  const root = asRecord(payload)
  const code = stringValue(root?.error) ?? stringValue(asRecord(root?.error)?.code)
  return `OpenAI OAuth 授权失败（HTTP ${status}${code ? `: ${code.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 60)}` : ''}）`
}

function parseCallbackInput(input: string): { code: string | null; state: string | null } {
  const text = input.trim()
  if (!text) return { code: null, state: null }
  if (!text.includes('code=')) return { code: text, state: null }
  try {
    const url = new URL(text.includes('?') ? text : `http://localhost/callback?${text.replace(/^\?/, '')}`)
    return { code: url.searchParams.get('code'), state: url.searchParams.get('state') }
  } catch {
    const code = text.match(/[?&]code=([^&]+)/)?.[1]
    const state = text.match(/[?&]state=([^&]+)/)?.[1]
    return {
      code: code ? decodeURIComponent(code) : null,
      state: state ? decodeURIComponent(state) : null
    }
  }
}

function sameState(actual: string, expected: string): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

export class OpenAIOAuthImporter {
  private readonly fetchImpl: FetchImplementation
  private readonly tokenUrl: string
  private readonly timeoutMs: number
  private readonly now: () => Date
  private readonly sessions = new Map<string, OAuthSessionRecord>()

  constructor(options: OAuthImporterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.tokenUrl = options.tokenUrl ?? TOKEN_URL
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.now = options.now ?? (() => new Date())
  }

  start(): OAuthAuthorizationSession {
    this.removeExpiredSessions()
    const now = this.now()
    const state = randomBytes(32).toString('hex')
    const codeVerifier = randomBytes(64).toString('hex')
    const sessionId = randomBytes(16).toString('hex')
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
    this.sessions.set(sessionId, { state, codeVerifier, createdAt: now.getTime() })
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CODEX_OAUTH_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true'
    })
    return {
      sessionId,
      authUrl: `${AUTHORIZE_URL}?${params.toString()}`,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString()
    }
  }

  async complete(
    sessionId: string,
    callbackInput: string,
    source: CredentialParseOptions = { sourcePath: 'oauth-authorization.json', format: 'paste' }
  ): Promise<OAuthAuthorizationResolution> {
    this.removeExpiredSessions()
    const session = this.sessions.get(sessionId)
    if (!session) return { credentials: [], errors: ['授权会话已过期，请重新打开授权页'], total: 1 }
    const callback = parseCallbackInput(callbackInput)
    if (!callback.code) return { credentials: [], errors: ['未从回调地址中识别到 authorization code'], total: 1 }
    if (callback.state && !sameState(callback.state, session.state)) {
      return { credentials: [], errors: ['OAuth state 校验失败，请重新授权'], total: 1 }
    }

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
          grant_type: 'authorization_code',
          client_id: CODEX_OAUTH_CLIENT_ID,
          code: callback.code,
          redirect_uri: REDIRECT_URI,
          code_verifier: session.codeVerifier
        }),
        signal: controller.signal
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        return { credentials: [], errors: [safeOAuthError(payload, response.status)], total: 1 }
      }
      const root = asRecord(payload)
      const accessToken = stringValue(root?.access_token)
      if (!accessToken) {
        return { credentials: [], errors: ['OAuth 响应缺少 access_token'], total: 1 }
      }
      const checkedAt = this.now()
      const expiresIn = Number(root?.expires_in)
      const parsed = parseCredentialText(JSON.stringify({
        access_token: accessToken,
        refresh_token: stringValue(root?.refresh_token),
        id_token: stringValue(root?.id_token),
        client_id: CODEX_OAUTH_CLIENT_ID,
        last_refresh: checkedAt.toISOString(),
        ...(Number.isFinite(expiresIn) && expiresIn > 0
          ? { expires_at: new Date(checkedAt.getTime() + expiresIn * 1_000).toISOString() }
          : {})
      }), source).credentials[0]
      if (!parsed) {
        return { credentials: [], errors: ['OAuth 响应无法转换为 Codex 凭据'], total: 1 }
      }
      this.sessions.delete(sessionId)
      return {
        credentials: [{ ...parsed, oauthClientId: CODEX_OAUTH_CLIENT_ID }],
        errors: [],
        total: 1
      }
    } catch (error) {
      return {
        credentials: [],
        errors: [error instanceof Error && error.name === 'AbortError'
          ? 'OAuth token 交换超时'
          : '无法连接 OpenAI OAuth token 接口'],
        total: 1
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private removeExpiredSessions(): void {
    const cutoff = this.now().getTime() - SESSION_TTL_MS
    for (const [id, session] of this.sessions) {
      if (session.createdAt < cutoff) this.sessions.delete(id)
    }
  }
}
