import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  customApiModelsUrlCandidates,
  customApiProbeTargets,
  MANAGED_CUSTOM_API_MODEL_CATALOG,
  type CustomApiProbeEndpoint
} from '../../shared/custom-api'

const DEFAULT_REASONING_LEVELS = [
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
  { effort: 'high', description: 'Greater reasoning depth for complex problems' },
  { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' }
] as const

/** Codex desktop requires base_instructions on every model_catalog_json entry. */
export const DEFAULT_CUSTOM_MODEL_BASE_INSTRUCTIONS =
  'You are a coding agent connected through a custom OpenAI-compatible API. Collaborate with the user until their task is complete. Prefer clear, concise progress updates and careful tool use.'

export interface ModelCatalogEntry {
  slug: string
  display_name: string
  description: string
  default_reasoning_level: string
  supported_reasoning_levels: Array<{ effort: string; description: string }>
  shell_type: 'shell_command'
  visibility: 'list'
  supported_in_api: boolean
  priority: number
  additional_speed_tiers: string[]
  service_tiers: unknown[]
  availability_nux: null
  upgrade: null
  /** Required by current Codex desktop ModelInfo parser. */
  base_instructions: string
  model_messages: {
    instructions_template: string
    instructions_variables: Record<string, string>
  }
  include_skills_usage_instructions: boolean
  support_verbosity: boolean
  default_verbosity: string
  supports_parallel_tool_calls: boolean
  supports_image_detail_original: boolean
  supports_reasoning_summaries: boolean
  supports_search_tool: boolean
  prefer_websockets: boolean
  reasoning_summary_format: string
  default_reasoning_summary: string
  apply_patch_tool_type: string
  web_search_tool_type: string
  truncation_policy: { mode: string; limit: number }
  input_modalities: Array<'text' | 'image'>
  context_window: number
  max_context_window: number
  effective_context_window_percent: number
  auto_compact_token_limit: number | null
  minimal_client_version: string
  multi_agent_version: string
  use_responses_lite: boolean
  tool_mode: string | null
  default_service_tier: null
  auto_review_model_override: null
  experimental_supported_tools: string[]
}

export interface ModelCatalogDocument {
  models: ModelCatalogEntry[]
}

export function customApiModelsUrl(baseUrl: string): string {
  return customApiModelsUrlCandidates(baseUrl)[0]
}

export const MODEL_CATALOG_RELATIVE_PATH = MANAGED_CUSTOM_API_MODEL_CATALOG

export function modelCatalogPath(codexHome: string): string {
  return join(codexHome, MODEL_CATALOG_RELATIVE_PATH)
}

export function modelCatalogConfigPath(): string {
  return MODEL_CATALOG_RELATIVE_PATH
}

function normalizeModelId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim()
  if (!id || id.length > 128) return null
  if (!/^[A-Za-z0-9._:/-]+$/.test(id)) return null
  return id
}

function displayNameFor(slug: string): string {
  return slug
    .split(/[/:]/)
    .filter(Boolean)
    .at(-1) ?? slug
}

function createCustomModelEntry(
  slug: string,
  preferred: string,
  index: number,
  displayOverride?: string
): ModelCatalogEntry {
  const display = displayOverride?.trim() || displayNameFor(slug)
  return {
    slug,
    display_name: display,
    description:
      slug === preferred
        ? 'Custom API default model from Codex Account Switcher'
        : 'Custom API model from provider /v1/models',
    default_reasoning_level: 'high',
    supported_reasoning_levels: DEFAULT_REASONING_LEVELS.map((level) => ({ ...level })),
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: index + 1,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: DEFAULT_CUSTOM_MODEL_BASE_INSTRUCTIONS,
    model_messages: {
      instructions_template: DEFAULT_CUSTOM_MODEL_BASE_INSTRUCTIONS + '\n\n{{ personality }}\n',
      instructions_variables: {
        personality_default: '',
        personality_friendly: '',
        personality_pragmatic: ''
      }
    },
    include_skills_usage_instructions: true,
    support_verbosity: true,
    default_verbosity: 'low',
    supports_parallel_tool_calls: true,
    supports_image_detail_original: true,
    supports_reasoning_summaries: true,
    supports_search_tool: false,
    prefer_websockets: false,
    reasoning_summary_format: 'experimental',
    default_reasoning_summary: 'none',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    input_modalities: ['text', 'image'],
    context_window: 272000,
    max_context_window: 272000,
    effective_context_window_percent: 100,
    auto_compact_token_limit: null,
    minimal_client_version: '0.124.0',
    multi_agent_version: 'v2',
    use_responses_lite: false,
    tool_mode: null,
    default_service_tier: null,
    auto_review_model_override: null,
    experimental_supported_tools: []
  }
}

