export const DEFAULT_LOCAL_API_SERVER_PORT = 8888
export const LOCAL_API_SERVER_HOST = '127.0.0.1' as const
export const DEFAULT_LOCAL_API_REQUEST_TIMEOUT_MS = 120_000
export const DEFAULT_LOCAL_API_MAX_RETRY_SOURCES = 0
export const DEFAULT_LOCAL_API_RETRY_DELAY_MS = 0

/**
 * Wire format exposed by a third-party upstream.  `auto` is intentionally
 * limited to the two OpenAI formats: the native provider formats must be
 * selected explicitly so a failed probe never sends a request to a surprising
 * endpoint.
 */
export type ApiUpstreamProtocol =
  | 'auto'
  | 'responses'
  | 'chat_completions'
  | 'completions'
  | 'anthropic_messages'
  | 'gemini'
  | 'gemini_interactions'
  | 'ollama'
/**
 * Authentication variants used by third-party gateways. `auto` chooses the
 * native convention for the selected protocol (for example x-api-key for
 * Anthropic and x-goog-api-key for Gemini) and Bearer for OpenAI-compatible
 * upstreams. The explicit modes cover common OpenAI-compatible relays without
 * forcing users to put a client key into the wrong header.
 */
export type ApiUpstreamAuthMode =
  | 'auto'
  | 'bearer'
  | 'x_api_key'
  | 'api_key'
  | 'x_goog_api_key'
  | 'query'
  | 'custom'
  | 'none'
export type ModelRouteStrategy = 'single' | 'priority' | 'round_robin'
export type ModelRouteSourceMode = 'api_only' | 'credential_only' | 'mixed'
export type CredentialSourceProvider = 'codex' | 'cpa-codex' | 'grok' | 'cpa-grok'

export interface LocalApiAccessKeyInput {
  id: string
  label: string
  key?: string
  enabled: boolean
  allowedModels: string[]
  /**
   * Optional per-client source pool. Empty preserves the route's full source
   * set; a non-empty list limits this key to the selected APIs/credentials.
   */
  allowedSourceIds?: string[]
}

export interface LocalApiAccessKeySummary extends Omit<LocalApiAccessKeyInput, 'key'> {
  hasKey: boolean
  keyPreview: string
  isShort: boolean
}

export interface ApiUpstreamInput {
  id: string
  name: string
  baseUrl: string
  apiKey?: string
  protocol: ApiUpstreamProtocol
  /** Optional for migration from 0.14.0 configurations. */
  authMode?: ApiUpstreamAuthMode
  /** Used only by `custom`; the API key remains separately encrypted. */
  authHeaderName?: string
  /** Optional literal prefix for `custom`, for example `Token `. */
  authHeaderPrefix?: string
  /** Used only by `query`; defaults to `api_key`. */
  authQueryParam?: string
  models: string[]
  priority: number
  enabled: boolean
}

export interface ApiUpstreamSummary extends Omit<ApiUpstreamInput, 'apiKey'> {
  hasApiKey: boolean
  keyPreview: string
}

/**
 * A secret-free reference to a credential owned by one of the existing account
 * libraries. Tokens and provider-specific private fields are deliberately not
 * part of the API-server configuration or renderer contract.
 */
export interface CredentialSourceInput {
  id: string
  provider: CredentialSourceProvider
  credentialId: string
  label: string
  models: string[]
  priority: number
  enabled: boolean
}

/**
 * The explicit, persisted choice to keep Codex on this app's loopback API.
 * It prevents another installed account manager from silently replacing the
 * selected provider and model catalog after the user has pressed Apply.
 */
export interface CodexLocalApiBinding {
  accessKeyId: string
  model: string
  enforce: boolean
}

export interface ModelRouteTarget {
  sourceId: string
  upstreamModel: string
  priority: number
  enabled: boolean
}

export interface ModelRoutePricing {
  /** USD per one million non-cached input tokens. */
  inputPerMillion: number
  /** USD per one million cached input tokens. */
  cachedInputPerMillion: number
  /** USD per one million output tokens. */
  outputPerMillion: number
}

export interface ModelRoute {
  publicModel: string
  strategy: ModelRouteStrategy
  sourceMode: ModelRouteSourceMode
  targets: ModelRouteTarget[]
  pricing?: ModelRoutePricing
}

