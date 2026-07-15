import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

interface DeletedCredentialFile {
  version: 1
  ids: string[]
}

async function atomicWrite(path: string, value: DeletedCredentialFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
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

export class DeletedCredentialStore {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async list(): Promise<Set<string>> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as DeletedCredentialFile
      return parsed.version === 1 && Array.isArray(parsed.ids) ? new Set(parsed.ids) : new Set()
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
      const stored = await this.list()
      for (const id of ids) {
        if (add) stored.add(id)
        else stored.delete(id)
      }
      await atomicWrite(this.path, { version: 1, ids: [...stored].sort() })
    })
    this.writeQueue = operation.catch(() => undefined)
    await operation
  }
}
