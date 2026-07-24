export const DEFAULT_LOCAL_API_SERVER_PORT = 8888
export const LOCAL_API_SERVER_HOST = '127.0.0.1' as const

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
  | 'anthropic_messages'
  | 'gemini'
  | 'ollama'
export type ModelRouteStrategy = 'single' | 'priority' | 'round_robin'
export type ModelRouteSourceMode = 'api_only' | 'credential_only' | 'mixed'
export type CredentialSourceProvider = 'codex' | 'cpa-codex' | 'grok' | 'cpa-grok'

export interface LocalApiAccessKeyInput {
  id: string
  label: string
  key?: string
  enabled: boolean
  allowedModels: string[]
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

export interface ModelRoute {
  publicModel: string
  strategy: ModelRouteStrategy
  sourceMode: ModelRouteSourceMode
  targets: ModelRouteTarget[]
}

export interface LocalApiServerConfigInput {
  port: number
  autoStart: boolean
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

export type CodexLocalApiIntegrationState =
  | 'not_bound'
  | 'active'
  | 'external_override'
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
      allowedModels: normalizeModelIds(entry.allowedModels)
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
    return {
      id,
      name,
      baseUrl,
      ...(apiKey === undefined ? {} : { apiKey }),
    protocol: (() => {
      if (!['auto', 'responses', 'chat_completions', 'anthropic_messages', 'gemini', 'ollama'].includes(entry.protocol)) {
        throw new Error('上游协议类型无效')
      }
      return entry.protocol
    })(),
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
    return {
      publicModel,
      strategy: route.strategy,
      sourceMode: route.sourceMode,
      targets
    }
  })

  if (codexBinding) {
    const key = accessKeys.find((entry) => entry.id === codexBinding.accessKeyId && entry.enabled)
    const routeExists = routes.some((route) => route.publicModel === codexBinding.model)
    const keyAllowsModel = key && (key.allowedModels.length === 0 || key.allowedModels.includes(codexBinding.model))
    if (!key || !routeExists || !keyAllowsModel) {
      throw new Error('Codex API 服务绑定引用了不可用的密钥或公开模型')
    }
  }

  return {
    port: input.port,
    autoStart: Boolean(input.autoStart),
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
