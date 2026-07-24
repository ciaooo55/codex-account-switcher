import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizeCustomApiBaseUrl } from '../../shared/custom-api'
import {
  buildModelCatalog,
  MODEL_CATALOG_RELATIVE_PATH,
  modelCatalogConfigPath,
  modelCatalogPath
} from '../services/model-catalog'
import { atomicWriteFile } from '../storage/atomic-file'
import { applyCustomApiConfig, readActiveOwnedProviderConfig } from './config'

const LEGACY_GATEWAY_TOKEN_PREFIX = 'cas-gateway-'

export interface EnsureDirectCustomApiProviderInput {
  authPath: string
  configPath: string
  /** Last real upstream saved by the switcher (never the old gateway URL). */
  storedBaseUrl: string
  storedModel: string
  apiKey: string
  /** Real model IDs saved by the custom-API editor. */
  models: readonly string[]
}

export interface EnsureDirectCustomApiProviderResult {
  active: boolean
  mode: 'inactive' | 'direct' | 'migrated-legacy-gateway' | 'unrecognized'
  baseUrl: string | null
  model: string | null
  configChanged: boolean
  authChanged: boolean
  catalogChanged: boolean
  catalogModels: string[]
}

export interface StableReassertResult {
  attempts: number
  last: EnsureDirectCustomApiProviderResult
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function usesManagedCatalog(value: string | null): boolean {
  if (!value) return false
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '')
  return normalized === MODEL_CATALOG_RELATIVE_PATH || normalized.endsWith(`/${MODEL_CATALOG_RELATIVE_PATH}`)
}

async function ensureApiKeyAuth(path: string, apiKey: string): Promise<boolean> {
  let matches = false
  try {
    const current = JSON.parse((await readOptional(path)) ?? '') as {
      auth_mode?: unknown
      OPENAI_API_KEY?: unknown
    }
    matches = current.auth_mode === 'apikey' && current.OPENAI_API_KEY === apiKey
  } catch {
    matches = false
  }
  if (matches) return false
  await atomicWriteFile(
    path,
    `${JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: apiKey }, null, 2)}\n`
  )
  return true
}

async function ensureCatalog(
  configPath: string,
  models: readonly string[],
  selectedModel: string
): Promise<{ changed: boolean; models: string[] }> {
  // An empty saved list can come from an older "provider only" configuration.
  // In that case, preserve the existing file instead of silently replacing it.
  if (models.length === 0) return { changed: false, models: [] }
  const catalog = buildModelCatalog(models, selectedModel)
  const expected = `${JSON.stringify(catalog, null, 2)}\n`
  const path = modelCatalogPath(dirname(configPath))
  if ((await readOptional(path)) === expected) {
    return { changed: false, models: catalog.models.map((entry) => entry.slug) }
  }
  await atomicWriteFile(path, expected)
  return { changed: true, models: catalog.models.map((entry) => entry.slug) }
}

/**
 * Repairs the one-time 0.13.13 local-gateway projection and then stays
 * conservative. A direct provider is never rewritten from possibly stale
 * settings, so its exact URL/port/model survive application restarts.
 */