export function buildModelCatalog(
  modelIds: readonly string[],
  preferredModel: string,
  displayNames: ReadonlyMap<string, string> = new Map()
): ModelCatalogDocument {
  const preferred = normalizeModelId(preferredModel) ?? preferredModel.trim()
  const seen = new Set<string>()
  const ordered: string[] = []

  for (const candidate of [preferred, ...modelIds]) {
    const id = normalizeModelId(candidate)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
  }

  if (ordered.length === 0) {
    throw new Error('模型目录至少需要一个有效模型名')
  }

  return {
    models: ordered.map((slug, index) =>
      createCustomModelEntry(slug, preferred, index, displayNames.get(slug.toLowerCase()))
    )
  }
}

export async function fetchOpenAiCompatibleModelIds(input: {
  baseUrl: string
  apiKey: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<{ models: string[]; baseUrl: string; modelsUrl: string; errors: string[] }> {
  const timeoutMs = Math.min(60_000, Math.max(1_000, input.timeoutMs ?? 8_000))
  const fetchImpl = input.fetchImpl ?? fetch
  const candidates = customApiModelsUrlCandidates(input.baseUrl)
  const errors: string[] = []

  for (const url of candidates) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          Accept: 'application/json'
        },
        signal: controller.signal
      })
      if (!response.ok) {
        errors.push(`${url} → HTTP ${response.status}`)
        // 404/405 = wrong path; 401/403/5xx still try other common suffixes
        continue
      }
      const body = (await response.json()) as unknown
      const rows = Array.isArray(body)
        ? body
        : body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
          ? (body as { data: unknown[] }).data
          : null
      if (!rows) {
        errors.push(`${url} → 响应格式无效`)
        continue
      }

      const ids: string[] = []
      const seen = new Set<string>()
      for (const row of rows) {
        const id =
          normalizeModelId(row) ??
          (row && typeof row === 'object'
            ? normalizeModelId((row as { id?: unknown }).id)
            : null)
        if (!id || seen.has(id)) continue
        seen.add(id)
        ids.push(id)
      }
      if (ids.length === 0) {
        errors.push(`${url} → 模型列表为空`)
        continue
      }
      const baseUrl = url.replace(/\/models\/?$/, '')
      return { models: ids, baseUrl, modelsUrl: url, errors }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        errors.push(`${url} → 超时（${timeoutMs}ms）`)
        continue
      }
      if (error instanceof Error && error.message.startsWith('拉取模型列表失败')) throw error
      errors.push(`${url} → ${error instanceof Error ? error.message : '请求失败'}`)
    } finally {
      clearTimeout(timer)
    }
  }

  // Exhausted common paths: do not block switching; catalog will still include the preferred model.
  const fallbackBase = (candidates[0] || '').replace(/\/models\/?$/, '') || input.baseUrl.trim().replace(/\/+$/, '')
  return {
    models: [],
    baseUrl: fallbackBase,
    modelsUrl: candidates[0] || `${fallbackBase}/models`,
    errors
  }
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback
  const record = body as {
    error?: unknown
    message?: unknown
  }
  if (typeof record.message === 'string' && record.message.trim()) return record.message.trim()
  const error = record.error
  if (typeof error === 'string' && error.trim()) return error.trim()
  if (error && typeof error === 'object') {
    const nested = error as { message?: unknown; code?: unknown }
    if (typeof nested.message === 'string' && nested.message.trim()) return nested.message.trim()
    if (typeof nested.code === 'string' && nested.code.trim()) return nested.code.trim()
  }
  return fallback
}

function isResponsesProbeResult(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  const response = body as Record<string, unknown>
  if (Array.isArray(response.choices)) return false
  if (typeof response.id !== 'string' || !response.id.trim()) return false
  if (typeof response.object === 'string' && response.object !== 'response') return false
  return (
    typeof response.status === 'string' ||
    typeof response.output_text === 'string' ||
    Array.isArray(response.output)
  )
}

