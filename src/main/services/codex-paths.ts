import { stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

interface CodexPathDiscoveryOptions {
  homeDirectory: string
  configuredAuthPath: string
  configuredConfigPath: string
  environment?: NodeJS.ProcessEnv
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  const unique = new Map<string, string>()
  for (const path of paths) {
    if (!path?.trim()) continue
    const normalized = resolve(path.trim())
    unique.set(normalized.toLowerCase(), normalized)
  }
  return [...unique.values()]
}

export async function discoverCodexDirectory(
  options: CodexPathDiscoveryOptions
): Promise<string | null> {
  const environment = options.environment ?? process.env
  const configuredAuthDirectory = dirname(options.configuredAuthPath)
  const configuredConfigDirectory = dirname(options.configuredConfigPath)
  const candidates = uniquePaths([
    environment.CODEX_HOME,
    configuredAuthDirectory,
    configuredConfigDirectory,
    join(options.homeDirectory, '.codex'),
    environment.USERPROFILE ? join(environment.USERPROFILE, '.codex') : null,
    environment.HOME ? join(environment.HOME, '.codex') : null
  ])

  const scored: Array<{ directory: string; score: number; order: number }> = []
  for (const [order, directory] of candidates.entries()) {
    if (!(await isDirectory(directory))) continue
    const namedCodex = basename(directory).toLowerCase() === '.codex'
    const hasAuth = await isFile(join(directory, 'auth.json'))
    const hasConfig = await isFile(join(directory, 'config.toml'))
    const explicitEnvironment = Boolean(
      environment.CODEX_HOME &&
      resolve(directory).toLowerCase() === resolve(environment.CODEX_HOME).toLowerCase()
    )
    if (!namedCodex && !hasAuth && !hasConfig && !explicitEnvironment) continue
    let score = namedCodex ? 20 : 0
    if (hasAuth) score += 100
    if (hasConfig) score += 50
    if (explicitEnvironment) score += 200
    scored.push({ directory, score, order })
  }
  scored.sort((left, right) => right.score - left.score || left.order - right.order)
  return scored[0]?.directory ?? null
}

export async function normalizeSelectedCodexDirectory(selectedDirectory: string): Promise<string> {
  const selected = resolve(selectedDirectory)
  if (basename(selected).toLowerCase() === '.codex') return selected
  const child = join(selected, '.codex')
  return (await isDirectory(child)) ? child : selected
}
