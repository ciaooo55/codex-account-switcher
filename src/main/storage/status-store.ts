import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { TestResult } from '../../shared/types'

interface StatusFile {
  version: 1
  entries: Record<string, TestResult>
}

async function atomicWrite(path: string, value: StatusFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
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

export class StatusStore {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async getAll(): Promise<Record<string, TestResult>> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as StatusFile
      return parsed.version === 1 && parsed.entries ? parsed.entries : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  async set(result: TestResult): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const entries = await this.getAll()
      entries[result.accountId] = result
      await atomicWrite(this.path, { version: 1, entries })
    })
    this.writeQueue = operation.catch(() => undefined)
    await operation
  }

  async removeMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const operation = this.writeQueue.then(async () => {
      const entries = await this.getAll()
      for (const id of ids) delete entries[id]
      await atomicWrite(this.path, { version: 1, entries })
    })
    this.writeQueue = operation.catch(() => undefined)
    await operation
  }
}
