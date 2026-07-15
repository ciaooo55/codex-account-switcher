import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import type { NormalizedCredential } from '../../shared/types'
import { dedupeCredentials } from '../accounts/parser'
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

function managedDocument(credential: NormalizedCredential): Record<string, unknown> {
  return {
    schema: 'codex-account-switcher/account-v1',
    type: 'codex',
    email: credential.email,
    plan_type: credential.planType,
    account_id: credential.accountId,
    subject: credential.subject,
    access_token: credential.accessToken,
    refresh_token: credential.refreshToken,
    id_token: credential.idToken,
    last_refresh: credential.lastRefresh,
    expired: credential.accessExpiresAt
  }
}

async function collectManagedFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  const stack = [directory]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile() && MANAGED_EXTENSIONS.has(extname(entry.name).toLowerCase())) files.push(path)
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

export class ManagedCredentialLibrary {
  private writeQueue: Promise<void> = Promise.resolve()

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

    for (const credential of stored) {
      await atomicWriteFile(
        credential.sourcePath,
        `${JSON.stringify(managedDocument(credential), null, 2)}\n`
      )
    }

    const desired = new Set(stored.map((credential) => resolve(credential.sourcePath).toLowerCase()))
    for (const path of await collectManagedFiles(this.directory)) {
      if (!desired.has(resolve(path).toLowerCase())) await rm(path, { force: true })
    }
    await removeEmptyDirectories(this.directory, this.directory)
    return stored
  }

  async exists(): Promise<boolean> {
    try {
      return (await stat(this.directory)).isDirectory()
    } catch {
      return false
    }
  }
}
