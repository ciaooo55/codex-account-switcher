import type { CustomApiProfileInput, CustomApiProfileSummary, SecretCipher } from '../../shared/types'
import { randomBytes } from 'node:crypto'
import { atomicWriteFile, readUtf8File } from './atomic-file'

interface StoredProfile {
  version: 1
  encryptedKey: string
  models?: string[]
  encryptedGatewayToken?: string
}

function normalizeModels(values: readonly string[]): string[] {
  const seen = new Set<string>()
  return values.flatMap((value) => {
    const model = value.trim()
    if (!model || model.length > 128 || !/^[A-Za-z0-9._:/-]+$/.test(model) || seen.has(model)) return []
    seen.add(model)
    return [model]
  }).slice(0, 500)
}

export class CustomApiStore {
  constructor(
    private readonly path: string,
    private readonly cipher: SecretCipher
  ) {}

  async saveKey(key: string): Promise<void> {
    const value = key.trim()
    if (!value || value.length > 16_384) throw new Error('API Key 不能为空或过长')
    const previous = await this.readStored()
    const stored: StoredProfile = {
      version: 1,
      encryptedKey: this.cipher.encrypt(value),
      ...(previous?.models ? { models: previous.models } : {}),
      ...(previous?.encryptedGatewayToken ? { encryptedGatewayToken: previous.encryptedGatewayToken } : {})
    }
    await atomicWriteFile(this.path, `${JSON.stringify(stored, null, 2)}\n`)
  }

  async saveModels(models: readonly string[]): Promise<void> {
    const stored = await this.readStored()
    if (!stored?.encryptedKey) throw new Error('请先保存 API Key')
    await atomicWriteFile(this.path, `${JSON.stringify({
      version: 1,
      encryptedKey: stored.encryptedKey,
      models: normalizeModels(models),
      ...(stored.encryptedGatewayToken ? { encryptedGatewayToken: stored.encryptedGatewayToken } : {})
    } satisfies StoredProfile, null, 2)}\n`)
  }

  private async readStored(): Promise<StoredProfile | null> {
    try {
      const stored = JSON.parse(await readUtf8File(this.path)) as StoredProfile
      if (stored.version !== 1 || !stored.encryptedKey) return null
      return stored
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('已保存的自定义 API 配置无法读取，请重新填写')
    }
  }

  async getKey(): Promise<string | null> {
    try {
      const stored = await this.readStored()
      if (!stored) return null
      return this.cipher.decrypt(stored.encryptedKey)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('已保存的自定义 API Key 无法解密，请重新填写')
    }
  }

  async getOrCreateGatewayToken(apiKey?: string): Promise<string> {
    const stored = await this.readStored()
    if (stored?.encryptedGatewayToken) return this.cipher.decrypt(stored.encryptedGatewayToken)
    const key = apiKey?.trim()
    if (!stored?.encryptedKey && !key) throw new Error('请先保存 API Key')
    const token = `cas-gateway-${randomBytes(24).toString('base64url')}`
    await atomicWriteFile(this.path, `${JSON.stringify({
      version: 1,
      encryptedKey: stored?.encryptedKey ?? this.cipher.encrypt(key!),
      ...(stored?.models ? { models: stored.models } : {}),
      encryptedGatewayToken: this.cipher.encrypt(token)
    } satisfies StoredProfile, null, 2)}\n`)
    return token
  }

  async summary(input: Pick<CustomApiProfileInput, 'baseUrl' | 'model'>): Promise<CustomApiProfileSummary> {
    const stored = await this.readStored()
    let hasApiKey = false
    if (stored) {
      try {
        hasApiKey = Boolean(this.cipher.decrypt(stored.encryptedKey))
      } catch {
        throw new Error('已保存的自定义 API Key 无法解密，请重新填写')
      }
    }
    return {
      ...input,
      hasApiKey,
      models: normalizeModels(stored?.models ?? [])
    }
  }
}
