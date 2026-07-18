import type { TestResult } from '../../shared/types'
import { atomicWriteFile, readUtf8File } from './atomic-file'
import { testResultSchema } from './schemas'

interface StatusFile {
  version: 1
  entries: Record<string, TestResult>
}

export class StatusStore {
  private writeQueue: Promise<void> = Promise.resolve()
  private cache: Record<string, TestResult> | null = null
  private flushTimer: NodeJS.Timeout | null = null
  private dirty = false

  constructor(
    private readonly path: string,
    private readonly flushDelayMs = 300
  ) {}

  async getAll(): Promise<Record<string, TestResult>> {
    await this.writeQueue
    return { ...(await this.getAllUnlocked()) }
  }

  private async getAllUnlocked(): Promise<Record<string, TestResult>> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(await readUtf8File(this.path)) as StatusFile
      if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
        this.cache = {}
        return this.cache
      }
      const entries: Record<string, TestResult> = {}
      for (const [id, value] of Object.entries(parsed.entries)) {
        const result = testResultSchema.safeParse(value)
        if (result.success && result.data.accountId === id) entries[id] = result.data
      }
      this.cache = entries
      return entries
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache = {}
        return this.cache
      }
      throw error
    }
  }

  async set(result: TestResult): Promise<void> {
    await this.setMany([result])
  }

  async setMany(results: readonly TestResult[]): Promise<void> {
    if (results.length === 0) return
    await this.mutate((entries) => {
      for (const result of results) entries[result.accountId] = result
    })
    await this.flush()
  }

  async setBuffered(result: TestResult): Promise<void> {
    await this.setManyBuffered([result])
  }

  async setManyBuffered(results: readonly TestResult[]): Promise<void> {
    if (results.length === 0) return
    await this.mutate((entries) => {
      for (const result of results) entries[result.accountId] = result
    })
    this.scheduleFlush()
  }

  async removeMany(ids: string[]): Promise<void> {
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
    const operation = this.writeQueue.then(async () => {
      if (!this.dirty) return
      const entries = await this.getAllUnlocked()
      await atomicWriteFile(this.path, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`)
      this.dirty = false
    })
    this.writeQueue = operation.catch(() => undefined)
    await operation
  }

  private async mutate(operation: (entries: Record<string, TestResult>) => void): Promise<void> {
    const queued = this.writeQueue.then(async () => {
      operation(await this.getAllUnlocked())
      this.dirty = true
    })
    this.writeQueue = queued.catch(() => undefined)
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
