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
import { serializeCodexCredential } from '../accounts/credential-formats'
import {
  applyChatGptConfig,
  applyCustomApiConfig,
  OWNED_PROVIDER_ID,
  restoreManagedConfig,
  type ManagedConfigSnapshot
} from './config'
import {
  buildModelCatalog,
  fetchOpenAiCompatibleModelIds,
  MODEL_CATALOG_RELATIVE_PATH,
  modelCatalogPath,
  probeCustomApiModel,
  writeModelCatalogFile
} from '../services/model-catalog'
import { allocateModelGatewaySlots, type ModelGatewaySlot } from '../services/custom-api-gateway'

interface BackupPayload {
  createdAt: string
  authText: string | null
  configSnapshot: ManagedConfigSnapshot
  /** Missing in legacy backups; null means the managed catalog did not exist. */
  managedCatalogText?: string | null
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
  catalogTimeoutMs?: number
  fetchModels?: (input: { baseUrl: string; apiKey: string }) => Promise<string[]>
  probeModel?: (input: { baseUrl: string; apiKey: string; model: string }) => Promise<{
    endpoint: 'responses' | 'chat_completions'
    baseUrl?: string
    probeUrl?: string
    output: string
  }>
  configureGateway?: (input: {
    upstreamBaseUrl: string
    upstreamApiKey: string
    slots: ModelGatewaySlot[]
  }) => Promise<{ baseUrl: string; token: string }>
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
    let replacementInstalled = false
    try {
      await rename(path, previousPath)
      await rename(temporaryPath, path)
      replacementInstalled = true
      await rm(previousPath, { force: true })
    } catch (replacementError) {
      if (replacementInstalled) await rm(path, { force: true })
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
  mode: 'oauth' | 'personal_access_token' | 'external'
}

function authDocument(credential: NormalizedCredential): AuthDocument {
  const document = serializeCodexCredential(credential)
  return {
    text: `${JSON.stringify(document.value, null, 2)}\n`,
    mode: document.mode
  }
}

function validAuthDocument(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const auth = value as {
    auth_mode?: unknown
    OPENAI_API_KEY?: unknown
    personal_access_token?: unknown
    tokens?: {
      id_token?: unknown
      access_token?: unknown
      refresh_token?: unknown
      account_id?: unknown
    }
  }
  if (
    typeof auth.personal_access_token === 'string' &&
    auth.personal_access_token.startsWith('at-') &&
    (auth.auth_mode === undefined || auth.auth_mode === 'personalAccessToken')
  ) return auth.OPENAI_API_KEY === null || auth.OPENAI_API_KEY === undefined
  const tokens = auth.tokens
  if (!tokens || typeof tokens !== 'object') return false
  if (typeof tokens.id_token !== 'string' || !tokens.id_token.trim()) return false
  if (typeof tokens.access_token !== 'string' || !tokens.access_token.trim()) return false
  if (typeof tokens.refresh_token !== 'string') return false
  if (auth.auth_mode !== 'chatgpt') return false
  return Boolean(tokens.refresh_token.trim()) || (
    tokens.refresh_token === '' &&
    typeof tokens.account_id === 'string' &&
    Boolean(tokens.account_id.trim())
  )
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
    let nextAuth: AuthDocument
    try {
      nextAuth = authDocument(credential)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : '账号凭据不兼容官方 Codex',
        backupPath: null
      }
    }
    let previousAuth: string | null = null
    let previousConfig = ''
    const catalogPath = modelCatalogPath(dirname(this.options.configPath))
    let previousCatalog: string | null = null
    let backupPath: string | null = null
    try {
      previousAuth = await readOptional(this.options.authPath)
      previousConfig = (await readOptional(this.options.configPath)) ?? ''
      previousCatalog = await readOptional(catalogPath)
      const appliedConfig = applyChatGptConfig(previousConfig)
      backupPath = await this.writeBackup({
        createdAt: new Date().toISOString(),
        authText: previousAuth,
        configSnapshot: appliedConfig.snapshot,
        managedCatalogText: previousCatalog
      })

      await writeAtomic(this.options.authPath, nextAuth.text)
      await writeAtomic(this.options.configPath, appliedConfig.text)
      const valid = await this.validate({
        authPath: this.options.authPath,
        configPath: this.options.configPath
      })
      if (!valid) throw new Error('Codex 登录配置校验失败')
      await rm(catalogPath, { force: true })

      await this.pruneBackups()
      return {
        ok: true,
        message: nextAuth.mode === 'personal_access_token'
          ? 'Personal Access Token 已按官方格式写入，请重启 Codex 后生效'
          : nextAuth.mode === 'external'
            ? 'Team/K12 外部凭据已写入，请重启 Codex 后生效；该模式不会自动刷新 token'
            : '账号切换完成',
        backupPath
      }
    } catch (error) {
      try {
        if (previousAuth === null) await rm(this.options.authPath, { force: true })
        else await writeAtomic(this.options.authPath, previousAuth)
        if (previousCatalog === null) await rm(catalogPath, { force: true })
        else await writeAtomic(catalogPath, previousCatalog)
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

  async switchToCustomApi(input: {
    baseUrl: string
    model: string
    apiKey: string
    models?: string[]
    syncModelCatalog?: boolean
    verifiedProbe?: {
      endpoint: 'responses'
      baseUrl: string
      probeUrl: string
      output: string
    }
    forceProbeFailure?: string
  }): Promise<SwitchResult> {
    const previousAuth = await readOptional(this.options.authPath)
    const previousConfig = (await readOptional(this.options.configPath)) ?? ''
    const catalogPath = modelCatalogPath(dirname(this.options.configPath))
    const previousCatalog = await readOptional(catalogPath)
    let backupPath: string | null = null
    let wroteFiles = false
    try {
      if (!input.apiKey.trim()) throw new Error('请填写自定义 API Key')
      const model = input.model.trim()
      if (!model) throw new Error('请先选择要进行真实测试的模型')

      // A successful HTTP status is not enough. The selected model must answer `hi`
      // with a real, non-empty Responses payload before any local file is changed.
      let discoveredBaseUrl = input.baseUrl
      const forcedWarning = input.forceProbeFailure?.trim() ?? ''
      const probe = input.verifiedProbe ?? (forcedWarning
        ? {
            endpoint: 'responses' as const,
            baseUrl: input.baseUrl,
            probeUrl: '/responses（测试失败后强制）',
            output: ''
          }
        : (this.options.probeModel
        ? await this.options.probeModel({
            baseUrl: discoveredBaseUrl,
            apiKey: input.apiKey,
            model
          })
        : await probeCustomApiModel({
            baseUrl: discoveredBaseUrl,
            apiKey: input.apiKey,
            model,
            timeoutMs: this.options.catalogTimeoutMs
          })))
      if (typeof probe.baseUrl === 'string' && probe.baseUrl.trim()) {
        discoveredBaseUrl = probe.baseUrl
      }
      const probeOutput = probe.output.trim()
      if (!probeOutput && !forcedWarning) throw new Error('真实 hi 测试没有返回可读内容')

      let remoteModels: string[] = []
      try {
        if (this.options.fetchModels) {
          remoteModels = await this.options.fetchModels({
            baseUrl: discoveredBaseUrl,
            apiKey: input.apiKey
          })
        } else {
          const listed = await fetchOpenAiCompatibleModelIds({
            baseUrl: discoveredBaseUrl,
            apiKey: input.apiKey,
            timeoutMs: this.options.catalogTimeoutMs
          })
          remoteModels = listed.models
          if (listed.baseUrl.trim()) discoveredBaseUrl = listed.baseUrl
        }
      } catch {
        remoteModels = []
      }

      // Explicit models are the edited list from the UI. Do not add back models the
      // user removed; buildModelCatalog only guarantees the selected model remains.
      const syncModelCatalog = input.syncModelCatalog !== false
      const sourceCatalog = buildModelCatalog(
        input.models === undefined ? remoteModels : input.models,
        model
      )
      const sourceModels = sourceCatalog.models.map((entry) => entry.slug)
      let configBaseUrl = discoveredBaseUrl
      let configApiKey = input.apiKey
      let configuredModel = model
      let catalog = syncModelCatalog ? sourceCatalog : null
      let writtenCatalogModels = catalog?.models.map((entry) => entry.slug) ?? []
      if (syncModelCatalog && this.options.configureGateway) {
        const slots = allocateModelGatewaySlots(sourceModels)
        const selectedSlot = slots.find((slot) => slot.upstreamModel.toLowerCase() === model.toLowerCase())
        if (!selectedSlot) throw new Error('无法为选中模型分配 Codex 模型壳')
        const gateway = await this.options.configureGateway({
          upstreamBaseUrl: discoveredBaseUrl,
          upstreamApiKey: input.apiKey,
          slots
        })
        configBaseUrl = gateway.baseUrl
        configApiKey = gateway.token
        configuredModel = selectedSlot.clientModel
        catalog = buildModelCatalog(
          slots.map((slot) => slot.clientModel),
          configuredModel,
          new Map(slots.map((slot) => [slot.clientModel.toLowerCase(), slot.upstreamModel]))
        )
        writtenCatalogModels = catalog.models.map((entry) => entry.slug)
      }
      const appliedConfig = applyCustomApiConfig(previousConfig, {
        baseUrl: configBaseUrl,
        model: configuredModel,
        apiKey: configApiKey,
        syncModelCatalog
      })
      backupPath = await this.writeBackup({
        createdAt: new Date().toISOString(),
        authText: previousAuth,
        configSnapshot: appliedConfig.snapshot,
        managedCatalogText: previousCatalog
      })

      // Catalog first, config reference last. Codex never sees a reference to an
      // absent or partially written JSON file.
      if (catalog) await writeModelCatalogFile(catalogPath, catalog)
      else await rm(catalogPath, { force: true })
      wroteFiles = true
      const authText = `${JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: input.apiKey }, null, 2)}\n`
      await writeAtomic(this.options.authPath, authText)
      await writeAtomic(this.options.configPath, appliedConfig.text)

      const written = JSON.parse(await readFile(this.options.authPath, 'utf8')) as {
        OPENAI_API_KEY?: unknown
      }
      if (typeof written.OPENAI_API_KEY !== 'string' || !written.OPENAI_API_KEY.trim()) {
        throw new Error('API Key 配置校验失败')
      }
      const writtenConfig = await readFile(this.options.configPath, 'utf8')
      const requiredProviderLines = [
        `model_provider = ${JSON.stringify(OWNED_PROVIDER_ID)}`,
        `[model_providers.${OWNED_PROVIDER_ID}]`,
        'wire_api = "responses"',
        'requires_openai_auth = true',
        `experimental_bearer_token = ${JSON.stringify(configApiKey)}`,
        'supports_websockets = false'
      ]
      if (syncModelCatalog) {
        requiredProviderLines.push(
          `model_catalog_json = ${JSON.stringify(MODEL_CATALOG_RELATIVE_PATH)}`
        )
      }
      if (requiredProviderLines.some((line) => !writtenConfig.includes(line))) {
        throw new Error('第三方 API provider 或模型目录配置校验失败')
      }
      if (/^\s*openai_base_url\s*=/m.test(writtenConfig)) {
        throw new Error('第三方 API 不得与 openai_base_url 混用')
      }
      if (syncModelCatalog) {
        const writtenCatalog = JSON.parse(await readFile(catalogPath, 'utf8')) as {
          models?: Array<{ slug?: unknown; base_instructions?: unknown }>
        }
        const writtenModels = Array.isArray(writtenCatalog.models) ? writtenCatalog.models : []
        if (
        writtenModels.length !== writtenCatalogModels.length ||
        writtenModels.some((entry, index) =>
            entry.slug !== writtenCatalogModels[index] ||
            typeof entry.base_instructions !== 'string' ||
            !entry.base_instructions.trim()
          )
        ) {
          throw new Error('Codex 模型目录内容复检失败')
        }
      }

      await this.pruneBackups()
      const probePath = typeof probe.probeUrl === 'string'
        ? probe.probeUrl
        : probe.endpoint === 'responses' ? '/responses' : '/chat/completions'
      const outputPreview = probeOutput.replace(/\s+/g, ' ').slice(0, 160)
      const modelNote = remoteModels.length > 0
        ? `；上游发现 ${remoteModels.length} 个模型`
        : '；上游模型列表为空'
      return {
        ok: true,
        message: forcedWarning
          ? `警告：API 真实 hi 测试未通过，已按用户确认强制切换；${syncModelCatalog ? `已同步 ${sourceModels.length} 个模型到 Codex` : '未导入模型目录'}${modelNote}`
          : `已向 ${probePath} 发送 hi，模型返回“${outputPreview}”；${syncModelCatalog ? `已同步 ${sourceModels.length} 个模型到 Codex` : '未导入模型目录'}${modelNote}`,
        backupPath,
        selectedModel: model,
        discoveredBaseUrl,
        remoteModels,
        catalogModels: syncModelCatalog ? sourceModels : [],
        ...(probeOutput ? { probeOutput } : {}),
        ...(forcedWarning ? { warning: forcedWarning } : {})
      }
    } catch (error) {
      if (!wroteFiles) {
        return {
          ok: false,
          message: error instanceof Error
            ? `自定义 API 测试未通过，未保存配置：${error.message}`
            : '自定义 API 测试未通过，未保存配置',
          backupPath
        }
      }
      try {
        if (previousAuth === null) await rm(this.options.authPath, { force: true })
        else await writeAtomic(this.options.authPath, previousAuth)
        if (previousCatalog === null) await rm(catalogPath, { force: true })
        else await writeAtomic(catalogPath, previousCatalog)
        await writeAtomic(this.options.configPath, previousConfig)
      } catch {
        return { ok: false, message: '自定义 API 切换失败，且自动回滚未完整完成', backupPath }
      }
      return {
        ok: false,
        message: error instanceof Error
          ? `自定义 API 切换失败，已回滚：${error.message}`
          : '自定义 API 切换失败，已回滚',
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
    const currentAuth = await readOptional(this.options.authPath)
    const currentConfig = (await readOptional(this.options.configPath)) ?? ''
    const catalogPath = modelCatalogPath(dirname(this.options.configPath))
    const currentCatalog = await readOptional(catalogPath)
    const restoredConfig = restoreManagedConfig(currentConfig, payload.configSnapshot)
    try {
      if (payload.authText === null) await rm(this.options.authPath, { force: true })
      else await writeAtomic(this.options.authPath, payload.authText)
      if (payload.managedCatalogText !== undefined) {
        if (payload.managedCatalogText === null) await rm(catalogPath, { force: true })
        else await writeAtomic(catalogPath, payload.managedCatalogText)
      }
      await writeAtomic(this.options.configPath, restoredConfig)
      return { ok: true, message, backupPath }
    } catch (error) {
      try {
        if (currentAuth === null) await rm(this.options.authPath, { force: true })
        else await writeAtomic(this.options.authPath, currentAuth)
        if (currentCatalog === null) await rm(catalogPath, { force: true })
        else await writeAtomic(catalogPath, currentCatalog)
        await writeAtomic(this.options.configPath, currentConfig)
      } catch {
        return {
          ok: false,
          message: '恢复失败，且自动回滚未能完整完成，请从加密备份手动恢复',
          backupPath
        }
      }
      return {
        ok: false,
        message: error instanceof Error ? `恢复失败，已回滚：${error.message}` : '恢复失败，已回滚',
        backupPath
      }
    }
  }

  private isApiModeBackup(payload: BackupPayload): boolean {
    if (payload.authText) {
      try {
        const auth = JSON.parse(payload.authText) as {
          auth_mode?: unknown
          OPENAI_API_KEY?: unknown
        }
        if (typeof auth.auth_mode === 'string') {
          const mode = auth.auth_mode.toLowerCase()
          return mode !== 'chatgpt' && mode !== 'chatgptauthtokens'
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
