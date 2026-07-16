import { createHash } from 'node:crypto'
import type {
  CredentialParseOptions,
  CredentialParseResult,
  CredentialDialect,
  GrokCredential
} from '../../shared/types'
import { extractCredentialValues } from './parser'

export interface GrokCredentialParseResult extends Omit<CredentialParseResult, 'credentials'> {
  credentials: GrokCredential[]
}
const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const XAI_API_BASE = 'https://api.x.ai/v1'
const XAI_TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token'

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function string(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function jwt(token: string | null): Record<string, unknown> | null {
  if (!token) return null
  try {
    const part = token.split('.')[1]
    return part ? record(JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))) : null
  } catch {
    return null
  }
}

function timestamp(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const numeric = Number(value)
    const time = Number.isFinite(numeric)
      ? numeric > 10_000_000_000 ? numeric : numeric * 1_000
      : Date.parse(String(value))
    if (Number.isFinite(time)) return new Date(time).toISOString()
  }
  return null
}

function expiry(payload: Record<string, unknown> | null): string | null {
  return timestamp(payload?.exp)
}

function isXai(recordValue: Record<string, unknown>, accessPayload: Record<string, unknown> | null): boolean {
  const type = string(recordValue.type, recordValue.platform)?.toLowerCase()
  const issuer = string(accessPayload?.iss)
  const scope = string(recordValue.scope, accessPayload?.scope)
  const baseUrl = string(recordValue.base_url, recordValue.baseUrl)
  return type === 'xai' || type === 'grok' || issuer === 'https://auth.x.ai' ||
    Boolean(scope?.includes('grok-cli:access')) || Boolean(baseUrl?.includes('x.ai'))
}

function id(subject: string | null, teamId: string | null, email: string | null, token: string): string {
  const identity = subject
    ? `sub:${subject}\0team:${teamId ?? ''}`
    : email
      ? `email:${email.toLowerCase()}\0team:${teamId ?? ''}`
      : `token:${token}`
  return createHash('sha256').update(identity).digest('hex')
}

function dialectFor(value: Record<string, unknown>, wrapper: Record<string, unknown> | null): CredentialDialect {
  if (wrapper?.platform === 'grok' || wrapper?.platform === 'xai') return 'sub2api'
  if (value.type === 'xai' || value.type === 'grok') return 'cpa'
  return 'generic'
}

function normalize(
  value: Record<string, unknown>,
  wrapper: Record<string, unknown> | null,
  options: CredentialParseOptions
): GrokCredential | null {
  const accessToken = string(value.access_token, value.accessToken)
  if (!accessToken) return null
  const accessPayload = jwt(accessToken)
  if (!isXai(value, accessPayload) && !isXai(wrapper ?? {}, accessPayload)) return null
  const idToken = string(value.id_token, value.idToken)
  const idPayload = jwt(idToken)
  const extra = record(wrapper?.extra)
  const billingSnapshot = record(value.grok_billing_snapshot) ?? record(extra?.grok_billing_snapshot)
  const usageSnapshot = record(value.grok_usage_snapshot) ?? record(extra?.grok_usage_snapshot)
  const subject = string(value.sub, value.subject, idPayload?.sub, accessPayload?.sub)
  const teamId = string(value.team_id, value.teamId, idPayload?.team_id, accessPayload?.team_id)
  const email = string(value.email, idPayload?.email, accessPayload?.email, wrapper?.email)
  const expiresAt = expiry(accessPayload) ?? timestamp(
    value.expires_at,
    value.expiresAt,
    value.expired,
    value.expire
  )
  const planType = string(
    value.plan,
    value.plan_type,
    value.subscription_tier,
    billingSnapshot?.plan,
    usageSnapshot?.subscription_tier
  )

  return {
    id: id(subject, teamId, email, accessToken),
    email,
    subject,
    teamId,
    accessToken,
    refreshToken: string(value.refresh_token, value.refreshToken),
    idToken,
    tokenType: string(value.token_type, value.tokenType) ?? 'Bearer',
    clientId: string(value.client_id, value.clientId) ?? XAI_CLIENT_ID,
    baseUrl: string(value.base_url, value.baseUrl) ?? XAI_API_BASE,
    tokenEndpoint: string(value.token_endpoint, value.tokenEndpoint) ?? XAI_TOKEN_ENDPOINT,
    scope: string(value.scope),
    planType,
    lastRefresh: timestamp(value.last_refresh, value.lastRefresh),
    expiresAt,
    sourcePath: options.sourcePath,
    sourceFormat: options.format,
    sourceDialect: dialectFor(value, wrapper),
    billingSnapshot,
    usageSnapshot
  }
}

function candidates(value: unknown, options: CredentialParseOptions, depth = 0): GrokCredential[] {
  if (depth > 64) return []
  if (Array.isArray(value)) return value.flatMap((item) => candidates(item, options, depth + 1))
  const outer = record(value)
  if (!outer) return []
  const credentials = record(outer.credentials)
  if (credentials) {
    const merged = { ...record(outer.extra), ...credentials }
    const parsed = normalize(merged, outer, options)
    return parsed ? [parsed] : []
  }
  const parsed = normalize(outer, null, options)
  if (parsed) return [parsed]
  return Object.values(outer).flatMap((item) => candidates(item, options, depth + 1))
}

function completeness(value: GrokCredential): number {
  return [value.accessToken, value.refreshToken, value.idToken].filter(Boolean).length
}

function merge(left: GrokCredential, right: GrokCredential): GrokCredential {
  const leftTime = Date.parse(left.lastRefresh ?? '') || 0
  const rightTime = Date.parse(right.lastRefresh ?? '') || 0
  const preferred = completeness(right) > completeness(left) ||
    (completeness(right) === completeness(left) && rightTime >= leftTime) ? right : left
  const fallback = preferred === right ? left : right
  return {
    ...preferred,
    email: preferred.email ?? fallback.email,
    subject: preferred.subject ?? fallback.subject,
    teamId: preferred.teamId ?? fallback.teamId,
    refreshToken: preferred.refreshToken ?? fallback.refreshToken,
    idToken: preferred.idToken ?? fallback.idToken,
    planType: preferred.planType ?? fallback.planType,
    billingSnapshot: preferred.billingSnapshot ?? fallback.billingSnapshot,
    usageSnapshot: preferred.usageSnapshot ?? fallback.usageSnapshot
  }
}

export function dedupeGrokCredentials(values: readonly GrokCredential[]): GrokCredential[] {
  const result = new Map<string, GrokCredential>()
  for (const value of values) {
    const current = result.get(value.id)
    result.set(value.id, current ? merge(current, value) : value)
  }
  return [...result.values()]
}

export function parseGrokCredentialText(
  text: string,
  options: CredentialParseOptions
): GrokCredentialParseResult {
  try {
    const values = extractCredentialValues(text, options)
    const credentials = dedupeGrokCredentials(values.flatMap((value) => candidates(value, options)))
    return credentials.length > 0
      ? { credentials, errors: [] }
      : { credentials: [], errors: [`未在 ${options.sourcePath || '<粘贴内容>'} 中找到 Grok 凭据`] }
  } catch {
    return { credentials: [], errors: [`无法解析 ${options.sourcePath || '<粘贴内容>'} 中的 Grok 凭据`] }
  }
}
