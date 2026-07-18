import { join, win32 } from 'node:path'
import { z } from 'zod'
import { normalizeCustomApiBaseUrl } from '../../shared/custom-api'
import type { AppSettings } from '../../shared/types'
import { atomicWriteFile, readUtf8File } from './atomic-file'

const storedSettingsSchema = z.object({
  accountDirectory: z.string().max(32_767).optional(),
  authPath: z.string().max(32_767).optional(),
  configPath: z.string().max(32_767).optional(),
  concurrency: z.number().finite().optional(),
  timeoutMs: z.number().finite().optional(),
  backupRetention: z.number().finite().optional(),
  deepTestModel: z.string().max(128).optional(),
  autoSwitchEnabled: z.boolean().optional(),
  autoSwitchIntervalSeconds: z.number().finite().optional(),
  autoSwitchAccountIds: z.array(z.string()).max(20_000).optional(),
  autoSwitchRestartCodex: z.boolean().optional(),
  grokDirectory: z.string().max(32_767).optional(),
  customApiBaseUrl: z.string().max(2048).optional(),
  customApiModel: z.string().max(128).optional()
})

function defaults(homeDirectory: string): AppSettings {
  const accountName = win32.basename(win32.normalize(homeDirectory)) || 'user'
  return {
    accountDirectory: win32.join('E:\\home', accountName, '.cli-proxy-api'),
    authPath: join(homeDirectory, '.codex', 'auth.json'),
    configPath: join(homeDirectory, '.codex', 'config.toml'),
    concurrency: 4,
    timeoutMs: 30_000,
    backupRetention: 20,
    deepTestModel: 'gpt-5.4',
    autoSwitchEnabled: false,
    autoSwitchIntervalSeconds: 300,
    autoSwitchAccountIds: [],
    autoSwitchRestartCodex: true,
    grokDirectory: win32.join('E:\\home', accountName, '.cli-proxy-api'),
    customApiBaseUrl: 'https://api.openai.com/v1',
    customApiModel: 'gpt-5.4'
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

function windowsPath(value: string, label: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label}不能为空`)
  if (trimmed.length > 32_767 || !win32.isAbsolute(trimmed)) {
    throw new Error(`${label}必须是有效的 Windows 绝对路径`)
  }
  return win32.normalize(trimmed)
}

function normalize(value: AppSettings): AppSettings {
  const accountDirectory = windowsPath(value.accountDirectory, '账号目录')
  const authPath = windowsPath(value.authPath, 'auth.json 路径')
  const configPath = windowsPath(value.configPath, 'config.toml 路径')
  if (win32.basename(authPath).toLowerCase() !== 'auth.json') {
    throw new Error('Codex 凭据路径必须指向 auth.json')
  }
  if (win32.basename(configPath).toLowerCase() !== 'config.toml') {
    throw new Error('Codex 配置路径必须指向 config.toml')
  }
  if (authPath.toLowerCase() === configPath.toLowerCase()) {
    throw new Error('auth.json 与 config.toml 不能使用同一路径')
  }
  const deepTestModel = value.deepTestModel.trim() || 'gpt-5.4'
  if (deepTestModel.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(deepTestModel)) {
    throw new Error('深度检测模型名称格式无效')
  }
  const grokDirectory = windowsPath(value.grokDirectory, 'Grok 账号目录')
  const customApiBaseUrl = normalizeCustomApiBaseUrl(value.customApiBaseUrl)
  const customApiModel = value.customApiModel.trim() || 'gpt-5.4'
  if (customApiModel.length > 128 || !/^[A-Za-z0-9._:/-]+$/.test(customApiModel)) {
    throw new Error('自定义 API 模型名称格式无效')
  }
  return {
    accountDirectory,
    authPath,
    configPath,
    concurrency: clamp(value.concurrency, 1, 12),
    timeoutMs: clamp(value.timeoutMs, 1_000, 120_000),
    backupRetention: clamp(value.backupRetention, 1, 100),
    deepTestModel,
    autoSwitchEnabled: Boolean(value.autoSwitchEnabled),
    autoSwitchIntervalSeconds: clamp(value.autoSwitchIntervalSeconds, 5, 86_400),
    autoSwitchAccountIds: [...new Set(value.autoSwitchAccountIds.filter((id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)))].slice(0, 20_000),
    autoSwitchRestartCodex: Boolean(value.autoSwitchRestartCodex),
    grokDirectory,
    customApiBaseUrl,
    customApiModel
  }
}

export class SettingsStore {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly homeDirectory: string
  ) {}

  async get(): Promise<AppSettings> {
    await this.writeQueue
    return this.getUnlocked()
  }

  private async getUnlocked(): Promise<AppSettings> {
    const fallback = defaults(this.homeDirectory)
    try {
      const result = storedSettingsSchema.safeParse(JSON.parse(await readUtf8File(this.path)))
      if (!result.success) throw new Error('设置文件格式损坏，请修正或移走 settings.json')
      const stored = result.data
      return normalize({ ...fallback, ...stored })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
      throw error
    }
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    let updated: AppSettings | null = null
    const operation = this.writeQueue.then(async () => {
      const next = normalize({ ...(await this.getUnlocked()), ...patch })
      await atomicWriteFile(this.path, `${JSON.stringify(next, null, 2)}\n`)
      updated = next
    })
    this.writeQueue = operation.catch(() => undefined)
    await operation
    return updated!
  }
}
