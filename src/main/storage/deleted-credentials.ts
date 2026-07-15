import { atomicWriteFile, readUtf8File } from './atomic-file'

interface DeletedCredentialFile {
  version: 1
  ids: string[]
}

export class DeletedCredentialStore {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async list(): Promise<Set<string>> {
    await this.writeQueue
    return this.listUnlocked()
  }

  private async listUnlocked(): Promise<Set<string>> {
    try {
      const parsed = JSON.parse(await readUtf8File(this.path)) as DeletedCredentialFile
      return parsed.version === 1 && Array.isArray(parsed.ids)
        ? new Set(parsed.ids.filter((id): id is string => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)))
        : new Set()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
      throw error
    }
  }

  async addMany(ids: string[]): Promise<void> {
    await this.update(ids, true)
  }

  async removeMany(ids: string[]): Promise<void> {
    await this.update(ids, false)
  }

  private async update(ids: string[], add: boolean): Promise<void> {
    if (ids.length === 0) return
    const operation = this.writeQueue.then(async () => {
      const stored = await this.listUnlocked()
      for (const id of ids) {
        if (add) stored.add(id)
        else stored.delete(id)
      }
      await atomicWriteFile(
        this.path,
        `${JSON.stringify({ version: 1, ids: [...stored].sort() }, null, 2)}\n`
      )
    })
    this.writeQueue = operation.catch(() => undefined)
    await operation
  }
}
