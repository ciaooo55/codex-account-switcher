import { randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  NormalizedCredential,
  SecretCipher,
  SwitchResult
} from '../../shared/types'
import {
  applyChatGptConfig,
  restoreManagedConfig,
  type ManagedConfigSnapshot
} from './config'

interface BackupPayload {
  createdAt: string
  authText: string | null
  configSnapshot: ManagedConfigSnapshot
}

interface BackupEnvelope {
  version: 1
  createdAt: string
  encrypted: string
}

interface SwitcherOptions {
  authPath: string
  configPath: string
  backupDir: string
  backupRetention: number
  cipher: SecretCipher
  validate?: (paths: { authPath: string; configPath: string }) => Promise<boolean>
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  await writeFile(temporaryPath, text, { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(temporaryPath, path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM') throw error
    const previousPath = `${path}.${randomUUID()}.previous`
    try {
      await rename(path, previousPath)
      await rename(temporaryPath, path)
      await rm(previousPath, { force: true })
    } catch (replacementError) {
      if (await exists(previousPath)) await rename(previousPath, path)
      throw replacementError
    }
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

interface AuthDocument {
  text: string
  externallyManaged: boolean
}

function authDocument(credential: NormalizedCredential): AuthDocument {
  if (!credential.idToken || !credential.refreshToken) {
    throw new Error(
      '该账号只有 access token，可用于 CPA/Sub2API 检测，但官方 Codex auth.json 登录必须同时包含 id_token 和 refresh_token'
    )
  }

  const document = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: credential.idToken,
      access_token: credential.accessToken,
      refresh_token: credential.refreshToken,
      account_id: credential.accountId
    },
    last_refresh: credential.lastRefresh ?? new Date().toISOString()
  }
  return {
    text: `${JSON.stringify(document, null, 2)}\n`,
    externallyManaged: false
  }
}

function validAuthDocument(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const auth = value as {
    auth_mode?: unknown
    tokens?: {
      id_token?: unknown
      access_token?: unknown
      refresh_token?: unknown
      account_id?: unknown
    }
  }
  const tokens = auth.tokens
  if (!tokens || typeof tokens !== 'object') return false
  if (typeof tokens.id_token !== 'string' || !tokens.id_token.trim()) return false
  if (typeof tokens.access_token !== 'string' || !tokens.access_token.trim()) return false
  if (typeof tokens.refresh_token !== 'string') return false
  return auth.auth_mode === 'chatgpt' && Boolean(tokens.refresh_token.trim())
}

export class CredentialSwitcher {
  private readonly validate: NonNullable<SwitcherOptions['validate']>

  constructor(private readonly options: SwitcherOptions) {
    this.validate =
      options.validate ??
      (async ({ authPath }) => {
        return validAuthDocument(JSON.parse(await readFile(authPath, 'utf8')))
      })
  }

  async switchTo(credential: NormalizedCredential): Promise<SwitchResult> {
    let previousAuth: string | null = null
    let previousConfig = ''
    let backupPath: string | null = null
    try {
      previousAuth = await readOptional(this.options.authPath)
      previousConfig = (await readOptional(this.options.configPath)) ?? ''
      const appliedConfig = applyChatGptConfig(previousConfig)
      backupPath = await this.writeBackup({
        createdAt: new Date().toISOString(),
        authText: previousAuth,
        configSnapshot: appliedConfig.snapshot
      })

      const auth = authDocument(credential)
      await writeAtomic(this.options.authPath, auth.text)
      await writeAtomic(this.options.configPath, appliedConfig.text)
      const valid = await this.validate({
        authPath: this.options.authPath,
        configPath: this.options.configPath
      })
      if (!valid) throw new Error('Codex 登录配置校验失败')

      await this.pruneBackups()
      return {
        ok: true,
        message: '账号切换完成',
        backupPath
      }
    } catch (error) {
      try {
        if (previousAuth === null) await rm(this.options.authPath, { force: true })
        else await writeAtomic(this.options.authPath, previousAuth)
        await writeAtomic(this.options.configPath, previousConfig)
      } catch {
        return {
          ok: false,
          message: '切换失败，且自动回滚未能完整完成，请从备份恢复',
          backupPath
        }
      }
      return {
        ok: false,
        message: error instanceof Error ? error.message : '账号切换失败',
        backupPath
      }
    }
  }

  async restoreLatest(): Promise<SwitchResult> {
    try {
      const backupPath = await this.latestBackupPath()
      if (!backupPath) return { ok: false, message: '没有可恢复的备份', backupPath: null }
      const payload = await this.readBackup(backupPath)
      return this.restorePayload(backupPath, payload, '已恢复上一个 Codex 配置')
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : '恢复失败',
        backupPath: null
      }
    }
  }

  async restoreApiMode(): Promise<SwitchResult> {
    try {
      for (const backupPath of await this.backupPaths()) {
        const payload = await this.readBackup(backupPath)
        if (this.isApiModeBackup(payload)) {
          return this.restorePayload(backupPath, payload, '已恢复原 API/代理模式')
        }
      }
      return { ok: false, message: '没有找到可恢复的 API/代理配置', backupPath: null }
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : '恢复 API/代理模式失败',
        backupPath: null
      }
    }
  }

