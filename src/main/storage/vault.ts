import type { NormalizedCredential, SecretCipher } from '../../shared/types'
import { atomicWriteFile, readUtf8File } from './atomic-file'
import { normalizedCredentialSchema } from './schemas'

interface VaultFile {
  version: 1
  entries: Array<{ id: string; encrypted: string }>
}

const EMPTY_VAULT: VaultFile = { version: 1, entries: [] }

export class CredentialVault {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly cipher: SecretCipher
  ) {}

  async list(): Promise<NormalizedCredential[]> {
    await this.writeQueue
    return this.listUnlocked()
  }

  private async listUnlocked(): Promise<NormalizedCredential[]> {
    const file = await this.readVault()
    const credentials: NormalizedCredential[] = []
    for (const entry of file.entries) {
      try {
        const raw = JSON.parse(this.cipher.decrypt(entry.encrypted)) as Record<string, unknown>
        const parsed = normalizedCredentialSchema.safeParse({
          ...raw,
          sourceDialect: raw.sourceDialect ?? 'generic'
        })
        if (parsed.success && parsed.data.id === entry.id) credentials.push(parsed.data)
      } catch {
        // A corrupt entry must not prevent access to the rest of the local vault.
      }
    }
    return credentials
  }

  async get(id: string): Promise<NormalizedCredential | null> {
    return (await this.list()).find((credential) => credential.id === id) ?? null
  }

  async upsertMany(credentials: NormalizedCredential[]): Promise<void> {
    if (credentials.length === 0) return
    await this.enqueueWrite(async () => {
      const existing = new Map(
        (await this.listUnlocked()).map((credential) => [credential.id, credential])
      )
      for (const credential of credentials) existing.set(credential.id, credential)
      await this.writeCredentials([...existing.values()])
    })
  }

  async replace(credentials: NormalizedCredential[]): Promise<void> {
    await this.enqueueWrite(() => this.writeCredentials(credentials))
  }

  async removeMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await this.enqueueWrite(async () => {
      const removeIds = new Set(ids)
      await this.writeCredentials(
        (await this.listUnlocked()).filter((credential) => !removeIds.has(credential.id))
      )
    })
  }

  private async writeCredentials(credentials: readonly NormalizedCredential[]): Promise<void> {
    const file: VaultFile = {
      version: 1,
      entries: credentials.map((credential) => ({
        id: credential.id,
        encrypted: this.cipher.encrypt(JSON.stringify(credential))
      }))
    }
    await atomicWriteFile(this.path, `${JSON.stringify(file, null, 2)}\n`)
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const queued = this.writeQueue.then(operation)
    this.writeQueue = queued.catch(() => undefined)
    await queued
  }

  private async readVault(): Promise<VaultFile> {
    try {
      const parsed = JSON.parse(await readUtf8File(this.path)) as VaultFile
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return EMPTY_VAULT
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_VAULT
      throw error
    }
  }
}
