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

const OWNED_PROVIDER_ID = 'codex_account_switcher'

function assignmentPattern(key: ManagedConfigKey): RegExp {
  return new RegExp(`^\\s*${key}\\s*=`)
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
  return {
    ...snapshotManagedLines(text.split(/\r?\n/)),
    ownedProviderSection: providerSection(text, OWNED_PROVIDER_ID)
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
  const start = lines.findIndex((line) => line.trim() === header)
  if (start === -1) return text
  let end = start + 1
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1
  lines.splice(start, end - start)
  return lines.join(text.includes('\r\n') ? '\r\n' : '\n').replace(/\n{3,}/g, '\n\n')
}

export function applyCustomApiConfig(
  text: string,
  input: { baseUrl: string; model: string; modelCatalogPath: string }
): { text: string; snapshot: ManagedConfigSnapshot } {
  const snapshot = snapshotManagedConfig(text)
  const withoutPrevious = removeProviderSection(text, OWNED_PROVIDER_ID).trimEnd()
  const baseUrl = normalizeCustomApiBaseUrl(input.baseUrl)
  const managed = replaceManagedLines(withoutPrevious, {
    model_provider: 'model_provider = "openai"',
    openai_base_url: `openai_base_url = ${tomlString(baseUrl)}`,
    model: `model = ${tomlString(input.model)}`,
    model_reasoning_effort: null,
    model_catalog_json: `model_catalog_json = ${tomlString(input.modelCatalogPath)}`,
    cli_auth_credentials_store: 'cli_auth_credentials_store = "file"'
  }).trimEnd()
  return { snapshot, text: `${managed}\n` }
}