export async function ensureDirectCustomApiProvider(
  input: EnsureDirectCustomApiProviderInput
): Promise<EnsureDirectCustomApiProviderResult> {
  const configText = (await readOptional(input.configPath)) ?? ''
  const current = readActiveOwnedProviderConfig(configText)
  const unchanged = (mode: EnsureDirectCustomApiProviderResult['mode']): EnsureDirectCustomApiProviderResult => ({
    active: mode !== 'inactive',
    mode,
    baseUrl: current?.baseUrl ?? null,
    model: current?.model ?? null,
    configChanged: false,
    authChanged: false,
    catalogChanged: false,
    catalogModels: []
  })
  if (!current) return unchanged('inactive')

  const apiKey = input.apiKey.trim()
  if (!apiKey) return unchanged('unrecognized')
  const legacyGateway = current.bearerToken?.startsWith(LEGACY_GATEWAY_TOKEN_PREFIX) === true
  const alreadyDirect = current.bearerToken === apiKey

  // Never replace an unknown/manual token with a value from the app store. The
  // old gateway is positively identified by its own generated token prefix.
  if (!legacyGateway && !alreadyDirect) return unchanged('unrecognized')

  const catalogPath = modelCatalogPath(dirname(input.configPath))
  const managedCatalogExists = (await readOptional(catalogPath)) !== null
  // Desktop can replace model_catalog_json with its own value. The managed
  // file is therefore also a durable marker for the user's sync choice.
  const syncModelCatalog = usesManagedCatalog(current.modelCatalogJson) || managedCatalogExists
  const baseUrl = legacyGateway
    ? normalizeCustomApiBaseUrl(input.storedBaseUrl)
    : current.baseUrl
  const model = input.storedModel.trim() || current.model
  if (!baseUrl || !model) return unchanged('unrecognized')

  // Rebuild top-level keys even for an already-direct provider. Codex Desktop
  // is known to replace them after it starts while retaining our owned section.
  const nextConfig = applyCustomApiConfig(configText, {
    baseUrl,
    model,
    apiKey,
    modelCatalogPath: modelCatalogConfigPath(dirname(input.configPath)),
    syncModelCatalog
  }).text
  const configChanged = nextConfig !== configText

  // Catalog first and config reference last: Codex can never observe a managed
  // reference whose real-model catalog is still the legacy shell projection.
  const catalog = syncModelCatalog && model
    ? await ensureCatalog(input.configPath, input.models, model)
    : { changed: false, models: [] as string[] }
  const authChanged = await ensureApiKeyAuth(input.authPath, apiKey)
  if (configChanged) await atomicWriteFile(input.configPath, nextConfig)

  return {
    active: true,
    mode: legacyGateway ? 'migrated-legacy-gateway' : 'direct',
    baseUrl,
    model,
    configChanged,
    authChanged,
    catalogChanged: catalog.changed,
    catalogModels: catalog.models
  }
}

/**
 * Codex may rewrite config.toml shortly after its process first appears. Run a
 * bounded series of delayed, idempotent reassertions; the final pass wins even
 * when an earlier pass was followed by a late Desktop write.
 */
export async function reassertDirectCustomApiProviderAfterStart(
  reconcile: () => Promise<EnsureDirectCustomApiProviderResult>,
  options: {
    delaysMs?: readonly number[]
    sleep?: (milliseconds: number) => Promise<void>
  } = {}
): Promise<StableReassertResult> {
  const delays = options.delaysMs ?? [300, 900, 1_800, 3_200]
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  let last: EnsureDirectCustomApiProviderResult | null = null
  let lastError: unknown = null
  let attempts = 0

  for (const delay of delays) {
    await sleep(Math.max(0, delay))
    try {
      last = await reconcile()
      attempts += 1
      lastError = null
      // Account mode removes the owned section, so no delayed custom-provider
      // write can race us and further polling would only slow normal restarts.
      if (!last.active) return { attempts, last }
    } catch (error) {
      attempts += 1
      lastError = error
    }
  }

  if (last) return { attempts, last }
  throw lastError instanceof Error
    ? lastError
    : new Error('Codex 启动后无法重新确认自定义 API 配置')
}

/**
 * Persistently watches config.toml for external overwrites (e.g. Cockpit Desktop
 * projection). When the owned provider section still exists but top-level
 * provider/model/catalog were replaced, the watcher reasserts the direct
 * custom-API configuration within a short debounce window.
 *
 * The watcher stops automatically when the owned section is removed (account-mode switch).
 */
export function watchConfigAndReassert(
  resolveInput: () => Promise<EnsureDirectCustomApiProviderInput>,
  options: {
    debounceMs?: number
    onReasserted?: (result: EnsureDirectCustomApiProviderResult) => void
    onError?: (error: unknown) => void
  } = {}
): { close: () => void } {
  const { watch } = require('fs') as typeof import('fs')
  const debounceMs = options.debounceMs ?? 800
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let configPath = ''

  const run = async (): Promise<void> => {
    try {
      const input = await resolveInput()
      configPath = input.configPath
      const result = await ensureDirectCustomApiProvider(input)
      if (!result.active) { close(); return }
      if (result.configChanged || result.catalogChanged || result.authChanged) {
        options.onReasserted?.(result)
      }
    } catch (error) { options.onError?.(error) }
  }

  const schedule = (): void => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; run() }, debounceMs)
  }

  const close = (): void => {
    closed = true
    if (timer) { clearTimeout(timer); timer = null }
    try { watcher.close() } catch { /* closed */ }
  }

  let watcher = { close: () => {} } as ReturnType<typeof watch>
  run().then(() => {
    if (configPath && !closed) {
      watcher = watch(configPath, { persistent: false }, () => { schedule() })
      watcher.on('error', () => { close() })
    }
  }).catch(() => { /* handled in run */ })

  return { close }
}