export interface LocalApiServerConfigInput {
  port: number
  autoStart: boolean
  /** Upstream-open timeout. Existing streams may continue after headers arrive. */
  requestTimeoutMs?: number
  /** Maximum sources attempted per request; 0 means every eligible source. */
  maxRetrySources?: number
  /** Optional bounded pause before trying the next source. */
  retryDelayMs?: number
  /** Keeps an identified conversation on the same healthy source. */
  sessionAffinity?: boolean
  accessKeys: LocalApiAccessKeyInput[]
  upstreams: ApiUpstreamInput[]
  /** Optional only for compatibility with 0.13.x configuration call sites. */
  credentialSources?: CredentialSourceInput[]
  /** Optional only for compatibility with existing API-service files. */
  codexBinding?: CodexLocalApiBinding | null
  routes: ModelRoute[]
}

export interface LocalApiServerConfigSummary
  extends Omit<LocalApiServerConfigInput, 'accessKeys' | 'upstreams' | 'credentialSources'> {
  accessKeys: LocalApiAccessKeySummary[]
  upstreams: ApiUpstreamSummary[]
  credentialSources: CredentialSourceInput[]
}

/** Main-process-only configuration. Never expose this object over IPC. */
export interface LocalApiServerRuntimeConfig
  extends Omit<LocalApiServerConfigInput, 'accessKeys' | 'upstreams' | 'credentialSources'> {
  accessKeys: Array<Required<LocalApiAccessKeyInput>>
  upstreams: Array<Required<ApiUpstreamInput>>
  credentialSources: CredentialSourceInput[]
}

export interface LocalApiServerStatus {
  running: boolean
  host: typeof LOCAL_API_SERVER_HOST
  port: number
  pid: number | null
  startedAt: string | null
  error: string | null
}

/**
 * Secret-free, in-memory traffic record for the local API service.  This is
 * intentionally diagnostic data rather than a billing ledger: no request
 * body, client API key, upstream URL, or provider credential is retained.
 */
export interface LocalApiRequestLog {
  id: string
  at: string
  endpoint: string
  model: string | null
  accessKeyId: string | null
  sourceId: string | null
  sourceKind: 'api' | 'credential' | null
  status: number
  durationMs: number
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  estimatedCostUsd?: number
}

export interface LocalApiSourceHealth {
  sourceId: string
  state: 'ready' | 'cooling_down'
  cooldownUntil: string | null
}

/** Runtime telemetry is kept in memory and is reset when the app exits. */
export interface LocalApiServerMetrics {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  recentRequests: LocalApiRequestLog[]
  sourceHealth: LocalApiSourceHealth[]
}

export type CodexLocalApiIntegrationState =
  | 'not_bound'
  | 'active'
  | 'external_override'
  /** The owned provider remains selected, but its URL/key/bound model is stale. */
  | 'binding_mismatch'
  | 'model_mismatch'
  | 'catalog_missing'
  | 'unavailable'

/** Secret-free health record for the Codex configuration owned by this app. */
export interface CodexLocalApiIntegrationStatus {
  state: CodexLocalApiIntegrationState
  message: string
  configuredProvider: string | null
  configuredModel: string | null
  expectedModel: string | null
  catalogPath: string | null
}

export interface LocalApiServerState {
  config: LocalApiServerConfigSummary
  status: LocalApiServerStatus
  /** Absent only when reading state written by an older main process. */
  metrics?: LocalApiServerMetrics
  codexIntegration?: CodexLocalApiIntegrationStatus
}

/**
 * A secret-free result from a real upstream discovery and lightweight model
 * request.  `catalogOk` and `probeOk` are kept separate: a provider may
 * expose a useful model list even when its first model cannot answer a test
 * prompt (for example an image-only model).
 */
export interface LocalApiUpstreamCheckResult {
  id: string
  catalogOk: boolean
  probeOk: boolean | null
  baseUrl: string
  protocol: ApiUpstreamProtocol
  models: string[]
  latencyMs: number
  message: string
}

