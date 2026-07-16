import type { GrokTestResult } from '../../shared/types'
import { atomicWriteFile, readUtf8File } from './atomic-file'

export class GrokStatusStore {
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async getAll(): Promise<Record<string, GrokTestResult>> {
    await this.queue
    try {
      const value = JSON.parse(await readUtf8File(this.path))
      return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, GrokTestResult>
        : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      return {}
    }
  }

  async set(result: GrokTestResult): Promise<void> {
    const operation = this.queue.then(async () => {
      const entries = await this.getUnlocked()
      entries[result.accountId] = result
      await atomicWriteFile(this.path, `${JSON.stringify(entries, null, 2)}\n`)
    })
    this.queue = operation.catch(() => undefined)
    await operation
  }

  async removeMany(ids: readonly string[]): Promise<void> {
    const operation = this.queue.then(async () => {
      const entries = await this.getUnlocked()
      for (const id of ids) delete entries[id]
      await atomicWriteFile(this.path, `${JSON.stringify(entries, null, 2)}\n`)
    })
    this.queue = operation.catch(() => undefined)
    await operation
  }

  private async getUnlocked(): Promise<Record<string, GrokTestResult>> {
    try {
      const value = JSON.parse(await readUtf8File(this.path))
      return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, GrokTestResult>
        : {}
    } catch {
      return {}
    }
  }
}
