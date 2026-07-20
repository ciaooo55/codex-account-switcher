import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { normalizeCustomApiBaseUrl } from '../../shared/custom-api'

const DEFAULT_REASONING_LEVELS = [
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
  { effort: 'high', description: 'Greater reasoning depth for complex problems' },
  { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' }
] as const

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
}

export interface ModelCatalogDocument {
  models: ModelCatalogEntry[]
}

export function customApiModelsUrl(baseUrl: string): string {
  return `${normalizeCustomApiBaseUrl(baseUrl)}/models`
}

export function modelCatalogPath(codexHome: string): string {
  return join(codexHome, 'model-catalogs', 'account-switcher.json')
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

export function buildModelCatalog(modelIds: readonly string[], preferredModel: string): ModelCatalogDocument {
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
    models: ordered.map((slug, index) => ({
      slug,
      display_name: displayNameFor(slug),
      description: slug === preferred
        ? 'Custom API default model from Codex Account Switcher'
        : 'Custom API model from provider /v1/models',
      default_reasoning_level: 'high',
      supported_reasoning_levels: DEFAULT_REASONING_LEVELS.map((level) => ({ ...level })),
      shell_type: 'shell_command',
      visibility: 'list',
      supported_in_api: true,
      priority: index + 1
    }))
  }
}

export async function fetchOpenAiCompatibleModelIds(input: {
  baseUrl: string
  apiKey: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<string[]> {
  const url = customApiModelsUrl(input.baseUrl)
  const timeoutMs = Math.min(60_000, Math.max(1_000, input.timeoutMs ?? 8_000))
  const fetchImpl = input.fetchImpl ?? fetch
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
      throw new Error(`拉取模型列表失败：HTTP ${response.status}`)
    }
    const body = (await response.json()) as unknown
    const rows = Array.isArray(body)
      ? body
      : body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
        ? (body as { data: unknown[] }).data
        : null
    if (!rows) throw new Error('拉取模型列表失败：响应格式无效')

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
    return ids
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`拉取模型列表超时（${timeoutMs}ms）`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function writeModelCatalogFile(
  path: string,
  catalog: ModelCatalogDocument
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
}