export interface LocalApiModelRefreshResult {
  upstreams: LocalApiUpstreamCheckResult[]
  credentialSources: CredentialSourceInput[]
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const MODEL_PATTERN = /^[A-Za-z0-9._:/-]{1,128}$/
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/
const FORBIDDEN_AUTH_HEADERS = new Set([
  'content-length', 'connection', 'host', 'transfer-encoding', 'upgrade'
])

export interface ApiUpstreamAuthConfig {
  protocol: ApiUpstreamProtocol
  apiKey?: string
  authMode?: ApiUpstreamAuthMode
  authHeaderName?: string
  authHeaderPrefix?: string
  authQueryParam?: string
}

function normalizeAuthMode(value: ApiUpstreamAuthMode | undefined): ApiUpstreamAuthMode {
  const mode = value ?? 'auto'
  if (!['auto', 'bearer', 'x_api_key', 'api_key', 'x_goog_api_key', 'query', 'custom', 'none'].includes(mode)) {
    throw new Error('上游鉴权方式无效')
  }
  return mode
}

function normalizeAuthHeaderName(value: string | undefined): string {
  const name = value?.trim() ?? ''
  if (!name) return ''
  if (!HEADER_NAME_PATTERN.test(name) || FORBIDDEN_AUTH_HEADERS.has(name.toLowerCase())) {
    throw new Error('自定义鉴权请求头无效')
  }
  return name
}

function normalizeAuthPrefix(value: string | undefined): string {
  const prefix = value ?? ''
  if (prefix.length > 200 || /[\r\n]/.test(prefix)) throw new Error('自定义鉴权前缀无效')
  return prefix
}

function normalizeAuthQueryParam(value: string | undefined): string {
  const parameter = (value?.trim() || 'api_key')
  if (!HEADER_NAME_PATTERN.test(parameter)) throw new Error('鉴权查询参数名无效')
  return parameter
}

function normalizeSourceIds(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values ?? []) {
    const sourceId = value.trim()
    if (!ID_PATTERN.test(sourceId) || seen.has(sourceId)) continue
    seen.add(sourceId)
    result.push(sourceId)
    if (result.length === 500) break
  }
  return result
}

/** Resolves automatic provider authentication into a concrete safe mode. */
export function resolvedApiUpstreamAuthMode(input: ApiUpstreamAuthConfig): ApiUpstreamAuthMode {
  if ((input.authMode ?? 'auto') !== 'auto') return input.authMode ?? 'auto'
  if (input.protocol === 'anthropic_messages') return 'x_api_key'
  if (input.protocol === 'gemini' || input.protocol === 'gemini_interactions') return 'x_goog_api_key'
  return 'bearer'
}

/** Builds only the credential header. Callers add protocol/content headers. */
export function apiUpstreamAuthHeaders(input: ApiUpstreamAuthConfig): Record<string, string> {
  const apiKey = input.apiKey?.trim() ?? ''
  if (!apiKey) return {}
  switch (resolvedApiUpstreamAuthMode(input)) {
    case 'bearer': return { authorization: `Bearer ${apiKey}` }
    case 'x_api_key': return { 'x-api-key': apiKey }
    case 'api_key': return { 'api-key': apiKey }
    case 'x_goog_api_key': return { 'x-goog-api-key': apiKey }
    case 'custom': {
      const name = normalizeAuthHeaderName(input.authHeaderName)
      return name ? { [name]: `${normalizeAuthPrefix(input.authHeaderPrefix)}${apiKey}` } : {}
    }
    default: return {}
  }
}

/** Applies query authentication without ever serialising the secret into logs. */
export function applyApiUpstreamAuthQuery(url: string, input: ApiUpstreamAuthConfig): string {
  const apiKey = input.apiKey?.trim() ?? ''
  if (!apiKey || resolvedApiUpstreamAuthMode(input) !== 'query') return url
  const parsed = new URL(url)
  parsed.searchParams.set(normalizeAuthQueryParam(input.authQueryParam), apiKey)
  return parsed.toString()
}

export function isValidLocalApiServerPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535
}

export function normalizeModelIds(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const model = value.trim()
    if (!MODEL_PATTERN.test(model) || seen.has(model)) continue
    seen.add(model)
    result.push(model)
    if (result.length === 500) break
  }
  return result
}