  private async restorePayload(
    backupPath: string,
    payload: BackupPayload,
    message: string
  ): Promise<SwitchResult> {
    const currentConfig = (await readOptional(this.options.configPath)) ?? ''
    const restoredConfig = restoreManagedConfig(currentConfig, payload.configSnapshot)
    if (payload.authText === null) await rm(this.options.authPath, { force: true })
    else await writeAtomic(this.options.authPath, payload.authText)
    await writeAtomic(this.options.configPath, restoredConfig)
    return { ok: true, message, backupPath }
  }

  private isApiModeBackup(payload: BackupPayload): boolean {
    if (payload.authText) {
      try {
        const auth = JSON.parse(payload.authText) as {
          auth_mode?: unknown
          OPENAI_API_KEY?: unknown
        }
        if (typeof auth.auth_mode === 'string') {
          return auth.auth_mode.toLowerCase() !== 'chatgpt'
        }
        if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim()) return true
      } catch {
        // The config snapshot below can still identify the original provider mode.
      }
    }
    const provider = payload.configSnapshot.model_provider
    return Boolean(provider && !/^model_provider\s*=\s*["']openai["']$/i.test(provider))
  }

  private async writeBackup(payload: BackupPayload): Promise<string> {
    await mkdir(this.options.backupDir, { recursive: true })
    const safeTimestamp = payload.createdAt.replace(/[:.]/g, '-')
    const path = join(this.options.backupDir, `backup-${safeTimestamp}-${randomUUID()}.json`)
    const envelope: BackupEnvelope = {
      version: 1,
      createdAt: payload.createdAt,
      encrypted: this.options.cipher.encrypt(JSON.stringify(payload))
    }
    await writeAtomic(path, `${JSON.stringify(envelope, null, 2)}\n`)
    return path
  }

  private async readBackup(path: string): Promise<BackupPayload> {
    const envelope = JSON.parse(await readFile(path, 'utf8')) as BackupEnvelope
    if (envelope.version !== 1 || !envelope.encrypted) throw new Error('备份文件格式不受支持')
    return JSON.parse(this.options.cipher.decrypt(envelope.encrypted)) as BackupPayload
  }

  private async latestBackupPath(): Promise<string | null> {
    return (await this.backupPaths())[0] ?? null
  }

  private async backupPaths(): Promise<string[]> {
    try {
      const names = (await readdir(this.options.backupDir))
        .filter((name) => /^backup-.*\.json$/.test(name))
        .sort()
        .reverse()
      return names.map((name) => join(this.options.backupDir, name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async pruneBackups(): Promise<void> {
    const retention = Math.max(1, this.options.backupRetention)
    const names = (await readdir(this.options.backupDir))
      .filter((name) => /^backup-.*\.json$/.test(name))
      .sort()
      .reverse()
    await Promise.all(names.slice(retention).map((name) => rm(join(this.options.backupDir, name))))
  }
}
