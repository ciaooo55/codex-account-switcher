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
  private cache: Map<string, NormalizedCredential> | null = null

  constructor(
    private readonly path: string,
    private readonly cipher: SecretCipher
  ) {}

  async list(): Promise<NormalizedCredential[]> {
    await this.writeQueue
    return [...(await this.loadCacheUnlocked()).values()].map((credential) => ({ ...credential }))
  }

  private async loadCacheUnlocked(): Promise<Map<string, NormalizedCredential>> {
    if (this.cache) return this.cache
    const file = await this.readVault()
    const credentials = new Map<string, NormalizedCredential>()
    for (const entry of file.entries) {
      try {
        const raw = JSON.parse(this.cipher.decrypt(entry.encrypted)) as Record<string, unknown>
        const parsed = normalizedCredentialSchema.safeParse({
          ...raw,
          authKind: raw.authKind ?? (
            typeof raw.accessToken === 'string' && raw.accessToken.startsWith('at-')
              ? 'personal_access_token'
              : 'oauth'
          ),
          sourceDialect: raw.sourceDialect ?? 'generic'
        })
        if (parsed.success && parsed.data.id === entry.id) {
          credentials.set(parsed.data.id, parsed.data)
        }
      } catch {
        // A corrupt entry must not prevent access to the rest of the local vault.
      }
    }
    this.cache = credentials
    return credentials
  }

  async get(id: string): Promise<NormalizedCredential | null> {
    await this.writeQueue
    const credential = (await this.loadCacheUnlocked()).get(id)
    return credential ? { ...credential } : null
  }

  async upsertMany(credentials: NormalizedCredential[]): Promise<void> {
    if (credentials.length === 0) return
    await this.enqueueWrite(async () => {
      const next = new Map(await this.loadCacheUnlocked())
      for (const credential of credentials) next.set(credential.id, { ...credential })
      await this.commit([...next.values()])
    })
  }

  async replace(credentials: NormalizedCredential[]): Promise<void> {
    await this.enqueueWrite(async () => {
      const next = new Map(credentials.map((credential) => [credential.id, { ...credential }]))
      await this.commit([...next.values()])
    })
  }

  async removeMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await this.enqueueWrite(async () => {
      const next = new Map(await this.loadCacheUnlocked())
      for (const id of ids) next.delete(id)
      await this.commit([...next.values()])
    })
  }

  private async commit(credentials: readonly NormalizedCredential[]): Promise<void> {
    await this.writeCredentials(credentials)
    this.cache = new Map(
      credentials.map((credential) => [credential.id, { ...credential }])
    )
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