export function normalizeLocalApiServerConfig(
  input: LocalApiServerConfigInput
): LocalApiServerConfigInput {
  if (!isValidLocalApiServerPort(input.port)) throw new Error('API 服务端口必须在 1 到 65535 之间')

  const accessKeyIds = new Set<string>()
  const accessKeys = input.accessKeys.map((entry) => {
    const id = entry.id.trim()
    if (!ID_PATTERN.test(id) || accessKeyIds.has(id)) throw new Error('访问密钥 ID 无效或重复')
    accessKeyIds.add(id)
    const label = entry.label.trim()
    if (!label || label.length > 128) throw new Error('访问密钥名称不能为空或过长')
    const key = entry.key?.trim()
    if (key !== undefined && (!key || key.length > 16_384)) throw new Error('访问密钥不能为空或过长')
    return {
      id,
      label,
      ...(key === undefined ? {} : { key }),
      enabled: Boolean(entry.enabled),
      allowedModels: normalizeModelIds(entry.allowedModels),
      allowedSourceIds: normalizeSourceIds(entry.allowedSourceIds)
    }
  })

  const upstreamIds = new Set<string>()
  const upstreams = input.upstreams.map((entry) => {
    const id = entry.id.trim()
    if (!ID_PATTERN.test(id) || upstreamIds.has(id)) throw new Error('上游 ID 无效或重复')
    upstreamIds.add(id)
    const name = entry.name.trim()
    if (!name || name.length > 128) throw new Error('上游名称不能为空或过长')
    const baseUrl = normalizeHttpBaseUrl(entry.baseUrl)
    const apiKey = entry.apiKey?.trim()
    // Some self-hosted providers (notably a local Ollama daemon) do not use
    // an upstream key. An omitted/empty key is therefore valid; project
    // access still always requires one of this application's local keys.
    if (apiKey !== undefined && apiKey.length > 16_384) throw new Error('上游 API Key 过长')
    const priority = Number.isFinite(entry.priority) ? Math.trunc(entry.priority) : 0
    const protocol = (() => {
      if (!['auto', 'responses', 'chat_completions', 'completions', 'anthropic_messages', 'gemini', 'gemini_interactions', 'ollama'].includes(entry.protocol)) {
        throw new Error('上游协议类型无效')
      }
      return entry.protocol
    })()
    const authMode = normalizeAuthMode(entry.authMode)
    const authHeaderName = normalizeAuthHeaderName(entry.authHeaderName)
    const authHeaderPrefix = normalizeAuthPrefix(entry.authHeaderPrefix)
    const authQueryParam = normalizeAuthQueryParam(entry.authQueryParam)
    if (authMode === 'custom' && !authHeaderName) throw new Error('自定义鉴权必须填写请求头名称')
    return {
      id,
      name,
      baseUrl,
      ...(apiKey === undefined ? {} : { apiKey }),
      protocol,
      authMode,
      ...(authHeaderName ? { authHeaderName } : {}),
      ...(authHeaderPrefix ? { authHeaderPrefix } : {}),
      ...(authMode === 'query' || entry.authQueryParam ? { authQueryParam } : {}),
      models: normalizeModelIds(entry.models),
      priority,
      enabled: Boolean(entry.enabled)
    }
  })

  const credentialSourceIds = new Set<string>()
  const credentialSources = (input.credentialSources ?? []).map((entry) => {
    const provider = entry.provider
    if (!['codex', 'cpa-codex', 'grok', 'cpa-grok'].includes(provider)) {
      throw new Error('凭证来源类型无效')
    }
    const credentialId = entry.credentialId.trim()
    const id = entry.id.trim()
    if (
      !ID_PATTERN.test(credentialId)
      || id !== `${provider}:${credentialId}`
      || upstreamIds.has(id)
      || credentialSourceIds.has(id)
    ) {
      throw new Error('凭证来源 ID 无效或重复')
    }
    credentialSourceIds.add(id)
    const label = entry.label.trim()
    if (!label || label.length > 128) throw new Error('凭证来源名称不能为空或过长')
    return {
      id,
      provider,
      credentialId,
      label,
      models: normalizeModelIds(entry.models),
      priority: Number.isFinite(entry.priority) ? Math.trunc(entry.priority) : 0,
      enabled: Boolean(entry.enabled)
    }
  })

  const codexBinding = input.codexBinding === null || input.codexBinding === undefined
    ? null
    : (() => {
        const accessKeyId = input.codexBinding.accessKeyId.trim()
        const model = input.codexBinding.model.trim()
        if (!ID_PATTERN.test(accessKeyId) || !MODEL_PATTERN.test(model)) {
          throw new Error('Codex API 服务绑定无效')
        }
        return { accessKeyId, model, enforce: Boolean(input.codexBinding.enforce) }
      })()

  const publicModels = new Set<string>()
  const routes = input.routes.map((route) => {
    const publicModel = route.publicModel.trim()
    if (!MODEL_PATTERN.test(publicModel) || publicModels.has(publicModel)) {
      throw new Error('公开模型名称无效或重复')
    }
    publicModels.add(publicModel)
    const seenTargets = new Set<string>()
    const targets = route.targets.map((target) => {
      const sourceId = target.sourceId.trim()
      const upstreamModel = target.upstreamModel.trim()
      const identity = `${sourceId}\u0000${upstreamModel}`
      const apiSource = upstreamIds.has(sourceId)
      const credentialSource = credentialSourceIds.has(sourceId)
      const sourceAllowed = route.sourceMode === 'api_only'
        ? apiSource
        : route.sourceMode === 'credential_only'
          ? credentialSource
          : apiSource || credentialSource
      if (!sourceAllowed) throw new Error(`模型 ${publicModel} 引用了不存在或类型不匹配的上游`)
      if (!MODEL_PATTERN.test(upstreamModel) || seenTargets.has(identity)) {
        throw new Error(`模型 ${publicModel} 的路由目标无效或重复`)
      }
      seenTargets.add(identity)
      return {
        sourceId,
        upstreamModel,
        priority: Number.isFinite(target.priority) ? Math.trunc(target.priority) : 0,
        enabled: Boolean(target.enabled)
      }
    })
    const pricing = route.pricing === undefined ? undefined : (() => {
      const values = [route.pricing.inputPerMillion, route.pricing.cachedInputPerMillion, route.pricing.outputPerMillion]
      if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1_000_000)) {
        throw new Error(`模型 ${publicModel} 的价格配置无效`)
      }
      return {
        inputPerMillion: Number(route.pricing.inputPerMillion),
        cachedInputPerMillion: Number(route.pricing.cachedInputPerMillion),
        outputPerMillion: Number(route.pricing.outputPerMillion)
      }
    })()
    return {
      publicModel,
      strategy: route.strategy,
      sourceMode: route.sourceMode,
      targets,
      ...(pricing ? { pricing } : {})
    }
  })

  const sourceIds = new Set([...upstreamIds, ...credentialSourceIds])
  for (const key of accessKeys) {
    if (key.allowedSourceIds.some((sourceId) => !sourceIds.has(sourceId))) {
      throw new Error(`访问密钥“${key.label}”引用了不存在的 API 或账号凭证来源`)
    }
  }

  if (codexBinding) {
    const key = accessKeys.find((entry) => entry.id === codexBinding.accessKeyId && entry.enabled)
    const route = routes.find((entry) => entry.publicModel === codexBinding.model)
    const keyAllowsModel = key
      && route
      && (key.allowedModels.length === 0 || key.allowedModels.includes(codexBinding.model))
      && (key.allowedSourceIds.length === 0 || route.targets.some((target) => key.allowedSourceIds.includes(target.sourceId)))
    if (!key || !route || !keyAllowsModel) {
      throw new Error('Codex API 服务绑定引用了不可用的密钥或公开模型')
    }
  }

  const requestTimeoutMs = Number.isFinite(input.requestTimeoutMs)
    ? Math.trunc(input.requestTimeoutMs ?? DEFAULT_LOCAL_API_REQUEST_TIMEOUT_MS)
    : DEFAULT_LOCAL_API_REQUEST_TIMEOUT_MS
  const maxRetrySources = Number.isFinite(input.maxRetrySources)
    ? Math.trunc(input.maxRetrySources ?? DEFAULT_LOCAL_API_MAX_RETRY_SOURCES)
    : DEFAULT_LOCAL_API_MAX_RETRY_SOURCES
  const retryDelayMs = Number.isFinite(input.retryDelayMs)
    ? Math.trunc(input.retryDelayMs ?? DEFAULT_LOCAL_API_RETRY_DELAY_MS)
    : DEFAULT_LOCAL_API_RETRY_DELAY_MS
  if (requestTimeoutMs < 5_000 || requestTimeoutMs > 30 * 60_000) throw new Error('上游请求超时必须在 5 秒到 30 分钟之间')
  if (maxRetrySources < 0 || maxRetrySources > 100) throw new Error('最大尝试来源数必须在 0 到 100 之间')
  if (retryDelayMs < 0 || retryDelayMs > 30_000) throw new Error('故障切换等待必须在 0 到 30 秒之间')

  return {
    port: input.port,
    autoStart: Boolean(input.autoStart),
    requestTimeoutMs,
    maxRetrySources,
    retryDelayMs,
    sessionAffinity: input.sessionAffinity !== false,
    accessKeys,
    upstreams,
    credentialSources,
    codexBinding,
    routes
  }
}

export function normalizeHttpBaseUrl(value: string): string {
  const raw = value.trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('上游地址不是有效 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('上游地址只支持 HTTP 或 HTTPS')
  if (url.username || url.password || url.search || url.hash) throw new Error('上游地址不能包含凭据、查询参数或片段')
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

export function buildOpenAiUpstreamUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(normalizeHttpBaseUrl(baseUrl))
  const endpointPath = endpoint.startsWith('/') ? endpoint : `/${endpoint}`
  const basePath = url.pathname.replace(/\/+$/, '')
  const suffix = basePath.endsWith('/v1') && endpointPath.startsWith('/v1/')
    ? endpointPath.slice(3)
    : endpointPath
  url.pathname = `${basePath}${suffix}`.replace(/\/{2,}/g, '/')
  return url.toString()
}
