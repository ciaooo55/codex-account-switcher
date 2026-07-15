import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { NormalizedCredential, SecretCipher } from '../../shared/types'

interface VaultFile {
  version: 1
  entries: Array<{ id: string; encrypted: string }>
}

const EMPTY_VAULT: VaultFile = { version: 1, entries: [] }

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, text, { encoding: 'utf8', mode: 0o600 })
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

export class CredentialVault {
  constructor(
    private readonly path: string,
    private readonly cipher: SecretCipher
  ) {}

  async list(): Promise<NormalizedCredential[]> {
    const file = await this.readVault()
    const credentials: NormalizedCredential[] = []
    for (const entry of file.entries) {
      try {
        const credential = JSON.parse(
          this.cipher.decrypt(entry.encrypted)
        ) as NormalizedCredential & { sourceDialect?: NormalizedCredential['sourceDialect'] }
        credentials.push({
          ...credential,
          sourceDialect: credential.sourceDialect ?? 'generic'
        })
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
    const existing = new Map((await this.list()).map((credential) => [credential.id, credential]))
    for (const credential of credentials) existing.set(credential.id, credential)
    const file: VaultFile = {
      version: 1,
      entries: [...existing.values()].map((credential) => ({
        id: credential.id,
        encrypted: this.cipher.encrypt(JSON.stringify(credential))
      }))
    }
    await atomicWrite(this.path, `${JSON.stringify(file, null, 2)}\n`)
  }

  async replace(credentials: NormalizedCredential[]): Promise<void> {
    const file: VaultFile = {
      version: 1,
      entries: credentials.map((credential) => ({
        id: credential.id,
        encrypted: this.cipher.encrypt(JSON.stringify(credential))
      }))
    }
    await atomicWrite(this.path, `${JSON.stringify(file, null, 2)}\n`)
  }

  async removeMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const removeIds = new Set(ids)
    await this.replace((await this.list()).filter((credential) => !removeIds.has(credential.id)))
  }

  private async readVault(): Promise<VaultFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as VaultFile
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return EMPTY_VAULT
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY_VAULT
      throw error
    }
  }
}
