import { randomUUID } from 'node:crypto'
import type {
  AccountStatus,
  CodexTestMode,
  NormalizedCredential,
  TestResult,
  UsageSummary,
  UsageWindow
} from '../../shared/types'
import { parseCredentialText } from '../accounts/parser'

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
const COMPACT_URL = 'https://chatgpt.com/backend-api/codex/responses/compact'
const REFRESH_URL = 'https://auth.openai.com/oauth/token'
const PERSONAL_ACCESS_TOKEN_WHOAMI_URL =
  'https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami'
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CODEX_VERSION = '0.135.0'
const CODEX_USER_AGENT = `codex-tui/${CODEX_VERSION} (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; ${CODEX_VERSION})`
const CODEX_CLI_VERSION = '0.144.1'
const CODEX_CLI_USER_AGENT = `codex_cli_rs/${CODEX_CLI_VERSION} (Ubuntu 22.4.0; x86_64) xterm-256color`

type FetchImplementation = typeof fetch

interface CredentialTesterOptions {
  fetchImpl?: FetchImplementation
  now?: () => Date
  timeoutMs?: number
  deepTestModel?: string
  onCredentialUpdated?: (credential: NormalizedCredential) => void | Promise<void>
  usageUrl?: string
  resetCreditsUrl?: string
  queryResetCredits?: boolean
  compactUrl?: string
  refreshUrl?: string
  personalAccessTokenWhoamiUrl?: string
}

interface StageResult {
  status: AccountStatus
  detail: string
  httpStatus: number | null
  stage: TestResult['stage']
  usage: UsageSummary | null
  authFailure: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function firstRecord(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const record = asRecord(value)
    if (record) return record
  }
  return null
}

