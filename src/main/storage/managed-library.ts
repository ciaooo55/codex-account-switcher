import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import type { NormalizedCredential } from '../../shared/types'
import { dedupeCredentials } from '../accounts/parser'
import { serializeCpaCredential } from '../accounts/credential-formats'
import { atomicWriteFile } from './atomic-file'

const MANAGED_EXTENSIONS = new Set(['.json', '.jsonl', '.txt', '.md', '.js', '.mjs', '.cjs', '.zip'])

function safePart(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[. -]+$/g, '')
    .slice(0, 110)
  return cleaned || fallback
}

async function collectManagedFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  const stack = [directory]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile() && (MANAGED_EXTENSIONS.has(extname(entry.name).toLowerCase()) || /\.json\.(?:0|无权限|无用量)$/i.test(entry.name))) files.push(path)
    }
  }
  return files
}

async function removeEmptyDirectories(directory: string, root: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await removeEmptyDirectories(join(directory, entry.name), root)
  }
  if (resolve(directory) !== resolve(root) && (await readdir(directory)).length === 0) {
    await rm(directory, { recursive: true, force: true })
  }
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>
): Promise<void> {
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= values.length) return
      await operation(values[index])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker())
  )
}

export class ManagedCredentialLibrary {
  private writeQueue: Promise<void> = Promise.resolve()
  private readonly contentCache = new Map<string, string>()

  constructor(readonly directory: string) {}

  async replace(credentials: readonly NormalizedCredential[]): Promise<NormalizedCredential[]> {
    let stored: NormalizedCredential[] = []
    const operation = this.writeQueue.then(async () => {
      stored = await this.replaceUnlocked(credentials)
    })
    this.writeQueue = operation.catch(() => undefined)
    await operation
    return stored
  }

  private async replaceUnlocked(
    credentials: readonly NormalizedCredential[]
  ): Promise<NormalizedCredential[]> {
    await mkdir(this.directory, { recursive: true })
    const usedNames = new Map<string, string>()
    const stored = dedupeCredentials(credentials).map((credential) => {
      const email = safePart(
        credential.email ?? `unknown-email-${credential.id.slice(0, 8)}`,
        `unknown-email-${credential.id.slice(0, 8)}`
      )
      const plan = safePart(credential.planType ?? 'unknown', 'unknown')
      let filename = `${email}_${plan}.json`
      const owner = usedNames.get(filename.toLowerCase())
      if (owner && owner !== credential.id) {
        filename = `${email}_${plan}_${credential.id.slice(0, 8)}.json`
      }
      usedNames.set(filename.toLowerCase(), credential.id)
      return {
        ...credential,
        sourcePath: join(this.directory, filename),
        sourceFormat: 'json' as const,
        sourceDialect: 'cpa' as const
      }
    })

    await mapConcurrent(stored, 8, async (credential) => {
      await this.writeIfChanged(
        credential.sourcePath,
        `${JSON.stringify(serializeCpaCredential(credential), null, 2)}\n`
      )
    })

    const desired = new Set(stored.map((credential) => resolve(credential.sourcePath).toLowerCase()))
    const obsolete = (await collectManagedFiles(this.directory))
      .filter((path) => !desired.has(resolve(path).toLowerCase()))
    await mapConcurrent(obsolete, 8, async (path) => {
      await rm(path, { force: true })
      this.contentCache.delete(resolve(path).toLowerCase())
    })
    await removeEmptyDirectories(this.directory, this.directory)
    return stored
  }

  private async writeIfChanged(path: string, text: string): Promise<void> {
    const key = resolve(path).toLowerCase()
    if (this.contentCache.get(key) === text) {
      try {
        if ((await stat(path)).isFile()) return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      this.contentCache.delete(key)
    }
    try {
      if (await readFile(path, 'utf8') === text) {
        this.contentCache.set(key, text)
        return
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await atomicWriteFile(path, text)
    this.contentCache.set(key, text)
  }

  async exists(): Promise<boolean> {
    try {
      return (await stat(this.directory)).isDirectory()
    } catch {
      return false
    }
  }
}
