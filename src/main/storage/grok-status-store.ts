import type { GrokTestResult } from '../../shared/types'
import { atomicWriteFile, readUtf8File } from './atomic-file'

export class GrokStatusStore {
  private queue: Promise<void> = Promise.resolve()
  private cache: Record<string, GrokTestResult> | null = null
  private flushTimer: NodeJS.Timeout | null = null
  private dirty = false

  constructor(
    private readonly path: string,
    private readonly flushDelayMs = 300
  ) {}

  async getAll(): Promise<Record<string, GrokTestResult>> {
    await this.queue
    return { ...(await this.getUnlocked()) }
  }

  async set(result: GrokTestResult): Promise<void> {
    await this.setMany([result])
  }

  async setMany(results: readonly GrokTestResult[]): Promise<void> {
    if (results.length === 0) return
    await this.mutate((entries) => {
      for (const result of results) entries[result.accountId] = result
    })
    await this.flush()
  }

  async setBuffered(result: GrokTestResult): Promise<void> {
    await this.setManyBuffered([result])
  }

  async setManyBuffered(results: readonly GrokTestResult[]): Promise<void> {
    if (results.length === 0) return
    await this.mutate((entries) => {
      for (const result of results) entries[result.accountId] = result
    })
    this.scheduleFlush()
  }

  async removeMany(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    await this.mutate((entries) => {
      for (const id of ids) delete entries[id]
    })
    await this.flush()
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    const operation = this.queue.then(async () => {
      if (!this.dirty) return
      await atomicWriteFile(this.path, `${JSON.stringify(await this.getUnlocked(), null, 2)}\n`)
      this.dirty = false
    })
    this.queue = operation.catch(() => undefined)
    await operation
  }

  private async getUnlocked(): Promise<Record<string, GrokTestResult>> {
    if (this.cache) return this.cache
    try {
      const value = JSON.parse(await readUtf8File(this.path))
      this.cache = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, GrokTestResult>
        : {}
      return this.cache
    } catch {
      this.cache = {}
      return this.cache
    }
  }

  private async mutate(operation: (entries: Record<string, GrokTestResult>) => void): Promise<void> {
    const queued = this.queue.then(async () => {
      operation(await this.getUnlocked())
      this.dirty = true
    })
    this.queue = queued.catch(() => undefined)
    await queued
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush().catch(() => undefined)
    }, this.flushDelayMs)
    this.flushTimer.unref()
  }
}
