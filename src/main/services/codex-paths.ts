import { stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

interface CodexPathDiscoveryOptions {
  homeDirectory: string
  configuredAuthPath: string
  configuredConfigPath: string
  environment?: NodeJS.ProcessEnv
}

export interface DiscoveredCodexPaths {
  authPath: string
  configPath: string
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

function standardPaths(directory: string): DiscoveredCodexPaths {
  return {
    authPath: join(directory, 'auth.json'),
    configPath: join(directory, 'config.toml')
  }
}

export async function discoverCodexPaths(
  options: CodexPathDiscoveryOptions
): Promise<DiscoveredCodexPaths | null> {
  const environment = options.environment ?? process.env
  if (environment.CODEX_HOME?.trim()) {
    return standardPaths(resolve(environment.CODEX_HOME.trim()))
  }

  const configured = {
    authPath: resolve(options.configuredAuthPath),
    configPath: resolve(options.configuredConfigPath)
  }
  const configuredAuthDirectory = dirname(configured.authPath)
  const configuredConfigDirectory = dirname(configured.configPath)
  const configuredAuthExists = await isFile(configured.authPath)
  const configuredConfigExists = await isFile(configured.configPath)
  const configuredDirectoriesExist =
    await isDirectory(configuredAuthDirectory) &&
    await isDirectory(configuredConfigDirectory)
  if (configuredAuthExists || configuredConfigExists || configuredDirectoriesExist) {
    return configured
  }

  const fallbackDirectories = [
    join(options.homeDirectory, '.codex'),
    environment.USERPROFILE ? join(environment.USERPROFILE, '.codex') : null,
    environment.HOME ? join(environment.HOME, '.codex') : null
  ]
  const seen = new Set<string>()
  for (const value of fallbackDirectories) {
    if (!value) continue
    const directory = resolve(value)
    if (seen.has(directory.toLowerCase())) continue
    seen.add(directory.toLowerCase())
    if (await isDirectory(directory)) return standardPaths(directory)
  }
  return null
}

export async function discoverCodexDirectory(
  options: CodexPathDiscoveryOptions
): Promise<string | null> {
  const paths = await discoverCodexPaths(options)
  if (!paths) return null
  const authDirectory = dirname(paths.authPath)
  const configDirectory = dirname(paths.configPath)
  return authDirectory.toLowerCase() === configDirectory.toLowerCase()
    ? authDirectory
    : null
}

export async function normalizeSelectedCodexDirectory(selectedDirectory: string): Promise<string> {
  const selected = resolve(selectedDirectory)
  if (basename(selected).toLowerCase() === '.codex') return selected
  const child = join(selected, '.codex')
  return (await isDirectory(child)) ? child : selected
}
