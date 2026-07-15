import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AppSettings } from '../../shared/types'

function defaults(homeDirectory: string): AppSettings {
  return {
    accountDirectory: 'E:\\home\\lee\\.cli-proxy-api',
    authPath: join(homeDirectory, '.codex', 'auth.json'),
    configPath: join(homeDirectory, '.codex', 'config.toml'),
    concurrency: 4,
    timeoutMs: 30_000,
    backupRetention: 20,
    deepTestModel: 'gpt-5.4'
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

function normalize(value: AppSettings): AppSettings {
  return {
    accountDirectory: value.accountDirectory.trim(),
    authPath: value.authPath.trim(),
    configPath: value.configPath.trim(),
    concurrency: clamp(value.concurrency, 1, 12),
    timeoutMs: clamp(value.timeoutMs, 1_000, 120_000),
    backupRetention: clamp(value.backupRetention, 1, 100),
    deepTestModel: value.deepTestModel.trim() || 'gpt-5.4'
  }
}

async function atomicWrite(path: string, settings: AppSettings): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  try {
    await rename(temporaryPath, path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM') throw error
    await rm(path, { force: true })
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

export class SettingsStore {
  constructor(
    private readonly path: string,
    private readonly homeDirectory: string
  ) {}

  async get(): Promise<AppSettings> {
    const fallback = defaults(this.homeDirectory)
    try {
      const stored = JSON.parse(await readFile(this.path, 'utf8')) as Partial<AppSettings>
      return normalize({ ...fallback, ...stored })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
      throw error
    }
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = normalize({ ...(await this.get()), ...patch })
    if (!next.accountDirectory || !next.authPath || !next.configPath) {
      throw new Error('账号目录和 Codex 路径不能为空')
    }
    await atomicWrite(this.path, next)
    return next
  }
}

