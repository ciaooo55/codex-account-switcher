import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import type {
  CredentialExportLayout,
  CredentialSourceFormat,
  DeleteAccountsResult,
  GrokAccountSummary,
  GrokBatchTestResult,
  GrokCredential,
  GrokScanResult,
  GrokTestResult
} from '../../shared/types'
import { dedupeGrokCredentials, parseGrokCredentialText } from '../accounts/grok-parser'
import { atomicWriteFile } from '../storage/atomic-file'
import type { GrokStatusStore } from '../storage/grok-status-store'

const FORMATS: Record<string, CredentialSourceFormat | undefined> = {
  '.json': 'json', '.jsonl': 'jsonl', '.txt': 'txt', '.md': 'md',
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.zip': 'zip'
}
const MAX_FILE_BYTES = 100 * 1024 * 1024
const MANAGED_PREFIX = 'grok-'

interface GrokManagerOptions {
  directory: () => string | Promise<string>
  concurrency: () => number | Promise<number>
  statusStore: GrokStatusStore
  tester: {
    test(credential: GrokCredential, signal?: AbortSignal): Promise<GrokTestResult>
  }
}

interface TestOptions {
  signal?: AbortSignal
  onProgress?: (progress: { done: number; total: number; runningIds: string[]; updatedAccount?: GrokAccountSummary }) => void
}

function safePart(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9@._+-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.slice(0, 80) || 'unknown'
}

function managedName(credential: GrokCredential): string {
  return `${MANAGED_PREFIX}${safePart(credential.email ?? credential.subject ?? 'unknown')}-${safePart(credential.planType ?? 'unknown')}-${credential.id.slice(0, 10)}.json`
}

function serialized(credential: GrokCredential): string {
  return `${JSON.stringify({
    access_token: credential.accessToken,
    auth_kind: 'oauth',
    base_url: credential.baseUrl,
    disabled: false,
    email: credential.email,
    expired: credential.expiresAt,
    id_token: credential.idToken,
    last_refresh: credential.lastRefresh,
    refresh_token: credential.refreshToken,
    sub: credential.subject,
    team_id: credential.teamId,
    client_id: credential.clientId,
    scope: credential.scope,
    token_endpoint: credential.tokenEndpoint,
    token_type: credential.tokenType,
    type: 'xai',
    plan_type: credential.planType,
    ...(credential.billingSnapshot ? { grok_billing_snapshot: credential.billingSnapshot } : {}),
    ...(credential.usageSnapshot ? { grok_usage_snapshot: credential.usageSnapshot } : {})
  }, null, 2)}\n`
}

