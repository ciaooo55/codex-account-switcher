import { normalizeCustomApiBaseUrl } from '../../shared/custom-api'

export type ManagedConfigKey =
  | 'model_provider'
  | 'openai_base_url'
  | 'model'
  | 'model_reasoning_effort'
  | 'model_catalog_json'
  | 'cli_auth_credentials_store'

export type ManagedConfigSnapshot = Record<ManagedConfigKey, string | null> & {
  ownedProviderSection?: string | null
}

const MANAGED_KEYS: ManagedConfigKey[] = [
  'model_provider',
  'openai_base_url',
  'model',
  'model_reasoning_effort',
  'model_catalog_json',
  'cli_auth_credentials_store'
]

export const OWNED_PROVIDER_ID = 'codex_account_switcher'

export interface ActiveOwnedProviderConfig {
  /** What Codex currently has at the top level; Desktop may have overwritten it. */
  topLevelProvider: string | null
  /** Exact value currently written at the top level. */
  model: string | null
  /** Exact configured provider URL. It is intentionally not re-normalized here. */
  baseUrl: string | null
  bearerToken: string | null
  modelCatalogJson: string | null
}

function assignmentPattern(key: ManagedConfigKey): RegExp {
  return new RegExp(`^\\s*${key}\\s*=`)
}

function tomlStringAssignment(line: string | undefined, key: string): string | null {
  if (!line) return null
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = line.match(
    new RegExp(`^\\s*${escapedKey}\\s*=\\s*("(?:\\\\.|[^"\\\\])*"|'[^']*')\\s*(?:#.*)?$`)
  )
  if (!match) return null
  const literal = match[1]
  if (literal.startsWith("'")) return literal.slice(1, -1)
  try {
    const parsed = JSON.parse(literal) as unknown
    return typeof parsed === 'string' ? parsed : null
  } catch {
    return null
  }
}

