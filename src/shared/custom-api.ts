const LOCAL_API_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

const TERMINAL_ENDPOINT_SUFFIXES = [
  '/chat/completions',
  '/completions',
  '/responses',
  '/models',
  '/embeddings'
] as const

/** Common OpenAI-compatible base path suffixes to try when probing. */
const COMMON_BASE_PATHS = ['/v1', '/api/v1', '/openai/v1', '/v1/openai', ''] as const

/** Root-relative catalog name used by Cockpit-style Codex provider projection. */
export const MANAGED_CUSTOM_API_MODEL_CATALOG = 'account-switcher-model-catalog.json'

function parseCustomApiUrl(value: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    throw new Error('自定义 API 地址无效')
  }

  const localHttp = parsed.protocol === 'http:' && LOCAL_API_HOSTS.has(parsed.hostname.toLowerCase())
  if (parsed.protocol !== 'https:' && !localHttp) {
    throw new Error('自定义 API 地址必须使用 HTTPS；本机地址可使用 HTTP')
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new Error('自定义 API 地址不能包含账号、密码或片段')
  }
  if (parsed.search) {
    throw new Error('自定义 API 地址不能包含查询参数')
  }
  return parsed
}

function originOf(parsed: URL): string {
  return parsed.origin
}

function joinOriginPath(origin: string, pathname: string): string {
  const path = pathname === '/' || pathname === '' ? '' : pathname.replace(/\/+$/, '')
  return path ? `${origin}${path.startsWith('/') ? path : `/${path}`}` : origin
}

/** Strip pasted full endpoint suffixes like /v1/chat/completions → /v1 */
export function stripCustomApiEndpointSuffix(pathname: string): string {
  let path = pathname.replace(/\/+$/, '') || '/'
  const lower = path.toLowerCase()
  for (const suffix of TERMINAL_ENDPOINT_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      path = path.slice(0, -suffix.length) || '/'
      break
    }
  }
  return path.replace(/\/+$/, '') || '/'
}

/**
 * Canonical base written into Codex config.
 * Accepts root, /v1, or a full endpoint URL; always returns origin + useful path without trailing slash.
 */
export function normalizeCustomApiBaseUrl(value: string): string {
  const parsed = parseCustomApiUrl(value)
  let pathname = stripCustomApiEndpointSuffix(parsed.pathname)
  if (!pathname || pathname === '/') pathname = '/v1'
  return joinOriginPath(originOf(parsed), pathname)
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value)
}

/**
 * Expand a user-entered URL into ordered base URL candidates for discovery:
 * preferred path first, then common /v1 variants and root.
 */
export function expandCustomApiBaseUrls(value: string): string[] {
  const parsed = parseCustomApiUrl(value)
  const origin = originOf(parsed)
  const stripped = stripCustomApiEndpointSuffix(parsed.pathname)
  const preferred = !stripped || stripped === '/' ? '/v1' : stripped

  const bases: string[] = []
  pushUnique(bases, joinOriginPath(origin, preferred))

  // If user entered a nested path, also try its parent once (e.g. /foo/v1 → keep, /foo → try)
  if (preferred !== '/v1' && preferred !== '/') {
    const parent = preferred.replace(/\/[^/]+$/, '') || '/'
    if (parent && parent !== preferred) {
      pushUnique(bases, joinOriginPath(origin, parent === '/' ? '/v1' : parent))
    }
  }

  for (const path of COMMON_BASE_PATHS) {
    pushUnique(bases, joinOriginPath(origin, path || '/'))
  }

  return bases
}

export function customApiModelsUrl(value: string): string {
  return `${normalizeCustomApiBaseUrl(value)}/models`
}

export function customApiModelsUrlCandidates(value: string): string[] {
  return expandCustomApiBaseUrls(value).map((base) => `${base}/models`)
}

export function customApiResponsesUrl(value: string): string {
  return `${normalizeCustomApiBaseUrl(value)}/responses`
}

export function customApiChatCompletionsUrl(value: string): string {
  return `${normalizeCustomApiBaseUrl(value)}/chat/completions`
}

export type CustomApiProbeEndpoint = 'responses' | 'chat_completions'

export interface CustomApiProbeTarget {
  endpoint: CustomApiProbeEndpoint
  /** Working OpenAI base for openai_base_url (no trailing endpoint). */
  baseUrl: string
  /** Full POST URL. */
  url: string
}

/** Ordered probe targets: responses first (Codex wire), then chat completions; all base variants. */
export function customApiProbeTargets(value: string): CustomApiProbeTarget[] {
  const bases = expandCustomApiBaseUrls(value)
  const targets: CustomApiProbeTarget[] = []
  const seen = new Set<string>()

  const push = (endpoint: CustomApiProbeEndpoint, baseUrl: string, suffix: string): void => {
    const url = `${baseUrl}${suffix}`
    if (seen.has(url)) return
    seen.add(url)
    targets.push({ endpoint, baseUrl, url })
  }

  for (const base of bases) push('responses', base, '/responses')
  for (const base of bases) push('chat_completions', base, '/chat/completions')
  return targets
}
