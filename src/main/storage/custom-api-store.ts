import type { CustomApiProfileInput, CustomApiProfileSummary, SecretCipher } from '../../shared/types'
import { atomicWriteFile, readUtf8File } from './atomic-file'

interface StoredProfile {
  version: 1
  encryptedKey: string
}

export class CustomApiStore {
  constructor(
    private readonly path: string,
    private readonly cipher: SecretCipher
  ) {}

  async saveKey(key: string): Promise<void> {
    const value = key.trim()
    if (!value || value.length > 16_384) throw new Error('API Key 不能为空或过长')
    const stored: StoredProfile = { version: 1, encryptedKey: this.cipher.encrypt(value) }
    await atomicWriteFile(this.path, `${JSON.stringify(stored, null, 2)}\n`)
  }

  async getKey(): Promise<string | null> {
    try {
      const stored = JSON.parse(await readUtf8File(this.path)) as StoredProfile
      if (stored.version !== 1 || !stored.encryptedKey) return null
      return this.cipher.decrypt(stored.encryptedKey)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw new Error('已保存的自定义 API Key 无法解密，请重新填写')
    }
  }

  async summary(input: Omit<CustomApiProfileInput, 'apiKey'>): Promise<CustomApiProfileSummary> {
    return { ...input, hasApiKey: Boolean(await this.getKey()) }
  }
}