function firstSectionIndex(lines: string[]): number {
  const index = lines.findIndex((line) => /^\s*\[/.test(line))
  return index === -1 ? lines.length : index
}

function snapshotManagedLines(lines: string[]): ManagedConfigSnapshot {
  const sectionIndex = firstSectionIndex(lines)
  const topLevel = lines.slice(0, sectionIndex)
  return Object.fromEntries(
    MANAGED_KEYS.map((key) => [
      key,
      topLevel.find((line) => assignmentPattern(key).test(line))?.trim() ?? null
    ])
  ) as ManagedConfigSnapshot
}

function providerSection(text: string, providerId: string): string | null {
  const lines = text.split(/\r?\n/)
  const header = `[model_providers.${providerId}]`
  const start = lines.findIndex((line) => line.trim() === header)
  if (start === -1) return null
  let end = start + 1
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1
  return lines.slice(start, end).join(text.includes('\r\n') ? '\r\n' : '\n').trimEnd()
}

function snapshotManagedConfig(text: string): ManagedConfigSnapshot {
  const snapshot = {
    ...snapshotManagedLines(text.split(/\r?\n/)),
    ownedProviderSection: providerSection(text, OWNED_PROVIDER_ID)
  }
  if (/model-catalogs[\\/]account-switcher\.json["']?\s*$/i.test(snapshot.model_catalog_json ?? '')) {
    snapshot.model_catalog_json = null
  }
  return snapshot
}

/**
 * Reads the switcher's owned provider fields. The provider section itself is
 * the mode marker: Codex Desktop may rewrite the top-level provider/model while
 * preserving this section, and startup must be able to reassert those fields.
 * Keeping this
 * parser here avoids fragile RegExp string escaping at Electron startup (for
 * example, an unescaped `"\s"` becoming the literal letter `s`).
 */
export function readActiveOwnedProviderConfig(text: string): ActiveOwnedProviderConfig | null {
  const lines = text.split(/\r?\n/)
  const sectionIndex = firstSectionIndex(lines)
  const topLevel = lines.slice(0, sectionIndex)
  const header = `[model_providers.${OWNED_PROVIDER_ID}]`
  const start = lines.findIndex((line) => line.trim() === header)
  if (start === -1) return null
  const providerLines: string[] = []
  for (let index = start + 1; index < lines.length && !/^\s*\[/.test(lines[index]); index += 1) {
    providerLines.push(lines[index])
  }
  const providerValue = (key: 'base_url' | 'experimental_bearer_token'): string | null =>
    tomlStringAssignment(
      providerLines.find((line) => new RegExp(`^\\s*${key}\\s*=`).test(line)),
      key
    )

  return {
    topLevelProvider: tomlStringAssignment(
      topLevel.find((line) => assignmentPattern('model_provider').test(line)),
      'model_provider'
    ),
    model: tomlStringAssignment(
      topLevel.find((line) => assignmentPattern('model').test(line)),
      'model'
    ),
    baseUrl: providerValue('base_url'),
    bearerToken: providerValue('experimental_bearer_token'),
    modelCatalogJson: tomlStringAssignment(
      topLevel.find((line) => assignmentPattern('model_catalog_json').test(line)),
      'model_catalog_json'
    )
  }
}

function replaceManagedLines(text: string, replacements: Partial<ManagedConfigSnapshot>): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const hadTrailingNewline = text.endsWith('\n')
  const lines = text.split(/\r?\n/)
  if (hadTrailingNewline && lines.at(-1) === '') lines.pop()

  const sectionIndex = firstSectionIndex(lines)
  const topLevel = lines.slice(0, sectionIndex)
  const sections = lines.slice(sectionIndex)
  const filtered = topLevel.filter(
    (line) => !MANAGED_KEYS.some((key) => assignmentPattern(key).test(line))
  )
  const managedLines = MANAGED_KEYS.flatMap((key) => {
    const value = replacements[key]
    return value ? [value] : []
  })

  while (filtered.length > 0 && filtered[0].trim() === '') filtered.shift()
  const nextLines = [...managedLines]
  if (filtered.length > 0 || sections.length > 0) nextLines.push('')
  nextLines.push(...filtered, ...sections)

  const compacted: string[] = []
  for (const line of nextLines) {
    if (line === '' && compacted.at(-1) === '') continue
    compacted.push(line)
  }
  const result = compacted.join(newline)
  return hadTrailingNewline ? `${result}${newline}` : result
}

export function applyChatGptConfig(text: string): {
  text: string
  snapshot: ManagedConfigSnapshot
} {
  const snapshot = snapshotManagedConfig(text)
  const withoutOwnedProvider = removeProviderSection(text, OWNED_PROVIDER_ID)
  return {
    snapshot,
    text: replaceManagedLines(withoutOwnedProvider, {
      model_provider: 'model_provider = "openai"',
      openai_base_url: null,
      model: null,
      model_reasoning_effort: null,
      model_catalog_json: null,
      cli_auth_credentials_store: 'cli_auth_credentials_store = "file"'
    })
  }
}

export function restoreManagedConfig(
  currentText: string,
  snapshot: ManagedConfigSnapshot
): string {
  const restored = replaceManagedLines(currentText, snapshot)
  if (!Object.prototype.hasOwnProperty.call(snapshot, 'ownedProviderSection')) return restored
  const withoutOwnedProvider = removeProviderSection(restored, OWNED_PROVIDER_ID).trimEnd()
  if (!snapshot.ownedProviderSection) return `${withoutOwnedProvider}\n`
  return `${withoutOwnedProvider}\n\n${snapshot.ownedProviderSection.trim()}\n`
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function removeProviderSection(text: string, providerId: string): string {
  const lines = text.split(/\r?\n/)
  const header = `[model_providers.${providerId}]`
  let removed = false
  for (;;) {
    const start = lines.findIndex((line) => line.trim() === header)
    if (start === -1) break
    let end = start + 1
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1
    lines.splice(start, end - start)
    removed = true
  }
  if (!removed) return text
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  return lines.join(newline).replace(/(?:\r?\n){3,}/g, `${newline}${newline}`)
}

/**
 * Keeps the managed TOML section intact while refreshing the ephemeral loopback
 * gateway address after this app has restarted.
 */
export function replaceOwnedProviderBaseUrl(text: string, baseUrl: string): string | null {
  const lines = text.split(/\r?\n/)
  const header = `[model_providers.${OWNED_PROVIDER_ID}]`
  const start = lines.findIndex((line) => line.trim() === header)
  if (start === -1) return null
  let baseUrlLine = -1
  for (let index = start + 1; index < lines.length && !/^\s*\[/.test(lines[index]); index += 1) {
    if (/^\s*base_url\s*=/.test(lines[index])) {
      baseUrlLine = index
      break
    }
  }
  if (baseUrlLine === -1) return null
  lines[baseUrlLine] = `base_url = ${tomlString(normalizeCustomApiBaseUrl(baseUrl))}`
  return lines.join(text.includes('\r\n') ? '\r\n' : '\n')
}

export function applyCustomApiConfig(
  text: string,
  input: {
    baseUrl: string
    model: string
    apiKey: string
    /** Absolute path to the catalog written beside config.toml. */
    modelCatalogPath: string
    syncModelCatalog?: boolean
  }
): { text: string; snapshot: ManagedConfigSnapshot } {
  const snapshot = snapshotManagedConfig(text)
  const withoutPrevious = removeProviderSection(text, OWNED_PROVIDER_ID).trimEnd()
  const baseUrl = normalizeCustomApiBaseUrl(input.baseUrl)
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const managed = replaceManagedLines(withoutPrevious, {
    model_provider: `model_provider = ${tomlString(OWNED_PROVIDER_ID)}`,
    openai_base_url: null,
    model: `model = ${tomlString(input.model)}`,
    model_reasoning_effort: null,
    model_catalog_json: input.syncModelCatalog === false
      ? null
      : `model_catalog_json = ${tomlString(input.modelCatalogPath)}`,
    cli_auth_credentials_store: 'cli_auth_credentials_store = "file"'
  }).trimEnd()
  const provider = [
    `[model_providers.${OWNED_PROVIDER_ID}]`,
    'name = "Codex Account Switcher"',
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    `experimental_bearer_token = ${tomlString(input.apiKey)}`,
    'supports_websockets = false'
  ].join(newline)
  return { snapshot, text: `${managed}${newline}${newline}${provider}${newline}` }
}
