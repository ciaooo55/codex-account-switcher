const LOCAL_API_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function normalizeCustomApiBaseUrl(value: string): string {
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

  const pathname = parsed.pathname.replace(/\/+$/, '')
  parsed.pathname = !pathname || pathname === '/' ? '/v1' : pathname
  return parsed.toString().replace(/\/$/, '')
}

export function customApiResponsesUrl(value: string): string {
  return `${normalizeCustomApiBaseUrl(value)}/responses`
}