function responsesOutputText(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ''
  const response = body as Record<string, unknown>
  const direct = typeof response.output_text === 'string' ? response.output_text.trim() : ''
  if (direct) return direct
  if (!Array.isArray(response.output)) return ''
  const parts: string[] = []
  for (const item of response.output) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (typeof record.text === 'string' && record.text.trim()) parts.push(record.text.trim())
    if (!Array.isArray(record.content)) continue
    for (const content of record.content) {
      if (!content || typeof content !== 'object' || Array.isArray(content)) continue
      const text = (content as Record<string, unknown>).text
      if (typeof text === 'string' && text.trim()) parts.push(text.trim())
    }
  }
  return parts.join('\n').trim()
}

async function postJson(input: {
  url: string
  apiKey: string
  body: unknown
  timeoutMs: number
  fetchImpl: typeof fetch
}): Promise<{ ok: boolean; status: number; body: unknown; text: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  try {
    const response = await input.fetchImpl(input.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(input.body),
      signal: controller.signal
    })
    const text = await response.text()
    let body: unknown = null
    if (text.trim()) {
      try {
        body = JSON.parse(text) as unknown
      } catch {
        body = null
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      body,
      text
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function probeCustomApiModel(input: {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<{ endpoint: 'responses'; baseUrl: string; probeUrl: string; output: string }> {
  const model = normalizeModelId(input.model)
  if (!model) throw new Error('模型名称无效')
  const timeoutMs = Math.min(60_000, Math.max(1_000, input.timeoutMs ?? 12_000))
  const fetchImpl = input.fetchImpl ?? fetch
  const targets = customApiProbeTargets(input.baseUrl)
  const softErrors: string[] = []
  let hardError: Error | null = null

  for (const target of targets) {
    if (target.endpoint !== 'responses') continue
    const body = {
      model,
      input: 'hi',
      max_output_tokens: 64,
      store: false,
      stream: false
    }

    try {
      const result = await postJson({
        url: target.url,
        apiKey: input.apiKey,
        timeoutMs,
        fetchImpl,
        body
      })
      const output = responsesOutputText(result.body)
      if (result.ok && isResponsesProbeResult(result.body) && output) {
        return {
          endpoint: target.endpoint,
          baseUrl: target.baseUrl,
          probeUrl: target.url,
          output: output.slice(0, 500)
        }
      }
      if (result.ok) {
        softErrors.push(`${target.url} → Responses 返回成功，但没有可读的模型回复`)
        continue
      }
      if (result.status === 404 || result.status === 405) {
        softErrors.push(
          `${target.url} → HTTP ${result.status}`
        )
        continue
      }
      // Auth/rate-limit etc: keep trying other common suffixes once, but remember message
      const detail = errorMessageFromBody(result.body, result.text.trim() || '上游拒绝了请求')
      softErrors.push(`${target.url} → HTTP ${result.status}：${detail}`)
      if (result.status === 401 || result.status === 403) {
        hardError = new Error(
          `模型测试失败（${target.url} HTTP ${result.status}）：${detail}`
        )
        // still try remaining targets — some proxies only protect one path
        continue
      }
    } catch (error) {
      softErrors.push(
        `${target.url} → ${error instanceof Error ? error.message : '请求失败'}`
      )
    }
  }

  if (hardError) throw hardError
  throw new Error(
    `模型测试失败：Codex 直连第三方 API 需要有效的 Responses 响应（已尝试 /v1、/api/v1、/openai/v1）。仅支持 chat/completions 的服务需要本地转换网关。${softErrors.slice(0, 5).join('；')}`
  )
}

export async function writeModelCatalogFile(
  path: string,
  catalog: ModelCatalogDocument
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const payload = `${JSON.stringify(catalog, null, 2)}\n`
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tempPath, payload, {
      encoding: 'utf8',
      mode: 0o600
    })
    await rename(tempPath, path)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw new Error(
      `模型目录文件写入失败：${path}${error instanceof Error ? `（${error.message}）` : ''}`
    )
  }
  let written: string
  try {
    written = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(
      `模型目录文件未生成：${path}${error instanceof Error ? `（${error.message}）` : ''}`
    )
  }
  if (written !== payload) {
    throw new Error(`模型目录写入校验失败：${path}`)
  }
}
