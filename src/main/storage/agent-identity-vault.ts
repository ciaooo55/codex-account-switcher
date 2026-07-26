import type { NormalizedAgentIdentityCredential, SecretCipher } from '../../shared/types'
import { atomicWriteFile, readUtf8File } from './atomic-file'
import { normalizedAgentIdentityCredentialSchema } from './schemas'

interface VaultFile {
  version: 1
  entries: Array<{ id: string; encrypted: string }>
}

const EMPTY_VAULT: VaultFile = { version: 1, entries: [] }

/**
 * Stores Agent Identity private keys independently from normal Codex bearer
 * credentials.  The separate vault is intentional: all legacy account
 * switching code assumes `accessToken` exists, while Agent Identity must only
 * ever be consumed by the local API resolver in the main process.
 */
export class AgentIdentityVault {
  private writeQueue: Promise<void> = Promise.resolve()
  private cache: Map<string, NormalizedAgentIdentityCredential> | null = null

  constructor(
    private readonly path: string,
    private readonly cipher: SecretCipher
  ) {}

  async list(): Promise<NormalizedAgentIdentityCredential[]> {
    await this.writeQueue
    return [...(await this.loadCacheUnlocked()).values()].map(clone)
  }

  async get(id: string): Promise<NormalizedAgentIdentityCredential | null> {
    await this.writeQueue
    const credential = (await this.loadCacheUnlocked()).get(id)
    return credential ? clone(credential) : null
  }

  async upsertMany(credentials: readonly NormalizedAgentIdentityCredential[]): Promise<void> {
    if (credentials.length === 0) return
    await this.enqueueWrite(async () => {
      const next = new Map(await this.loadCacheUnlocked())
      for (const credential of credentials) next.set(credential.id, clone(credential))
      await this.commit([...next.values()])
    })
  }

  async removeMany(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    await this.enqueueWrite(async () => {
      const next = new Map(await this.loadCacheUnlocked())
      for (const id of ids) next.delete(id)
      await this.commit([...next.values()])
    })
  }

  private async loadCacheUnlocked(): Promise<Map<string, NormalizedAgentIdentityCredential>> {
    if (this.cache) return this.cache
    const file = await this.readVault()
    const credentials = new Map<string, NormalizedAgentIdentityCredential>()
    for (const entry of file.entries) {
      try {
        const raw = JSON.parse(this.cipher.decrypt(entry.encrypted)) as Record<string, unknown>
        const parsed = normalizedAgentIdentityCredentialSchema.safeParse(raw)
        if (parsed.success && parsed.data.id === entry.id) credentials.set(parsed.data.id, parsed.data)
      } catch {
        // Never allow one damaged encrypted record to hide other identities.
      }
    }
    this.cache = credentials
    return credentials
  }

  private async commit(credentials: readonly NormalizedAgentIdentityCredential[]): Promise<void> {
    const file: VaultFile = {
      version: 1,
      entries: credentials.map((credential) => ({
        id: credential.id,
        encrypted: this.cipher.encrypt(JSON.stringify(credential))
      }))
    }
    await atomicWriteFile(this.path, `${JSON.stringify(file, null, 2)}\n`)
    this.cache = new Map(credentials.map((credential) => [credential.id, clone(credential)]))
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const queued = this.writeQueue.then(operation)
    this.writeQueue = queued.catch(() => undefined)
    await queued
  }

  private async readVault(): Promise<VaultFile> {
    try {
      const parsed = JSON.parse(await readUtf8File(this.path)) as VaultFile
      return parsed.version === 1 && Array.isArray(parsed.entries) ? parsed : EMPTY_VAULT
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_VAULT
      throw error
    }
  }
}

function clone(
  credential: NormalizedAgentIdentityCredential
): NormalizedAgentIdentityCredential {
  return {
    ...credential,
    agentIdentity: { ...credential.agentIdentity },
    secretExtensions: {
      ...credential.secretExtensions,
      credentials: credential.secretExtensions.credentials
        ? JSON.parse(JSON.stringify(credential.secretExtensions.credentials)) as Record<string, unknown>
        : null,
      extra: credential.secretExtensions.extra
        ? JSON.parse(JSON.stringify(credential.secretExtensions.extra)) as Record<string, unknown>
        : null,
      modelMapping: { ...credential.secretExtensions.modelMapping },
      metadata: JSON.parse(JSON.stringify(credential.secretExtensions.metadata)) as Record<string, unknown>
    }
  }
}
