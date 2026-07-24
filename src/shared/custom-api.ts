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

/**
 * Result of parsing a free-form paste that may contain an API base URL and/or
 * an API key, possibly base64-encoded (standard or URL-safe, with or without
 * padding). Recognizes JSON objects, "url=... key=..." pairs, and raw tokens.
 */
export interface ParsedCustomApiPaste {
  baseUrl: string | null
  apiKey: string | null
  note: string
}

const URL_REGEX = /https?:\/\/[\w.\-:]+(?:\/[^\s"'<>]*)?/i
const KEY_REGEX = /(?:sk-|key-)?[A-Za-z0-9_\-]{16,}/

function tryDecodeBase64(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length < 8) return null
  // Accept standard and URL-safe base64; tolerate missing padding.
  if (!/^[A-Za-z0-9+/_\-]+={0,2}$/.test(trimmed)) return null
  const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  try {
    const decoded = typeof Buffer !== 'undefined' ? Buffer.from(padded, 'base64').toString('utf8') : (function(){const b=atob(padded);const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++){u[i]=b.charCodeAt(i)}return new TextDecoder('utf-8').decode(u)})()
    // Heuristic: only accept if it looks like text/JSON, not random bytes.
    if (!decoded || /[\x00-\x08\x0e-\x1f]/.test(decoded)) return null
    return decoded
  } catch {
    return null
  }
}

function extractUrl(text: string): string | null {
  const m = text.match(URL_REGEX)
  return m ? m[0].replace(/[.,)]$/, '') : null
}

function extractKey(text: string): string | null {
  // Prefer explicitly labeled keys first.
  const labeled = text.match(/(?:api[_-]?key|key|token|secret|bearer)\s*[:=]\s*"?([A-Za-z0-9_\-]+)"?/i)
  if (labeled?.[1] && labeled[1].length >= 16) return labeled[1]
  // Fall back to any long alphanumeric token (skips the URL itself).
  const withoutUrl = text.replace(URL_REGEX, ' ')
  const m = withoutUrl.match(KEY_REGEX)
  return m ? m[0] : null
}

/**
 * Parse a pasted blob into a base URL and API key.
 * Tries base64 decoding of the whole paste, then of each line, before falling
 * back to plain-text extraction. This handles pastes like a raw base64 blob
 * containing JSON, a "url=...\nkey=..." pair, or just a URL / key alone.
 */
export function parseCustomApiPaste(raw: string): ParsedCustomApiPaste {
  const b64Whole = tryDecodeBase64(raw.trim())
  const candidates: string[] = b64Whole ? [b64Whole, raw.trim()] : [raw.trim()]
  for (const line of raw.split(/\r?\n/)) {
    const b64Line = tryDecodeBase64(line.trim())
    if (b64Line) candidates.push(b64Line)
  }

  let baseUrl: string | null = null
  let apiKey: string | null = null
  const notes: string[] = []

  for (const candidate of candidates) {
    if (!baseUrl) {
      const url = extractUrl(candidate)
      if (url) { baseUrl = url; notes.push('已识别 API 地址') }
    }
    if (!apiKey) {
      const key = extractKey(candidate)
      if (key) { apiKey = key; notes.push('已识别 API Key') }
    }
    if (!baseUrl || !apiKey) {
      // Try JSON object form: {"base_url":"...","api_key":"..."}
      try {
        const obj = JSON.parse(candidate) as Record<string, unknown>
        if (!baseUrl) {
          const v = obj.base_url ?? obj.baseUrl ?? obj.url ?? obj.endpoint
          if (typeof v === 'string' && /^https?:\/\//.test(v)) { baseUrl = v; notes.push('已识别 API 地址（JSON）') }
        }
        if (!apiKey) {
          const v = obj.api_key ?? obj.apiKey ?? obj.key ?? obj.token ?? obj.secret
          if (typeof v === 'string' && v.length >= 8) { apiKey = v; notes.push('已识别 API Key（JSON）') }
        }
      } catch { /* not JSON */ }
    }
    if (baseUrl && apiKey) break
  }

  const note = notes.length > 0 ? notes.join('；') : (raw.trim() ? '未能从粘贴内容识别 URL 或 Key' : '请粘贴包含 API 地址和/或 Key 的文本')
  return { baseUrl, apiKey, note }
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