function numberOrNull(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function scalarStringOrNull(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return stringOrNull(value)
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function percentageFromScalars(remaining: string | null, limit: string | null): number | null {
  if (remaining === null || limit === null) return null
  const remainingValue = Number(remaining)
  const limitValue = Number(limit)
  if (!Number.isFinite(remainingValue) || !Number.isFinite(limitValue) || limitValue <= 0) {
    return null
  }
  return Math.max(0, Math.min(100, (remainingValue / limitValue) * 100))
}

function timestampOrNull(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
  }
  const timestamp = numberOrNull(value)
  if (timestamp === null || timestamp <= 0) return null
  const milliseconds = timestamp > 10_000_000_000 ? timestamp : timestamp * 1_000
  const date = new Date(milliseconds)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function windowLabel(baseLabel: string, slot: 'primary' | 'secondary', seconds: number | null): string {
  if (seconds === 7 * 24 * 60 * 60) return `${baseLabel} 周额度`
  if (seconds !== null && seconds > 0) {
    if (seconds % 86_400 === 0) return `${baseLabel} ${seconds / 86_400} 天`
    if (seconds % 3_600 === 0) return `${baseLabel} ${seconds / 3_600} 小时`
    if (seconds % 60 === 0) return `${baseLabel} ${seconds / 60} 分钟`
    return `${baseLabel} ${seconds} 秒`
  }
  return `${baseLabel} ${slot === 'primary' ? '主窗口' : '次窗口'}`
}

function rawWindowSeconds(value: unknown): number | null {
  const record = asRecord(value)
  return record ? numberOrNull(record.limit_window_seconds ?? record.limitWindowSeconds) : null
}

function normalizedWindowSeconds(
  primaryValue: unknown,
  secondaryValue: unknown
): { primary: number | null; secondary: number | null } {
  const primary = rawWindowSeconds(primaryValue)
  const secondary = rawWindowSeconds(secondaryValue)
  if (primary !== null && secondary !== null) return { primary, secondary }
  if (primary !== null) {
    return primary <= 21_600
      ? { primary, secondary: 604_800 }
      : { primary, secondary: 18_000 }
  }
  if (secondary !== null) {
    return secondary <= 21_600
      ? { primary: 604_800, secondary }
      : { primary: 18_000, secondary }
  }
  // Sub2API keeps compatibility with the legacy wham response where duration
  // was omitted: primary is weekly and secondary is the short (5h) window.
  return { primary: 604_800, secondary: 18_000 }
}

function usageWindow(
  id: string,
  baseLabel: string,
  slot: 'primary' | 'secondary',
  value: unknown,
  checkedAt: string,
  limitReached?: unknown,
  allowed?: unknown,
  normalizedSeconds?: number | null
): UsageWindow | null {
  const record = asRecord(value)
  if (!record) return null
  let usedPercent = numberOrNull(record.used_percent ?? record.usedPercent)
  if (usedPercent === null && (limitReached === true || allowed === false)) usedPercent = 100
  if (usedPercent !== null) usedPercent = Math.max(0, Math.min(100, usedPercent))
  const windowSeconds = normalizedSeconds ?? numberOrNull(
    record.limit_window_seconds ?? record.limitWindowSeconds
  )
  const resetInSeconds = numberOrNull(
    record.reset_after_seconds ??
      record.resetAfterSeconds ??
      record.resets_in_seconds ??
      record.resetsInSeconds
  )
  const explicitResetAt = timestampOrNull(
    record.reset_at ?? record.resetAt ?? record.resets_at ?? record.resetsAt
  )
  const checkedTimestamp = Date.parse(checkedAt)
  const resetAt =
    explicitResetAt ??
    (resetInSeconds !== null && Number.isFinite(checkedTimestamp)
      ? new Date(checkedTimestamp + resetInSeconds * 1_000).toISOString()
      : null)
  return {
    id,
    label: windowLabel(baseLabel, slot, windowSeconds),
    usedPercent,
    remainingPercent: usedPercent === null ? null : 100 - usedPercent,
    resetAt,
    resetInSeconds,
    windowSeconds
  }
}

function appendRateWindows(
  rows: UsageWindow[],
  rateValue: unknown,
  idPrefix: string,
  baseLabel: string,
  checkedAt: string
): void {
  const rate = asRecord(rateValue)
  if (!rate) return
  const primaryValue = rate.primary_window ?? rate.primaryWindow
  const secondaryValue = rate.secondary_window ?? rate.secondaryWindow
  const normalizedSeconds = normalizedWindowSeconds(primaryValue, secondaryValue)
  const primary = usageWindow(
    `${idPrefix}-primary`,
    baseLabel,
    'primary',
    primaryValue,
    checkedAt,
    rate.limit_reached ?? rate.limitReached,
    rate.allowed,
    normalizedSeconds.primary
  )
  const secondary = usageWindow(
    `${idPrefix}-secondary`,
    baseLabel,
    'secondary',
    secondaryValue,
    checkedAt,
    rate.limit_reached ?? rate.limitReached,
    rate.allowed,
    normalizedSeconds.secondary
  )
  if (primary) rows.push(primary)
  if (secondary) rows.push(secondary)
}

export function parseResetCreditCount(data: unknown): number | null {
  const root = asRecord(data)
  const explicit = numberOrNull(root?.available_count ?? root?.availableCount)
  if (explicit !== null && explicit >= 0) return Math.floor(explicit)

  let rows: unknown[] | null = Array.isArray(data) ? data : null
  if (!rows && root) {
    for (const value of [root.credits, root.rate_limit_reset_credits, root.items, root.data]) {
      if (Array.isArray(value)) {
        rows = value
        break
      }
    }
  }
  if (!rows) return null
  return rows.reduce<number>((count, value) => {
    const item = asRecord(value)
    if (!item) return count
    const resetType = stringOrNull(item.reset_type ?? item.resetType)
    const status = stringOrNull(item.status)
    if (resetType && resetType.toLowerCase() !== 'codex_rate_limits') return count
    if (status && status.toLowerCase() !== 'available') return count
    return count + 1
  }, 0)
}

export function parseUsageResponse(data: unknown, checkedAt = new Date().toISOString()): UsageSummary {
  const root = asRecord(data) ?? {}
  const windows: UsageWindow[] = []
  appendRateWindows(
    windows,
    root.rate_limit ?? root.rateLimit,
    'codex',
    'Codex',
    checkedAt
  )
  appendRateWindows(
    windows,
    root.code_review_rate_limit ?? root.codeReviewRateLimit,
    'review',
    '代码审查',
    checkedAt
  )
  const additional = root.additional_rate_limits ?? root.additionalRateLimits
  if (Array.isArray(additional)) {
    additional.forEach((item, index) => {
      const entry = asRecord(item)
      if (!entry) return
      const label =
        stringOrNull(
          entry.limit_name ?? entry.limitName ?? entry.metered_feature ?? entry.meteredFeature
        ) ?? `额外限额 ${index + 1}`
      appendRateWindows(
        windows,
        entry.rate_limit ?? entry.rateLimit,
        `additional-${index + 1}`,
        label,
        checkedAt
      )
    })
  }
  const creditRecord = asRecord(root.credits)
  const spendControl = asRecord(root.spend_control ?? root.spendControl)
  const individualLimit = asRecord(
    spendControl?.individual_limit ?? spendControl?.individualLimit
  )
  const resetCredits = asRecord(
    root.rate_limit_reset_credits ?? root.rateLimitResetCredits
  )
  const reachedTypeValue = root.rate_limit_reached_type ?? root.rateLimitReachedType
  const reachedType = asRecord(reachedTypeValue)
  const resetCreditsAvailable = numberOrNull(
    resetCredits?.available_count ?? resetCredits?.availableCount
  )
  const spendResetAfter = numberOrNull(
    individualLimit?.reset_after_seconds ?? individualLimit?.resetAfterSeconds
  )
  const spendResetAt = timestampOrNull(
    individualLimit?.reset_at ?? individualLimit?.resetAt
  ) ?? (
    spendResetAfter !== null && Number.isFinite(Date.parse(checkedAt))
      ? new Date(Date.parse(checkedAt) + spendResetAfter * 1_000).toISOString()
      : null
  )
  const spendLimitValue = scalarStringOrNull(individualLimit?.limit)
  const spendRemainingValue = scalarStringOrNull(individualLimit?.remaining)
  const explicitRemainingPercent = numberOrNull(
    individualLimit?.remaining_percent ?? individualLimit?.remainingPercent
  )
  return {
    planType: stringOrNull(root.plan_type ?? root.planType),
    windows,
    checkedAt,
    credits: creditRecord
      ? {
          hasCredits: booleanOrNull(creditRecord.has_credits ?? creditRecord.hasCredits) ?? false,
          unlimited: booleanOrNull(creditRecord.unlimited) ?? false,
          balance: scalarStringOrNull(creditRecord.balance)
        }
      : null,
    spendLimit: individualLimit
      ? {
          limit: spendLimitValue,
          used: scalarStringOrNull(individualLimit.used),
          remaining: spendRemainingValue,
          remainingPercent: explicitRemainingPercent ?? percentageFromScalars(
            spendRemainingValue,
            spendLimitValue
          ),
          resetAt: spendResetAt
        }
      : null,
    resetCreditsAvailable: resetCreditsAvailable === null
      ? null
      : Math.max(0, Math.floor(resetCreditsAvailable)),
    rateLimitReachedType: stringOrNull(reachedTypeValue) ??
      stringOrNull(reachedType?.type ?? reachedType?.kind)
  }
}

function responseDetail(value: unknown): string {
  const text = stringOrNull(value)
  if (text) return text
  const root = asRecord(value)
  const error = asRecord(root?.error)
  const detail = asRecord(root?.detail)
  return (
    stringOrNull(error?.message) ??
    stringOrNull(error?.code) ??
    stringOrNull(error?.type) ??
    stringOrNull(detail?.message) ??
    stringOrNull(detail?.code) ??
    stringOrNull(detail?.type) ??
    stringOrNull(root?.error_description) ??
    stringOrNull(root?.error) ??
    stringOrNull(root?.detail) ??
    stringOrNull(root?.message) ??
    '未知错误'
  )
}

async function responsePayload(response: Response): Promise<unknown> {
  try {
    const text = await response.text()
    if (!text.trim()) return null
    try {
      return JSON.parse(text) as unknown
    } catch {
      return text
    }
  } catch {
    return null
  }
}

function isModelError(detail: string, payload: unknown): boolean {
  const text = `${detail} ${JSON.stringify(payload)}`.toLowerCase()
  return (
    text.includes('model_not_found') ||
    (text.includes('model') &&
      (text.includes('unavailable') ||
        text.includes('unsupported') ||
        text.includes('does not exist') ||
        text.includes('not found') ||
        text.includes('high demand') ||
        text.includes('capacity') ||
        text.includes('overloaded')))
  )
}

export function exhaustedCodexQuota(
  usage: UsageSummary | null
): { status: 'quota_exhausted_5h' | 'quota_exhausted_weekly'; detail: string } | null {
  if (!usage) return null
  const exhausted = usage.windows.filter(
    (window) => window.id.startsWith('codex-') && window.remainingPercent !== null && window.remainingPercent <= 0
  )
  if (exhausted.length === 0) return null
  const fiveHour = exhausted.some(
    (window) => window.windowSeconds === 18_000 || window.label.includes('5 小时')
  )
  const weekly = exhausted.some(
    (window) => window.windowSeconds === 604_800 || window.label.includes('周额度')
  )
  if (fiveHour && weekly) {
    return { status: 'quota_exhausted_weekly', detail: '5 小时额度和周额度均已耗尽' }
  }
  if (weekly) return { status: 'quota_exhausted_weekly', detail: '周额度已耗尽' }
  return { status: 'quota_exhausted_5h', detail: '5 小时额度已耗尽' }
}

function isQuotaError(status: number, detail: string, payload: unknown): boolean {
  if (status === 402) return true
  const root = asRecord(payload)
  const error = asRecord(root?.error)
  const code = `${stringOrNull(error?.type) ?? ''} ${stringOrNull(error?.code) ?? ''}`
    .trim()
    .toLowerCase()
  if (
    code.includes('usage_limit_reached') ||
    code.includes('insufficient_quota') ||
    code.includes('payment_required')
  ) {
    return true
  }
  const text = detail.toLowerCase()
  return (
    text.includes('usage limit reached') ||
    text.includes('insufficient quota') ||
    text.includes('insufficient credits') ||
    text.includes('payment required') ||
    text.includes('billing quota')
  )
}

function isDeactivatedWorkspace(payload: unknown): boolean {
  const root = asRecord(payload)
  const detail = asRecord(root?.detail)
  const error = asRecord(root?.error)
  const code = stringOrNull(detail?.code) ?? stringOrNull(error?.code)
  return code?.toLowerCase() === 'deactivated_workspace'
}

function isRefreshCredentialError(payload: unknown): boolean {
  const root = asRecord(payload)
  const error = asRecord(root?.error)
  const text = [
    stringOrNull(root?.error),
    stringOrNull(root?.code),
    stringOrNull(root?.error_description),
    stringOrNull(root?.message),
    stringOrNull(error?.code),
    stringOrNull(error?.type),
    stringOrNull(error?.message)
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ')
    .toLowerCase()
  return [
    'invalid_grant',
    'refresh_token_reused',
    'refresh token is invalid',
    'refresh token expired',
    'invalid refresh token'
  ].some((marker) => text.includes(marker))
}

function sanitizedDetail(detail: string, credential: NormalizedCredential): string {
  let result = detail
  for (const token of [credential.accessToken, credential.refreshToken, credential.idToken]) {
    if (token && token.length >= 4) result = result.split(token).join('[redacted]')
  }
  result = result.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
  result = result.replace(/rt\.[A-Za-z0-9._-]+/g, 'rt.[redacted]')
  return result.slice(0, 280)
}

function headersFor(
  credential: NormalizedCredential,
  sessionId = randomUUID(),
  compact = false
): HeadersInit {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${credential.accessToken}`,
    'Content-Type': 'application/json',
    Originator: 'codex-tui',
    Session_id: sessionId,
    'User-Agent': CODEX_USER_AGENT,
    Version: CODEX_VERSION,
    ...(credential.accountId ? { 'Chatgpt-Account-Id': credential.accountId } : {}),
    ...(credential.isFedRamp ? { 'X-OpenAI-FedRAMP': 'true' } : {}),
    ...(compact
      ? {
          Conversation_ID: sessionId,
          'OpenAI-Beta': 'responses=experimental'
        }
      : {})
  }
}

function usageHeaders(credential: NormalizedCredential): HeadersInit {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${credential.accessToken}`,
    'OpenAI-Beta': 'codex-1',
    'Oai-Language': 'zh-CN',
    Originator: 'Codex Desktop',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Dest': 'empty',
    Priority: 'u=4, i',
    ...(credential.accountId ? { 'Chatgpt-Account-Id': credential.accountId } : {}),
    ...(credential.isFedRamp ? { 'X-OpenAI-FedRAMP': 'true' } : {})
  }
}

export class CredentialTester {
  private readonly fetchImpl: FetchImplementation
  private readonly now: () => Date
  private readonly timeoutMs: number
  private readonly deepTestModel: string
  private readonly usageUrl: string
  private readonly resetCreditsUrl: string
  private readonly queryResetCredits: boolean
  private readonly compactUrl: string
  private readonly refreshUrl: string
  private readonly personalAccessTokenWhoamiUrl: string

  constructor(private readonly options: CredentialTesterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? (() => new Date())
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.deepTestModel = options.deepTestModel ?? 'gpt-5.4'
    this.usageUrl = options.usageUrl ?? USAGE_URL
    this.resetCreditsUrl = options.resetCreditsUrl ?? RESET_CREDITS_URL
    this.queryResetCredits = options.queryResetCredits ?? (options.fetchImpl === undefined)
    this.compactUrl = options.compactUrl ?? COMPACT_URL
    this.refreshUrl = options.refreshUrl ?? REFRESH_URL
    this.personalAccessTokenWhoamiUrl =
      options.personalAccessTokenWhoamiUrl ?? PERSONAL_ACCESS_TOKEN_WHOAMI_URL
  }

  async test(
    credential: NormalizedCredential,
    signal?: AbortSignal,
    mode: CodexTestMode = 'full'
  ): Promise<TestResult> {
    const checkedAt = this.now().toISOString()
    let activeCredential = credential
    let refreshed = false

    if (mode === 'refresh') {
      if (!activeCredential.refreshToken) {
        return this.result(
          activeCredential,
          'non_refreshable',
          '该凭据不支持自动刷新',
          'refresh',
          checkedAt
        )
      }
      const refreshResult = await this.refresh(activeCredential, signal)
      if ('status' in refreshResult) return { ...refreshResult, checkedAt }
      return {
        accountId: credential.id,
        status: 'valid',
        detail: '凭据刷新成功（未执行额度与真实请求检测）',
        checkedAt,
        httpStatus: 200,
        stage: 'refresh',
        refreshed: true,
        usage: null
      }
    }

    if (
      activeCredential.authKind === 'personal_access_token' ||
      activeCredential.accessToken.startsWith('at-')
    ) {
      const hydrated = await this.hydratePersonalAccessToken(activeCredential, checkedAt, signal)
      if ('status' in hydrated) return hydrated
      activeCredential = hydrated.credential
    }

    if (this.isExpired(activeCredential.accessExpiresAt)) {
      if (!activeCredential.refreshToken) {
        return this.result(
          activeCredential,
          'non_refreshable',
          'access token 已过期且缺少 refresh token',
          'local',
          checkedAt
        )
      }
      const refreshResult = await this.refresh(activeCredential, signal)
      if ('status' in refreshResult) return { ...refreshResult, checkedAt }
      activeCredential = refreshResult.credential
      refreshed = true
    }

    let stageResult = await this.runStages(activeCredential, signal, mode)
    if (stageResult.authFailure && !refreshed && activeCredential.refreshToken) {
      const refreshResult = await this.refresh(activeCredential, signal)
      if ('status' in refreshResult) return { ...refreshResult, checkedAt }
      activeCredential = refreshResult.credential
      refreshed = true
      stageResult = await this.runStages(activeCredential, signal, mode)
    }

    return {
      accountId: credential.id,
      status: stageResult.status,
      detail: sanitizedDetail(stageResult.detail, activeCredential),
      checkedAt,
      httpStatus: stageResult.httpStatus,
      stage: stageResult.stage,
      refreshed,
      usage: stageResult.usage
    }
  }

  private async hydratePersonalAccessToken(
    credential: NormalizedCredential,
    checkedAt: string,
    signal?: AbortSignal
  ): Promise<{ credential: NormalizedCredential } | TestResult> {
    const response = await this.request(
      this.personalAccessTokenWhoamiUrl,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${credential.accessToken}`,
          Originator: 'codex_cli_rs',
          'User-Agent': CODEX_CLI_USER_AGENT
        }
      },
      signal,
      credential
    )
    if ('networkError' in response) {
      return {
        accountId: credential.id,
        status: response.networkError.status,
        detail: response.networkError.detail,
        checkedAt,
        httpStatus: response.networkError.httpStatus,
        stage: 'local',
        refreshed: false,
        usage: null
      }
    }
    const payload = await responsePayload(response)
    if (!response.ok) {
      return this.result(
        credential,
        response.status === 401 || response.status === 403 ? 'invalid' : 'endpoint_incompatible',
        responseDetail(payload),
        'local',
        checkedAt,
        response.status
      )
    }
    const root = asRecord(payload)
    const accountId = stringOrNull(root?.chatgpt_account_id ?? root?.chatgptAccountId)
    const subject = stringOrNull(root?.chatgpt_user_id ?? root?.chatgptUserId)
    const planType = stringOrNull(root?.chatgpt_plan_type ?? root?.chatgptPlanType)
    const email = stringOrNull(root?.email)
    const isFedRamp = [
      root?.chatgpt_account_is_fedramp,
      root?.chatgptAccountIsFedramp,
      root?.chatgptAccountIsFedRamp,
      root?.chatgptAccountIsFedRAMP
    ]
      .find((value) => typeof value === 'boolean') as boolean | undefined
    if (!email || !accountId || !subject || !planType || isFedRamp === undefined) {
      return this.result(
        credential,
        'endpoint_incompatible',
        'Personal Access Token 元数据响应缺少 workspace、用户或等级字段',
        'local',
        checkedAt,
        response.status
      )
    }
    const updated: NormalizedCredential = {
      ...credential,
      authKind: 'personal_access_token',
      email,
      accountId,
      subject,
      planType,
      isFedRamp,
      canRefresh: false,
      refreshToken: null,
      idToken: null,
      accessExpiresAt: null,
      idExpiresAt: null
    }
    await this.options.onCredentialUpdated?.(updated)
    return { credential: updated }
  }

  private async runStages(
    credential: NormalizedCredential,
    signal: AbortSignal | undefined,
    mode: Exclude<CodexTestMode, 'refresh'>
  ): Promise<StageResult> {
    let usage: UsageSummary | null = null
    let usageNotice: string | null = null
    let usageQuota: { detail: string; httpStatus: number } | null = null
    const sessionId = randomUUID()

    const usageResponse = await this.request(
      this.usageUrl,
      { method: 'GET', headers: usageHeaders(credential) },
      signal,
      credential
    )
    if ('networkError' in usageResponse) {
      if (mode === 'usage') return { ...usageResponse.networkError, stage: 'usage' }
      usageNotice = `额度查询失败: ${usageResponse.networkError.detail}`
    } else {
      const usagePayload = await responsePayload(usageResponse)
      const usageDetail = responseDetail(usagePayload)
      if (usageResponse.status === 401) {
        return this.stage('invalid', usageDetail, 401, 'usage', null, true)
      }
      if (isDeactivatedWorkspace(usagePayload)) {
        return this.stage('workspace_deactivated', 'Team/K12 工作区已停用', usageResponse.status, 'usage')
      }
      if (isQuotaError(usageResponse.status, usageDetail, usagePayload)) {
        if (mode === 'usage') {
          return this.stage('quota_exhausted', usageDetail, usageResponse.status, 'usage')
        }
        usageQuota = { detail: usageDetail, httpStatus: usageResponse.status }
      } else if (usageResponse.ok) {
        usage = parseUsageResponse(usagePayload, this.now().toISOString())
        if (this.queryResetCredits) {
          const resetCreditsResponse = await this.request(
            this.resetCreditsUrl,
            { method: 'GET', headers: usageHeaders(credential) },
            signal,
            credential
          )
          if (!('networkError' in resetCreditsResponse) && resetCreditsResponse.ok) {
            const count = parseResetCreditCount(await responsePayload(resetCreditsResponse))
            if (count !== null) usage.resetCreditsAvailable = count
          }
        }
        const exhaustedQuota = exhaustedCodexQuota(usage)
        if (exhaustedQuota) {
          return this.stage(
            exhaustedQuota.status,
            exhaustedQuota.detail,
            usageResponse.status,
            'usage',
            usage
          )
        }
        if (mode === 'usage') {
          return this.stage('valid', '额度查询成功（未执行真实请求检测）', usageResponse.status, 'usage', usage)
        }
      } else {
        if (mode === 'usage') {
          const status = usageResponse.status === 403
            ? 'no_permission'
            : usageResponse.status === 429
              ? 'network_error'
              : 'endpoint_incompatible'
          return this.stage(status, `额度接口 HTTP ${usageResponse.status}: ${usageDetail}`, usageResponse.status, 'usage')
        }
        usageNotice = `额度接口 HTTP ${usageResponse.status}: ${usageDetail}`
      }
    }

    const compactResponse = await this.request(
      this.compactUrl,
      {
        method: 'POST',
        headers: headersFor(credential, sessionId, true),
        body: JSON.stringify({
          instructions: 'You are a helpful coding assistant.',
          model: this.deepTestModel,
          input: [
            {
              type: 'message',
              role: 'user',
              content: 'Respond with OK.'
            }
          ]
        })
      },
      signal,
      credential
    )
    if ('networkError' in compactResponse) {
      return { ...compactResponse.networkError, stage: 'deep-test', usage }
    }
    const compactPayload = await responsePayload(compactResponse)
    const compactDetail = responseDetail(compactPayload)
    if (compactResponse.status === 401) {
      if (usage) {
        return this.stage(
          'endpoint_incompatible',
          `额度凭据有效，但深度检测接口拒绝了请求格式: ${compactDetail}`,
          401,
          'deep-test',
          usage
        )
      }
      return this.stage('invalid', compactDetail, 401, 'deep-test', usage, true)
    }
    if (compactResponse.status === 403) {
      return this.stage('no_permission', compactDetail, 403, 'deep-test', usage)
    }
    if (isDeactivatedWorkspace(compactPayload)) {
      return this.stage('workspace_deactivated', 'Team/K12 工作区已停用', compactResponse.status, 'deep-test', usage)
    }
    if (isQuotaError(compactResponse.status, compactDetail, compactPayload)) {
      const quota = exhaustedCodexQuota(usage)
      return this.stage(
        quota?.status ?? 'quota_exhausted',
        quota?.detail ?? compactDetail,
        compactResponse.status,
        'deep-test',
        usage
      )
    }
    if (isModelError(compactDetail, compactPayload)) {
      return this.stage(
        'model_unavailable',
        compactDetail,
        compactResponse.status,
        'deep-test',
        usage
      )
    }
    if (compactResponse.status === 429) {
      return this.stage(
        'network_error',
        `临时限流: ${compactDetail}`,
        429,
        'deep-test',
        usage
      )
    }
    if (!compactResponse.ok) {
      return this.stage(
        'endpoint_incompatible',
        `深度检测 HTTP ${compactResponse.status}: ${compactDetail}`,
        compactResponse.status,
        'deep-test',
        usage
      )
    }
    if (usageQuota) {
      usageNotice = `额度查询返回 HTTP ${usageQuota.httpStatus}: ${usageQuota.detail}`
    }
    return this.stage(
      'valid',
      usageNotice ? `账号可用；${usageNotice}` : '正常可用',
      200,
      'deep-test',
      usage
    )
  }

  private async refresh(
    credential: NormalizedCredential,
    signal?: AbortSignal
  ): Promise<{ credential: NormalizedCredential } | TestResult> {
    const checkedAt = this.now().toISOString()
    if (!credential.refreshToken) {
      return this.result(
        credential,
        'non_refreshable',
        '缺少 refresh token',
        'refresh',
        checkedAt
      )
    }
    const response = await this.request(
      this.refreshUrl,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          client_id: credential.oauthClientId ?? CODEX_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: credential.refreshToken,
          scope: 'openid profile email'
        })
      },
      signal,
      credential
    )
    if ('networkError' in response) {
      const error = response.networkError
      return {
        accountId: credential.id,
        status: error.status,
        detail: error.detail,
        checkedAt,
        httpStatus: error.httpStatus,
        stage: 'refresh',
        refreshed: false,
        usage: null
      }
    }
    const payload = await responsePayload(response)
    if (!response.ok) {
      const invalidCredential =
        response.status === 401 ||
        response.status === 403 ||
        (response.status === 400 && isRefreshCredentialError(payload))
      return this.result(
        credential,
        invalidCredential ? 'invalid' : 'endpoint_incompatible',
        responseDetail(payload),
        'refresh',
        checkedAt,
        response.status
      )
    }
    const root = asRecord(payload)
    const accessToken = stringOrNull(root?.access_token)
    if (!accessToken) {
      return this.result(
        credential,
        'invalid',
        '刷新响应缺少 access_token',
        'refresh',
        checkedAt,
        response.status
      )
    }
    const normalized = parseCredentialText(
      JSON.stringify({
        access_token: accessToken,
        refresh_token: stringOrNull(root?.refresh_token) ?? credential.refreshToken,
        client_id: credential.oauthClientId ?? CODEX_CLIENT_ID,
        id_token: stringOrNull(root?.id_token) ?? credential.idToken,
        account_id: stringOrNull(root?.account_id) ?? credential.accountId,
        email: credential.email,
        plan_type: credential.planType,
        last_refresh: checkedAt
      }),
      { sourcePath: credential.sourcePath, format: credential.sourceFormat }
    ).credentials[0]
    if (!normalized) {
      return this.result(
        credential,
        'invalid',
        '刷新响应无法转换为 Codex 凭据',
        'refresh',
        checkedAt,
        response.status
      )
    }
    const updated: NormalizedCredential = {
      ...credential,
      ...normalized,
      id: credential.id,
      sourcePath: credential.sourcePath,
      sourceFormat: credential.sourceFormat
    }
    await this.options.onCredentialUpdated?.(updated)
    return { credential: updated }
  }

  private async request(
    url: string,
    init: RequestInit,
    externalSignal: AbortSignal | undefined,
    credential: NormalizedCredential
  ): Promise<Response | { networkError: StageResult }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
    const abort = () => controller.abort()
    externalSignal?.addEventListener('abort', abort, { once: true })
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal })
    } catch (error) {
      const detail =
        controller.signal.aborted && !externalSignal?.aborted
          ? `请求超时（${this.timeoutMs}ms）`
          : externalSignal?.aborted
            ? '检测已取消'
            : error instanceof Error
              ? error.message
              : '网络请求失败'
      return {
        networkError: this.stage(
          'network_error',
          sanitizedDetail(detail, credential),
          null,
          'usage'
        )
      }
    } finally {
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', abort)
    }
  }

  private isExpired(value: string | null): boolean {
    if (!value) return false
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) && timestamp <= this.now().getTime()
  }

  private stage(
    status: AccountStatus,
    detail: string,
    httpStatus: number | null,
    stage: TestResult['stage'],
    usage: UsageSummary | null = null,
    authFailure = false
  ): StageResult {
    return { status, detail, httpStatus, stage, usage, authFailure }
  }

  private result(
    credential: NormalizedCredential,
    status: AccountStatus,
    detail: string,
    stage: TestResult['stage'],
    checkedAt: string,
    httpStatus: number | null = null
  ): TestResult {
    return {
      accountId: credential.id,
      status,
      detail: sanitizedDetail(detail, credential),
      checkedAt,
      httpStatus,
      stage,
      refreshed: false,
      usage: null
    }
  }
}

export const detectorEndpoints = {
  usage: USAGE_URL,
  resetCredits: RESET_CREDITS_URL,
  compact: COMPACT_URL,
  refresh: REFRESH_URL,
  personalAccessTokenWhoami: PERSONAL_ACCESS_TOKEN_WHOAMI_URL
} as const
