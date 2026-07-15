import type { TestResult } from '../../shared/types'
import { atomicWriteFile, readUtf8File } from './atomic-file'
import { testResultSchema } from './schemas'

interface StatusFile {
  version: 1
  entries: Record<string, TestResult>
}

export class StatusStore {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async getAll(): Promise<Record<string, TestResult>> {
    await this.writeQueue
    return this.getAllUnlocked()
  }

  private async getAllUnlocked(): Promise<Record<string, TestResult>> {
    try {
      const parsed = JSON.parse(await readUtf8File(this.path)) as StatusFile
      if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') return {}
      const entries: Record<string, TestResult> = {}
      for (const [id, value] of Object.entries(parsed.entries)) {
        const result = testResultSchema.safeParse(value)
        if (result.success && result.data.accountId === id) entries[id] = result.data
      }
      return entries
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  async set(result: TestResult): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const entries = await this.getAllUnlocked()
      entries[result.accountId] = result
      await atomicWriteFile(this.path, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`)
    })
    this.writeQueue = operation.catch(() => undefined)
    await operation
  }

  async removeMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const operation = this.writeQueue.then(async () => {
      const entries = await this.getAllUnlocked()
      for (const id of ids) delete entries[id]
      await atomicWriteFile(this.path, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`)
    })
    this.writeQueue = operation.catch(() => undefined)
    await operation
  }
}
