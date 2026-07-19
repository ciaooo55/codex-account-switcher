import { watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { atomicWriteFile } from './atomic-file'

interface CachedFile<T> {
  signature: string
  records: T[]
}

interface DirectoryRecordIndexOptions<T> {
  directory: () => string | Promise<string>
  collectPaths: (directory: string) => Promise<string[]>
  loadPath: (path: string) => Promise<T[]>
  concurrency?: number
  cacheFile?: () => string | Promise<string>
  cacheVersion?: number
}

interface PersistedIndex<T> {
  version: number
  directory: string
  files: Array<{ key: string; signature: string; records: T[] }>
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
  private hydratedDirectory: string | null = null

  constructor(private readonly options: DirectoryRecordIndexOptions<T>) {}

  async list(force = false): Promise<T[]> {
    const directory = resolve(await this.options.directory())
    this.ensureDirectory(directory)
    await this.hydrate(directory)
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
    this.hydratedDirectory = null
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
    let cacheChanged = false
    const loaded = await mapConcurrent(paths, concurrency, async (path) => {
      const key = resolve(path).toLowerCase()
      try {
        const metadata = await stat(path)
        const signature = `${metadata.size}:${metadata.mtimeMs}`
        const cached = this.fileCache.get(key)
        if (cached?.signature === signature) return cached.records
        const records = await this.options.loadPath(path)
        this.fileCache.set(key, { signature, records })
        cacheChanged = true
        return records
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          cacheChanged ||= this.fileCache.delete(key)
          return []
        }
        throw error
      }
    })

    for (const key of this.fileCache.keys()) {
      if (!currentPaths.has(key)) {
        this.fileCache.delete(key)
        cacheChanged = true
      }
    }
    this.snapshot = loaded.flat()
    this.dirty = this.changeVersion !== startVersion
    if (cacheChanged) await this.persist(directory)
    return this.snapshot
  }

  private async hydrate(directory: string): Promise<void> {
    if (this.hydratedDirectory === directory) return
    this.hydratedDirectory = directory
    if (!this.options.cacheFile) return
    try {
      const cachePath = resolve(await this.options.cacheFile())
      if ((await stat(cachePath)).size > 32 * 1024 * 1024) return
      const parsed = JSON.parse(await readFile(cachePath, 'utf8')) as Partial<PersistedIndex<T>>
      if (
        parsed.version !== (this.options.cacheVersion ?? 1) ||
        resolve(String(parsed.directory ?? '')).toLowerCase() !== directory.toLowerCase() ||
        !Array.isArray(parsed.files)
      ) return
      for (const item of parsed.files.slice(0, 100_000)) {
        if (!item || typeof item.key !== 'string' || typeof item.signature !== 'string' || !Array.isArray(item.records)) {
          continue
        }
        this.fileCache.set(item.key, { signature: item.signature, records: item.records })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.fileCache.clear()
      }
    }
  }

  private async persist(directory: string): Promise<void> {
    if (!this.options.cacheFile) return
    try {
      const cachePath = resolve(await this.options.cacheFile())
      await mkdir(dirname(cachePath), { recursive: true })
      const contents: PersistedIndex<T> = {
        version: this.options.cacheVersion ?? 1,
        directory,
        files: [...this.fileCache].map(([key, item]) => ({ key, ...item }))
      }
      await atomicWriteFile(cachePath, `${JSON.stringify(contents)}\n`)
    } catch {
      // A cache failure must never prevent the source directory from loading.
    }
  }
}
