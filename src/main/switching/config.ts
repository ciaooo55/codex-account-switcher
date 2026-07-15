export type ManagedConfigKey =
  | 'model_provider'
  | 'model'
  | 'model_reasoning_effort'
  | 'cli_auth_credentials_store'

export type ManagedConfigSnapshot = Record<ManagedConfigKey, string | null>

const MANAGED_KEYS: ManagedConfigKey[] = [
  'model_provider',
  'model',
  'model_reasoning_effort',
  'cli_auth_credentials_store'
]

function assignmentPattern(key: ManagedConfigKey): RegExp {
  return new RegExp(`^\\s*${key}\\s*=`)
}

function firstSectionIndex(lines: string[]): number {
  const index = lines.findIndex((line) => /^\s*\[[^[]/.test(line))
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
  const lines = text.split(/\r?\n/)
  const snapshot = snapshotManagedLines(lines)
  return {
    snapshot,
    text: replaceManagedLines(text, {
      model_provider: 'model_provider = "openai"',
      model: null,
      model_reasoning_effort: null,
      cli_auth_credentials_store: 'cli_auth_credentials_store = "file"'
    })
  }
}

export function restoreManagedConfig(
  currentText: string,
  snapshot: ManagedConfigSnapshot
): string {
  return replaceManagedLines(currentText, snapshot)
}
