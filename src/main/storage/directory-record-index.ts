import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

interface CachedFile<T> {
  signature: string
  records: T[]
}

interface DirectoryRecordIndexOptions<T> {
  directory: () => string | Promise<string>
  collectPaths: (directory: string) => Promise<string[]>
  loadPath: (path: string) => Promise<T[]>
  concurrency?: number
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= values.length) return
      results[index] = await operation(values[index])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker())
  )
  return results
}

export class DirectoryRecordIndex<T> {
  private directoryPath: string | null = null
  private watcher: FSWatcher | null = null
  private watcherAvailable = false
  private fileCache = new Map<string, CachedFile<T>>()
  private snapshot: T[] | null = null
  private dirty = true
  private changeVersion = 0
  private refreshPromise: Promise<T[]> | null = null

  constructor(private readonly options: DirectoryRecordIndexOptions<T>) {}

  async list(force = false): Promise<T[]> {
    const directory = resolve(await this.options.directory())
    this.ensureDirectory(directory)
    if (!this.watcherAvailable) this.dirty = true
    if (!force && !this.dirty && this.snapshot) return [...this.snapshot]
    if (this.refreshPromise) return [...(await this.refreshPromise)]

    this.refreshPromise = this.refresh(directory)
    try {
      return [...(await this.refreshPromise)]
    } finally {
      this.refreshPromise = null
    }
  }

  invalidate(): void {
    this.dirty = true
    this.changeVersion += 1
  }

  dispose(): void {
    this.watcher?.close()
    this.watcher = null
    this.watcherAvailable = false
  }

  private ensureDirectory(directory: string): void {
    if (this.directoryPath === directory) return
    this.watcher?.close()
    this.directoryPath = directory
    this.watcher = null
    this.watcherAvailable = false
    this.fileCache.clear()
    this.snapshot = null
    this.invalidate()

    try {
      const watcher = watch(directory, { recursive: true }, () => this.invalidate())
      watcher.on('error', () => {
        watcher.close()
        if (this.watcher === watcher) {
          this.watcher = null
          this.watcherAvailable = false
          this.invalidate()
        }
      })
      watcher.unref()
      this.watcher = watcher
      this.watcherAvailable = true
    } catch {
      this.watcher = null
      this.watcherAvailable = false
    }
  }

  private async refresh(directory: string): Promise<T[]> {
    const startVersion = this.changeVersion
    const paths = await this.options.collectPaths(directory)
    const currentPaths = new Set(paths.map((path) => resolve(path).toLowerCase()))
    const concurrency = this.options.concurrency ?? 8
    const loaded = await mapConcurrent(paths, concurrency, async (path) => {
      const key = resolve(path).toLowerCase()
      try {
        const metadata = await stat(path)
        const signature = `${metadata.size}:${metadata.mtimeMs}`
        const cached = this.fileCache.get(key)
        if (cached?.signature === signature) return cached.records
        const records = await this.options.loadPath(path)
        this.fileCache.set(key, { signature, records })
        return records
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.fileCache.delete(key)
          return []
        }
        throw error
      }
    })

    for (const key of this.fileCache.keys()) {
      if (!currentPaths.has(key)) this.fileCache.delete(key)
    }
    this.snapshot = loaded.flat()
    this.dirty = this.changeVersion !== startVersion
    return this.snapshot
  }
}