async function files(directory: string): Promise<string[]> {
  const result: string[] = []
  const stack = [directory]
  while (stack.length) {
    const current = stack.pop()!
    let entries
    try { entries = await readdir(current, { withFileTypes: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile() && FORMATS[extname(entry.name).toLowerCase()]) result.push(path)
    }
  }
  return result.sort()
}

export class GrokAccountManager {
  constructor(private readonly options: GrokManagerOptions) {}

  async scanDirectory(): Promise<GrokScanResult> {
    const directory = await this.directory()
    await mkdir(directory, { recursive: true })
    return this.importPaths(await files(directory))
  }

  async importDirectory(directory: string): Promise<GrokScanResult> {
    if (!(await stat(directory)).isDirectory()) throw new Error('选择的路径不是文件夹')
    return this.importPaths(await files(directory))
  }

  async importFiles(paths: string[]): Promise<GrokScanResult> {
    return this.importPaths(paths)
  }

  async importPasted(text: string): Promise<GrokScanResult> {
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('粘贴内容超过安全限制')
    const parsed = parseGrokCredentialText(text, { sourcePath: 'pasted-grok.json', format: 'paste' })
    return this.mergeImported(parsed.credentials, parsed.errors)
  }

  async listAccounts(): Promise<GrokAccountSummary[]> {
    const credentials = await this.listCredentials()
    const statuses = await this.options.statusStore.getAll()
    return credentials.map((credential) => {
      const status = statuses[credential.id]
      return {
        id: credential.id,
        email: credential.email,
        subject: credential.subject,
        teamId: credential.teamId,
        planType: status?.usage?.planType ?? credential.planType,
        sourcePath: credential.sourcePath,
        sourceFormat: credential.sourceFormat,
        sourceDialect: credential.sourceDialect,
        canRefresh: Boolean(credential.refreshToken),
        expiresAt: credential.expiresAt,
        lastRefresh: credential.lastRefresh,
        status: status?.status ?? 'untested',
        detail: status?.detail ?? '未测试',
        lastCheckedAt: status?.checkedAt ?? null,
        usage: status?.usage ?? null
      }
    }).sort((a, b) => (a.email ?? a.subject ?? '').localeCompare(b.email ?? b.subject ?? ''))
  }

  async deleteAccounts(ids: string[]): Promise<DeleteAccountsResult> {
    const selected = new Set(ids)
    const records = await this.managedCredentialRecords()
    const removed = records.filter((item) => selected.has(item.credential.id))
    await Promise.all(removed.map((item) => rm(item.path, { force: true })))
    const removedIds = [...new Set(removed.map((item) => item.credential.id))]
    await this.options.statusStore.removeMany(removedIds)
    return { deleted: removedIds.length, message: `已删除 ${removedIds.length} 个 Grok 账号和对应的托管凭证文件` }
  }

  async testAccounts(ids?: string[], options: TestOptions = {}): Promise<GrokBatchTestResult> {
    const wanted = ids ? new Set(ids) : null
    const credentials = (await this.listCredentials()).filter((item) => !wanted || wanted.has(item.id))
    const results: GrokTestResult[] = []
    const running = new Set<string>()
    let cursor = 0
    let done = 0
    options.onProgress?.({ done, total: credentials.length, runningIds: [] })
    const worker = async (): Promise<void> => {
      while (!options.signal?.aborted) {
        const credential = credentials[cursor++]
        if (!credential) return
        running.add(credential.id)
        options.onProgress?.({ done, total: credentials.length, runningIds: [...running] })
        let tested: GrokTestResult
        try {
          tested = await this.options.tester.test(credential, options.signal)
        } catch {
          tested = {
            accountId: credential.id,
            status: 'unknown_error',
            detail: '检测任务异常终止',
            checkedAt: new Date().toISOString(),
            httpStatus: null,
            refreshed: false,
            usage: null
          }
        }
        results.push(tested)
        await this.options.statusStore.set(tested)
        running.delete(credential.id)
        done += 1
        const updatedAccount = (await this.listAccounts()).find((item) => item.id === credential.id)
        options.onProgress?.({ done, total: credentials.length, runningIds: [...running], ...(updatedAccount ? { updatedAccount } : {}) })
      }
    }
    const concurrency = Math.max(1, Math.min(12, await this.options.concurrency()))
    await Promise.all(Array.from({ length: Math.min(concurrency, credentials.length) }, worker))
    return { tested: results.length, results, cancelled: Boolean(options.signal?.aborted) }
  }

  async upsertRefreshed(credential: GrokCredential): Promise<void> {
    const directory = await this.directory()
    const path = join(directory, managedName(credential))
    await atomicWriteFile(path, serialized({ ...credential, sourcePath: path, sourceFormat: 'json', sourceDialect: 'cpa' }))
  }

  async exportAccounts(ids: string[], layout: CredentialExportLayout, directory: string): Promise<string[]> {
    const selected = new Set(ids)
    const credentials = (await this.listCredentials()).filter((item) => selected.has(item.id))
    await mkdir(directory, { recursive: true })
    if (layout === 'bundle') {
      const path = join(directory, `grok-sub2api-${Date.now()}.json`)
      const accounts = credentials.map((item) => ({
        name: item.email ?? item.subject ?? item.id.slice(0, 10), platform: 'grok', type: 'oauth',
        credentials: JSON.parse(serialized(item)), extra: {
          ...(item.billingSnapshot ? { grok_billing_snapshot: item.billingSnapshot } : {}),
          ...(item.usageSnapshot ? { grok_usage_snapshot: item.usageSnapshot } : {})
        }
      }))
      await atomicWriteFile(path, `${JSON.stringify({ exported_at: new Date().toISOString(), proxies: [], accounts }, null, 2)}\n`)
      return [path]
    }
    const paths: string[] = []
    for (const item of credentials) {
      const path = join(directory, managedName(item))
      await atomicWriteFile(path, serialized(item))
      paths.push(path)
    }
    return paths
  }

  private async importPaths(paths: string[]): Promise<GrokScanResult> {
    const credentials: GrokCredential[] = []
    const errors: string[] = []
    for (const path of paths) {
      const format = FORMATS[extname(path).toLowerCase()]
      if (!format) continue
      try {
        const info = await stat(path)
        if (info.size > MAX_FILE_BYTES) throw new Error('文件超过 100MB')
        if (format === 'zip') {
          const archive = unzipSync(new Uint8Array(await readFile(path)))
          for (const [name, data] of Object.entries(archive)) {
            const nested = FORMATS[extname(name).toLowerCase()]
            if (!nested || nested === 'zip') continue
            const parsed = parseGrokCredentialText(strFromU8(data), { sourcePath: `${path}#${name}`, format: nested })
            credentials.push(...parsed.credentials)
          }
        } else {
          const parsed = parseGrokCredentialText(await readFile(path, 'utf8'), { sourcePath: path, format })
          credentials.push(...parsed.credentials)
        }
      } catch (error) {
        errors.push(`${path}: ${error instanceof Error ? error.message : '读取失败'}`)
      }
    }
    return this.mergeImported(credentials, errors)
  }

  private async mergeImported(
    importedValues: GrokCredential[],
    errors: string[]
  ): Promise<GrokScanResult> {
    const existing = await this.listCredentials(true)
    const imported = dedupeGrokCredentials(importedValues)
    const existingIds = new Set(existing.map((item) => item.id))
    const importedCount = imported.filter((item) => !existingIds.has(item.id)).length
    const merged = dedupeGrokCredentials([...existing, ...imported])
    const directory = await this.directory()
    await mkdir(directory, { recursive: true })
    for (const credential of merged) {
      const path = join(directory, managedName(credential))
      await atomicWriteFile(path, serialized({ ...credential, sourcePath: path, sourceFormat: 'json', sourceDialect: 'cpa' }))
    }
    return {
      imported: importedCount,
      skipped: imported.length - importedCount,
      errors,
      accounts: await this.listAccounts()
    }
  }

  private async listCredentials(managedOnly = true): Promise<GrokCredential[]> {
    if (managedOnly) {
      return dedupeGrokCredentials((await this.managedCredentialRecords()).map((item) => item.credential))
    }
    const directory = await this.directory()
    await mkdir(directory, { recursive: true })
    const result: GrokCredential[] = []
    for (const path of await files(directory)) {
      const format = FORMATS[extname(path).toLowerCase()]
      if (!format || format === 'zip') continue
      try {
        const parsed = parseGrokCredentialText(await readFile(path, 'utf8'), { sourcePath: path, format })
        result.push(...parsed.credentials)
      } catch {
        // Non-Grok CPA files in the shared directory are intentionally ignored.
      }
    }
    return dedupeGrokCredentials(result)
  }

  private async managedCredentialRecords(): Promise<Array<{ path: string; credential: GrokCredential }>> {
    const directory = await this.directory()
    await mkdir(directory, { recursive: true })
    const result: Array<{ path: string; credential: GrokCredential }> = []
    for (const path of await files(directory)) {
      if (extname(path).toLowerCase() !== '.json' || !basename(path).startsWith(MANAGED_PREFIX)) continue
      try {
        const parsed = parseGrokCredentialText(await readFile(path, 'utf8'), { sourcePath: path, format: 'json' })
        if (parsed.credentials.length !== 1) continue
        const credential = parsed.credentials[0]
        if (basename(path).toLowerCase() !== managedName(credential).toLowerCase()) continue
        result.push({ path, credential })
      } catch {
        // A similarly named user source file is not an application-managed credential.
      }
    }
    return result
  }

  private async directory(): Promise<string> {
    return resolve(await this.options.directory())
  }
}
