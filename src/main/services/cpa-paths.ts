import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path'

interface CpaPathDiscoveryOptions {
  homeDirectory: string
  configuredDirectory: string
  applicationDirectory?: string
  environment?: NodeJS.ProcessEnv
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() } catch { return false }
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function expandHome(path: string, homeDirectory: string): string {
  if (path === '~') return homeDirectory
  if (/^~[\\/]/.test(path)) return join(homeDirectory, path.slice(2))
  return path
}

export async function readCpaAuthDirectoryFromConfig(
  configPath: string,
  homeDirectory: string
): Promise<string | null> {
  try {
    const text = await readFile(configPath, 'utf8')
    const match = text.match(/^\s*auth-dir\s*:\s*([^#\r\n]+?)\s*$/mi)
    if (!match) return null
    const expanded = expandHome(unquote(match[1]), homeDirectory)
    return resolve(isAbsolute(expanded) || win32.isAbsolute(expanded) ? expanded : join(dirname(configPath), expanded))
  } catch {
    return null
  }
}

export async function discoverCpaDirectory(options: CpaPathDiscoveryOptions): Promise<string | null> {
  const environment = options.environment ?? process.env
  const environmentCandidates = [
    environment.CLI_PROXY_AUTH_PATH,
    environment.CLI_PROXY_AUTH_DIR
  ].filter((value): value is string => Boolean(value?.trim()))
  for (const value of environmentCandidates) {
    const candidate = resolve(expandHome(value.trim(), options.homeDirectory))
    if (await isDirectory(candidate)) return candidate
  }

  const configCandidates = [
    environment.CLI_PROXY_CONFIG_PATH,
    options.applicationDirectory ? join(options.applicationDirectory, 'config.yaml') : null,
    join(options.homeDirectory, '.cli-proxy-api', 'config.yaml')
  ].filter((value): value is string => Boolean(value))
  for (const configPath of configCandidates) {
    if (!(await isFile(configPath))) continue
    const authDirectory = await readCpaAuthDirectoryFromConfig(configPath, options.homeDirectory)
    if (authDirectory && await isDirectory(authDirectory)) return authDirectory
  }

  if (options.configuredDirectory.trim()) {
    const configured = resolve(expandHome(options.configuredDirectory.trim(), options.homeDirectory))
    if (await isDirectory(configured)) return configured
  }

  const accountName = win32.basename(win32.normalize(options.homeDirectory)) || 'user'
  const standardCandidates = [
    join(options.homeDirectory, '.cli-proxy-api'),
    win32.join('E:\\home', accountName, '.cli-proxy-api')
  ]
  for (const candidate of standardCandidates) {
    if (await isDirectory(candidate)) return resolve(candidate)
  }
  return null
}
