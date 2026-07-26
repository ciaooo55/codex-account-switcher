import type { SecretCipher } from '../../shared/types'
import {
  DEFAULT_LOCAL_API_SERVER_PORT,
  DEFAULT_LOCAL_API_MAX_CONCURRENT_MEDIA_REQUESTS,
  DEFAULT_LOCAL_API_MAX_RETRY_SOURCES,
  DEFAULT_LOCAL_API_REQUEST_TIMEOUT_MS,
  DEFAULT_LOCAL_API_RETRY_DELAY_MS,
  normalizeLocalApiServerConfig,
  type ApiUpstreamSummary,
  type CodexLocalApiBinding,
  type CredentialSourceInput,
  type LocalApiAccessKeySummary,
  type LocalApiServerConfigInput,
  type LocalApiServerConfigSummary,
  type LocalApiServerRuntimeConfig
} from '../../shared/api-server'
import { atomicWriteFile, readUtf8File } from './atomic-file'

interface StoredAccessKey {
  id: string
  label: string
  enabled: boolean
  allowedModels: string[]
  allowedSourceIds?: string[]
  encryptedKey: string
}

interface StoredUpstream {
  id: string
  name: string
  baseUrl: string
  protocol: import('../../shared/api-server').ApiUpstreamProtocol
  models: string[]
  priority: number
  enabled: boolean
  encryptedApiKey?: string
  authMode?: import('../../shared/api-server').ApiUpstreamAuthMode
  authHeaderName?: string
  authHeaderPrefix?: string
  authQueryParam?: string
}

interface ApiServerFile {
  version: 1
  port: number
  autoStart: boolean
  requestTimeoutMs?: number
  maxRetrySources?: number
  retryDelayMs?: number
  maxConcurrentMediaRequests?: number
  sessionAffinity?: boolean
  accessKeys: StoredAccessKey[]
  upstreams: StoredUpstream[]
  credentialSources: CredentialSourceInput[]
  codexBinding: CodexLocalApiBinding | null
  routes: LocalApiServerConfigInput['routes']
}

const EMPTY_FILE: ApiServerFile = {
  version: 1,
  port: DEFAULT_LOCAL_API_SERVER_PORT,
  autoStart: false,
  requestTimeoutMs: DEFAULT_LOCAL_API_REQUEST_TIMEOUT_MS,
  maxRetrySources: DEFAULT_LOCAL_API_MAX_RETRY_SOURCES,
  retryDelayMs: DEFAULT_LOCAL_API_RETRY_DELAY_MS,
  maxConcurrentMediaRequests: DEFAULT_LOCAL_API_MAX_CONCURRENT_MEDIA_REQUESTS,
  sessionAffinity: true,
  accessKeys: [],
  upstreams: [],
  credentialSources: [],
  codexBinding: null,
  routes: []
}

function previewSecret(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return `${value.slice(0, 2)}••••`
  return `${value.slice(0, 5)}••••${value.slice(-4)}`
}

