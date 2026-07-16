import type {
  DisplayAccountStatus,
  GrokCredential,
  GrokTestResult,
  UsageSummary,
  UsageWindow
} from '../../shared/types'

const CLI_BASE = 'https://cli-chat-proxy.grok.com/v1'
const CLIENT_VERSION = '0.2.93'
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'

interface GrokDetectorOptions {
  timeoutMs: number
  fetch?: typeof fetch
  cliBaseUrl?: string
  onCredentialUpdated?: (credential: GrokCredential) => Promise<void>
}

interface BillingSummary {
  plan: string | null
  weeklyPercent: number | null
  weeklyResetAt: string | null
  monthlyPercent: number | null
  monthlyResetAt: string | null
}

interface UpstreamError {
  status: number | null
  code: string
  message: string
}

interface FetchResult {
  response: Response
  body: unknown
  text: string
}

const TRANSIENT_STATUS = new Set([408, 500, 502, 503, 504])

function number(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  }
  return null
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function string(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function upstreamError(body: unknown, text: string, fallbackStatus: number | null): UpstreamError {
  const root = object(body)
  const nested = object(root?.error)
  return {
    status: number(nested?.status, root?.status, fallbackStatus),
    code: string(nested?.code, root?.code, nested?.type, root?.type),
    message: string(nested?.message, typeof root?.error === 'string' ? root.error : null, root?.message, text)
  }
}

function sseError(text: string): UpstreamError | null {
  for (const line of text.split(/\r?\n/)) {
    const data = line.trim().replace(/^data:\s*/, '')
    if (!data || data === '[DONE]') continue
    try {
      const body = JSON.parse(data)
      const root = object(body)
      if (root?.type === 'error' || object(root?.error) || number(root?.status) !== null) {
        return upstreamError(body, '', number(root?.status))
      }
    } catch {
      // Ignore non-JSON SSE fields such as event names.
    }
  }
  return null
}

function quotaError(error: UpstreamError): boolean {
  const detail = `${error.code} ${error.message}`.toLowerCase()
  return error.status === 429 ||
    detail.includes('free-usage-exhausted') ||
    detail.includes('included free usage') ||
    detail.includes('resource_exhausted') ||
    detail.includes('quota exhausted') ||
    detail.includes('rate limit exceeded') ||
    detail.includes('used all')
}

function completedProbe(probe: FetchResult): boolean {
  const body = object(probe.body)
  return Boolean(
    body?.id ||
    body?.output ||
    object(body?.response)?.id ||
    probe.text.includes('response.completed') ||
    probe.text.includes('data: [DONE]')
  )
}

function date(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

function cents(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return number(value)
  const item = object(value)
  return number(item?.cents, item?.amount, item?.value, item?.val)
}

function parseBilling(body: unknown): BillingSummary | null {
  const config = object(object(body)?.config)
  if (!config) return null
  const period = object(config.currentPeriod)
  const weeklyPercent = number(config.creditUsagePercent)
  const monthlyLimit = cents(config.monthlyLimit)
  const used = cents(config.used)
  const monthlyPercent = monthlyLimit && monthlyLimit > 0 && used !== null
    ? Math.min(100, (used / monthlyLimit) * 100)
    : null
  const plan = monthlyLimit === 15_000
    ? 'SuperGrok'
    : monthlyLimit === 150_000
      ? 'SuperGrok Heavy'
      : null
  if (weeklyPercent === null && monthlyPercent === null && !plan) return null
  return {
    plan,
    weeklyPercent,
    weeklyResetAt: date(period?.end ?? config.billingPeriodEnd),
    monthlyPercent,
    monthlyResetAt: date(config.billingPeriodEnd)
  }
}

function mergeBilling(weekly: BillingSummary | null, monthly: BillingSummary | null): BillingSummary | null {
  if (!weekly && !monthly) return null
  return {
    plan: monthly?.plan ?? weekly?.plan ?? null,
    weeklyPercent: weekly?.weeklyPercent ?? monthly?.weeklyPercent ?? null,
    weeklyResetAt: weekly?.weeklyResetAt ?? null,
    monthlyPercent: monthly?.monthlyPercent ?? weekly?.monthlyPercent ?? null,
    monthlyResetAt: monthly?.monthlyResetAt ?? null
  }
}

function window(id: string, label: string, used: number | null, resetAt: string | null): UsageWindow {
  return {
    id,
    label,
    usedPercent: used,
    remainingPercent: used === null ? null : Math.max(0, Math.min(100, 100 - used)),
    resetAt,
    resetInSeconds: resetAt ? Math.max(0, Math.round((Date.parse(resetAt) - Date.now()) / 1000)) : null,
    windowSeconds: null
  }
}

function result(
  credential: GrokCredential,
  status: DisplayAccountStatus,
  detail: string,
  httpStatus: number | null,
  refreshed: boolean,
  usage: UsageSummary | null
): GrokTestResult {
  return {
    accountId: credential.id,
    status,
    detail,
    checkedAt: new Date().toISOString(),
    httpStatus,
    refreshed,
    usage
  }
}

export class GrokCredentialTester {
  private readonly request: typeof fetch
  private readonly cliBase: string

  constructor(private readonly options: GrokDetectorOptions) {
    this.request = options.fetch ?? fetch
    this.cliBase = (options.cliBaseUrl ?? CLI_BASE).replace(/\/$/, '')
  }

  async test(input: GrokCredential, signal?: AbortSignal): Promise<GrokTestResult> {
    let credential = input
    let refreshed = false
    try {
      const expiry = Date.parse(credential.expiresAt ?? '')
      if (Number.isFinite(expiry) && expiry <= Date.now() + 5 * 60_000) {
        if (!credential.refreshToken) {
          return result(credential, 'invalid', '访问凭据已过期且无法刷新', null, false, null)
        }
        credential = await this.refresh(credential, signal)
        refreshed = true
      }

      let checked = await this.check(credential, signal)
      if (checked.httpStatus === 401 && credential.refreshToken && !refreshed) {
        credential = await this.refresh(credential, signal)
        refreshed = true
        checked = await this.check(credential, signal)
      }
      return { ...checked, refreshed }
    } catch (error) {
      const message = error instanceof Error ? error.message : '检测失败'
      if (/invalid_grant|refresh token|unauthorized|401/i.test(message)) {
        return result(credential, 'invalid', '凭据已失效，OAuth 刷新失败', 401, refreshed, null)
      }
      return result(credential, 'unknown_error', message.includes('aborted') ? '检测已取消' : '网络或检测接口异常', null, refreshed, null)
    }
  }

  private async check(credential: GrokCredential, signal?: AbortSignal): Promise<GrokTestResult> {
    const headers = this.headers(credential.accessToken, false)
    const [weekly, monthly] = await Promise.all([
      this.fetchJson(`${this.cliBase}/billing?format=credits`, { headers, signal }),
      this.fetchJson(`${this.cliBase}/billing`, { headers, signal })
    ])
    const authFailure = [weekly.response.status, monthly.response.status].find((status) => status === 401 || status === 403)
    if (authFailure) return result(credential, 'invalid', 'Grok 凭据已被上游拒绝', authFailure, false, null)

    const billing = mergeBilling(
      weekly.response.ok ? parseBilling(weekly.body) : null,
      monthly.response.ok ? parseBilling(monthly.body) : null
    )
    const usage: UsageSummary | null = billing ? {
      planType: billing.plan ?? credential.planType,
      windows: [
        window('weekly', '周额度', billing.weeklyPercent, billing.weeklyResetAt),
        window('monthly', '月额度', billing.monthlyPercent, billing.monthlyResetAt)
      ].filter((item) => item.usedPercent !== null || item.resetAt !== null),
      checkedAt: new Date().toISOString()
    } : null

    if (
      (billing?.weeklyPercent !== null && billing?.weeklyPercent !== undefined && billing.weeklyPercent >= 100) ||
      (billing?.monthlyPercent !== null && billing?.monthlyPercent !== undefined && billing.monthlyPercent >= 100)
    ) {
      return result(credential, 'quota_exhausted_weekly', 'Grok 包含额度已耗尽', 200, false, usage)
    }

    let probe: FetchResult | null = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      probe = await this.fetchJson(`${this.cliBase}/responses`, {
        method: 'POST',
        headers: this.headers(credential.accessToken, true),
        body: JSON.stringify({
          model: 'grok-4.5',
          stream: true,
          store: false,
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply OK.' }] }],
          tools: [{ type: 'x_search' }],
          tool_choice: 'auto'
        }),
        signal
      })
      if (!TRANSIENT_STATUS.has(probe.response.status) || attempt === 1) break
      await this.wait(300, signal)
    }
    if (!probe) throw new Error('Grok 探测请求未执行')
    const streamError = sseError(probe.text)
    const error = streamError ?? upstreamError(probe.body, '', probe.response.status)
    const effectiveStatus = streamError?.status ?? probe.response.status
    if (effectiveStatus === 401 || effectiveStatus === 403) {
      return result(credential, 'invalid', 'Grok 凭据已失效或无订阅权限', effectiveStatus, false, usage)
    }
    if (quotaError(error)) {
      return result(credential, 'quota_exhausted_weekly', 'Grok 包含额度已耗尽', effectiveStatus, false, usage)
    }
    if (!probe.response.ok || streamError) {
      const detail = TRANSIENT_STATUS.has(effectiveStatus)
        ? `Grok 上游暂时不可用（${effectiveStatus}），凭据未判失效`
        : `Grok 检测请求返回 ${effectiveStatus}`
      return result(credential, 'unknown_error', detail, effectiveStatus, false, usage)
    }
    if (!completedProbe(probe)) {
      return result(credential, 'unknown_error', 'Grok 流式检测未返回完成事件', probe.response.status, false, usage)
    }
    return result(credential, 'valid', '凭据、额度和真实请求均验证成功', probe.response.status, false, usage)
  }

  private async refresh(credential: GrokCredential, signal?: AbortSignal): Promise<GrokCredential> {
    const tokenEndpoint = this.trustedTokenEndpoint(credential.tokenEndpoint)
    const response = await this.fetchJson(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: credential.clientId || CLIENT_ID,
        refresh_token: credential.refreshToken ?? ''
      }),
      signal
    })
    const body = object(response.body)
    const accessToken = typeof body?.access_token === 'string' ? body.access_token.trim() : ''
    if (!response.response.ok || !accessToken) {
      const code = object(body?.error)?.code ?? body?.error
      throw new Error(`OAuth refresh failed ${response.response.status}: ${String(code ?? 'invalid_grant')}`)
    }
    const expiresIn = number(body?.expires_in)
    const updated: GrokCredential = {
      ...credential,
      accessToken,
      refreshToken: typeof body?.refresh_token === 'string' && body.refresh_token.trim() ? body.refresh_token.trim() : credential.refreshToken,
      idToken: typeof body?.id_token === 'string' && body.id_token.trim() ? body.id_token.trim() : credential.idToken,
      tokenType: typeof body?.token_type === 'string' ? body.token_type : credential.tokenType,
      lastRefresh: new Date().toISOString(),
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : credential.expiresAt
    }
    await this.options.onCredentialUpdated?.(updated)
    return updated
  }

  private trustedTokenEndpoint(value: string): string {
    const parsed = new URL(value)
    const localTest = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('OAuth 刷新地址不受信任')
    }
    if ((parsed.protocol !== 'https:' || parsed.hostname !== 'auth.x.ai') && !localTest) {
      throw new Error('OAuth 刷新地址不受信任')
    }
    if (parsed.pathname !== '/oauth2/token' && !localTest) {
      throw new Error('OAuth 刷新地址不受信任')
    }
    return parsed.toString()
  }

  private headers(token: string, stream: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: stream ? 'text/event-stream' : 'application/json',
      'Content-Type': 'application/json',
      Connection: 'Keep-Alive',
      'X-XAI-Token-Auth': 'xai-grok-cli',
      'X-Grok-Client-Version': CLIENT_VERSION,
      'User-Agent': `xai-grok-workspace/${CLIENT_VERSION}`
    }
  }

  private async wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>
      const cleanup = (): void => signal?.removeEventListener('abort', abort)
      const finish = (): void => {
        cleanup()
        resolve()
      }
      const abort = (): void => {
        clearTimeout(timeout)
        cleanup()
        reject(new Error('aborted'))
      }
      timeout = setTimeout(finish, milliseconds)
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })
  }

  private async fetchJson(url: string, init: RequestInit): Promise<FetchResult> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs)
    const abort = (): void => controller.abort()
    init.signal?.addEventListener('abort', abort, { once: true })
    try {
      const response = await this.request(url, { ...init, signal: controller.signal })
      const text = (await response.text()).slice(0, 1_048_576)
      let body: unknown = null
      try { body = text ? JSON.parse(text) : null } catch { body = null }
      return { response, body, text }
    } finally {
      clearTimeout(timeout)
      init.signal?.removeEventListener('abort', abort)
    }
  }
}