export class ApiServerStore {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly cipher: SecretCipher
  ) {}

  async save(input: LocalApiServerConfigInput): Promise<LocalApiServerConfigSummary> {
    const normalized = normalizeLocalApiServerConfig(input)
    let result: LocalApiServerConfigSummary | undefined
    await this.enqueueWrite(async () => {
      const previous = await this.readFile()
      const previousKeys = new Map(previous.accessKeys.map((entry) => [entry.id, entry.encryptedKey]))
      const previousUpstreams = new Map(previous.upstreams.map((entry) => [entry.id, entry.encryptedApiKey]))

      const accessKeys = normalized.accessKeys.map((entry): StoredAccessKey => {
        const encryptedKey = entry.key
          ? this.cipher.encrypt(entry.key)
          : previousKeys.get(entry.id)
        if (!encryptedKey) throw new Error(`访问密钥“${entry.label}”缺少密钥内容`)
        return {
          id: entry.id,
          label: entry.label,
          enabled: entry.enabled,
          allowedModels: entry.allowedModels,
          allowedSourceIds: entry.allowedSourceIds ?? [],
          encryptedKey
        }
      })

      const upstreams = normalized.upstreams.map((entry): StoredUpstream => {
        const encryptedApiKey = entry.apiKey === undefined
          ? previousUpstreams.get(entry.id)
          : entry.apiKey ? this.cipher.encrypt(entry.apiKey) : undefined
        return {
          id: entry.id,
          name: entry.name,
          baseUrl: entry.baseUrl,
          protocol: entry.protocol,
          models: entry.models,
          priority: entry.priority,
          enabled: entry.enabled,
          ...(encryptedApiKey ? { encryptedApiKey } : {}),
          authMode: entry.authMode ?? 'auto',
          ...(entry.authHeaderName ? { authHeaderName: entry.authHeaderName } : {}),
          ...(entry.authHeaderPrefix ? { authHeaderPrefix: entry.authHeaderPrefix } : {}),
          ...(entry.authQueryParam ? { authQueryParam: entry.authQueryParam } : {})
        }
      })

      const file: ApiServerFile = {
        version: 1,
        port: normalized.port,
        autoStart: normalized.autoStart,
        requestTimeoutMs: normalized.requestTimeoutMs,
        maxRetrySources: normalized.maxRetrySources,
        retryDelayMs: normalized.retryDelayMs,
        maxConcurrentMediaRequests: normalized.maxConcurrentMediaRequests,
        sessionAffinity: normalized.sessionAffinity,
        accessKeys,
        upstreams,
        credentialSources: normalized.credentialSources ?? [],
        codexBinding: normalized.codexBinding ?? null,
        routes: normalized.routes
      }
      await atomicWriteFile(this.path, `${JSON.stringify(file, null, 2)}\n`)
      result = this.toSummary(file)
    })
    if (!result) throw new Error('API 服务配置保存失败')
    return result
  }

  async summary(): Promise<LocalApiServerConfigSummary> {
    await this.writeQueue
    return this.toSummary(await this.readFile())
  }

  async runtimeConfig(): Promise<LocalApiServerRuntimeConfig> {
    await this.writeQueue
    const file = await this.readFile()
    try {
      return {
        port: file.port,
        autoStart: file.autoStart,
        requestTimeoutMs: file.requestTimeoutMs ?? DEFAULT_LOCAL_API_REQUEST_TIMEOUT_MS,
        maxRetrySources: file.maxRetrySources ?? DEFAULT_LOCAL_API_MAX_RETRY_SOURCES,
        retryDelayMs: file.retryDelayMs ?? DEFAULT_LOCAL_API_RETRY_DELAY_MS,
        maxConcurrentMediaRequests: file.maxConcurrentMediaRequests ?? DEFAULT_LOCAL_API_MAX_CONCURRENT_MEDIA_REQUESTS,
        sessionAffinity: file.sessionAffinity !== false,
        accessKeys: file.accessKeys.map((entry) => ({
          id: entry.id,
          label: entry.label,
          key: this.cipher.decrypt(entry.encryptedKey),
          enabled: entry.enabled,
          allowedModels: [...entry.allowedModels],
          allowedSourceIds: [...(entry.allowedSourceIds ?? [])]
        })),
        upstreams: file.upstreams.map((entry) => ({
          id: entry.id,
          name: entry.name,
          baseUrl: entry.baseUrl,
          apiKey: entry.encryptedApiKey ? this.cipher.decrypt(entry.encryptedApiKey) : '',
          protocol: entry.protocol,
          authMode: entry.authMode ?? 'auto',
          authHeaderName: entry.authHeaderName ?? '',
          authHeaderPrefix: entry.authHeaderPrefix ?? '',
          authQueryParam: entry.authQueryParam ?? 'api_key',
          models: [...entry.models],
          priority: entry.priority,
          enabled: entry.enabled
        })),
        credentialSources: (file.credentialSources ?? []).map((entry) => ({
          ...entry,
          models: [...entry.models]
        })),
        codexBinding: file.codexBinding ? { ...file.codexBinding } : null,
        routes: file.routes.map((route) => ({
          ...route,
          targets: route.targets.map((target) => ({ ...target }))
        }))
      }
    } catch {
      throw new Error('API 服务密钥无法解密，请重新配置对应密钥')
    }
  }

  /** Main-process-only secret lookup. Never include this value in summaries. */
  async getAccessKey(id: string): Promise<string | null> {
    await this.writeQueue
    const entry = (await this.readFile()).accessKeys.find((candidate) => candidate.id === id)
    if (!entry) return null
    try {
      return this.cipher.decrypt(entry.encryptedKey)
    } catch {
      throw new Error('项目访问密钥无法解密，请重新生成该密钥')
    }
  }

  /** Main-process-only secret lookup. Never include this value in summaries. */
  async getUpstreamKey(id: string): Promise<string | null> {
    await this.writeQueue
    const entry = (await this.readFile()).upstreams.find((candidate) => candidate.id === id)
    if (!entry?.encryptedApiKey) return null
    try {
      return this.cipher.decrypt(entry.encryptedApiKey)
    } catch {
      throw new Error('上游 API Key 无法解密，请重新配置该上游')
    }
  }

  private toSummary(file: ApiServerFile): LocalApiServerConfigSummary {
    const accessKeys: LocalApiAccessKeySummary[] = file.accessKeys.map((entry) => {
      let key = ''
      try { key = this.cipher.decrypt(entry.encryptedKey) } catch { /* only expose unusable state */ }
      return {
        id: entry.id,
        label: entry.label,
        enabled: entry.enabled,
        allowedModels: [...entry.allowedModels],
        allowedSourceIds: [...(entry.allowedSourceIds ?? [])],
        hasKey: Boolean(key),
        keyPreview: previewSecret(key),
        isShort: Boolean(key) && key.length < 20
      }
    })
    const upstreams: ApiUpstreamSummary[] = file.upstreams.map((entry) => {
      let apiKey = ''
      try { apiKey = entry.encryptedApiKey ? this.cipher.decrypt(entry.encryptedApiKey) : '' } catch { /* only expose unusable state */ }
      return {
        id: entry.id,
        name: entry.name,
        baseUrl: entry.baseUrl,
        protocol: entry.protocol,
        authMode: entry.authMode ?? 'auto',
        ...(entry.authHeaderName ? { authHeaderName: entry.authHeaderName } : {}),
        ...(entry.authHeaderPrefix ? { authHeaderPrefix: entry.authHeaderPrefix } : {}),
        ...(entry.authQueryParam ? { authQueryParam: entry.authQueryParam } : {}),
        models: [...entry.models],
        priority: entry.priority,
        enabled: entry.enabled,
        hasApiKey: Boolean(apiKey),
        keyPreview: previewSecret(apiKey)
      }
    })
    return {
      port: file.port,
      autoStart: file.autoStart,
      requestTimeoutMs: file.requestTimeoutMs ?? DEFAULT_LOCAL_API_REQUEST_TIMEOUT_MS,
      maxRetrySources: file.maxRetrySources ?? DEFAULT_LOCAL_API_MAX_RETRY_SOURCES,
      retryDelayMs: file.retryDelayMs ?? DEFAULT_LOCAL_API_RETRY_DELAY_MS,
      maxConcurrentMediaRequests: file.maxConcurrentMediaRequests ?? DEFAULT_LOCAL_API_MAX_CONCURRENT_MEDIA_REQUESTS,
      sessionAffinity: file.sessionAffinity !== false,
      accessKeys,
      upstreams,
      credentialSources: (file.credentialSources ?? []).map((entry) => ({
        ...entry,
        models: [...entry.models]
      })),
      codexBinding: file.codexBinding ? { ...file.codexBinding } : null,
      routes: file.routes.map((route) => ({
        ...route,
        targets: route.targets.map((target) => ({ ...target }))
      }))
    }
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const queued = this.writeQueue.then(operation)
    this.writeQueue = queued.catch(() => undefined)
    await queued
  }

  private async readFile(): Promise<ApiServerFile> {
    try {
      const parsed = JSON.parse(await readUtf8File(this.path)) as ApiServerFile
      if (parsed.version !== 1 || !Array.isArray(parsed.accessKeys) || !Array.isArray(parsed.upstreams) || !Array.isArray(parsed.routes)) {
        throw new Error('invalid api server config')
      }
      return {
        ...parsed,
        requestTimeoutMs: parsed.requestTimeoutMs ?? DEFAULT_LOCAL_API_REQUEST_TIMEOUT_MS,
        maxRetrySources: parsed.maxRetrySources ?? DEFAULT_LOCAL_API_MAX_RETRY_SOURCES,
        retryDelayMs: parsed.retryDelayMs ?? DEFAULT_LOCAL_API_RETRY_DELAY_MS,
        maxConcurrentMediaRequests: parsed.maxConcurrentMediaRequests ?? DEFAULT_LOCAL_API_MAX_CONCURRENT_MEDIA_REQUESTS,
        sessionAffinity: parsed.sessionAffinity !== false,
        credentialSources: Array.isArray(parsed.credentialSources) ? parsed.credentialSources : [],
        codexBinding: parsed.codexBinding && typeof parsed.codexBinding === 'object'
          ? parsed.codexBinding
          : null
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_FILE
      throw new Error('API 服务配置无法读取，请检查或重新保存配置')
    }
  }
}
