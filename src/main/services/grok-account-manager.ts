import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
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
  GrokTestResult,
  ManagedFileStateResult
} from '../../shared/types'
import { dedupeGrokCredentials, parseGrokCredentialText } from '../accounts/grok-parser'
import { atomicWriteFile } from '../storage/atomic-file'
import type { GrokStatusStore } from '../storage/grok-status-store'
import { parseCredentialText } from '../accounts/parser'

const FORMATS: Record<string, CredentialSourceFormat | undefined> = {
  '.json': 'json', '.jsonl': 'jsonl', '.txt': 'txt', '.md': 'md',
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.zip': 'zip'
}
const MAX_FILE_BYTES = 100 * 1024 * 1024
const MANAGED_PREFIX = 'grok-'

interface GrokManagerOptions {
  directory: () => string | Promise<string>
  fileNameStyle?: 'library' | 'cpa'
  concurrency: () => number | Promise<number>
  statusStore: GrokStatusStore
  deletedStore?: {
    list(): Promise<Set<string>>
    addMany(ids: string[]): Promise<void>
    removeMany(ids: string[]): Promise<void>
  }
  tester: {
    test(credential: GrokCredential, signal?: AbortSignal): Promise<GrokTestResult>
  }
}

interface TestOptions {
  signal?: AbortSignal
  onProgress?: (progress: { done: number; total: number; runningIds: string[]; updatedAccount?: GrokAccountSummary }) => void
}

type ManagedFileState = 'enabled' | 'disabled' | 'no_permission' | 'no_usage'

interface ManagedRecord {
  path: string
  credential: GrokCredential
  disabled: boolean
  fileState: ManagedFileState
}

const FILE_STATE_SUFFIXES: ReadonlyArray<readonly [ManagedFileState, string]> = [
  ['disabled', '.0'],
  ['no_permission', '.无权限'],
  ['no_usage', '.无用量']
]

function safePart(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9@._+-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.slice(0, 80) || 'unknown'
}

function managedName(credential: GrokCredential, style: 'library' | 'cpa' = 'cpa'): string {
  if (style === 'library') {
    const identity = credential.email
      ? safePart(credential.email)
      : `unknown-${credential.id.slice(0, 10)}`
    return `${identity}_${safePart(credential.planType ?? 'unknown')}.json`
  }
  return `${MANAGED_PREFIX}${safePart(credential.email ?? credential.subject ?? 'unknown')}-${safePart(credential.planType ?? 'unknown')}-${credential.id.slice(0, 10)}.json`
}

function fileState(path: string): ManagedFileState {
  const lower = path.toLowerCase()
  return FILE_STATE_SUFFIXES.find(([, suffix]) => lower.endsWith(`.json${suffix}`))?.[0] ?? 'enabled'
}

function canonicalPath(path: string): string {
  const state = fileState(path)
  if (state === 'enabled') return path
  const suffix = FILE_STATE_SUFFIXES.find(([candidate]) => candidate === state)![1]
  return path.slice(0, -suffix.length)
}

function statePath(path: string, state: ManagedFileState): string {
  const base = canonicalPath(path)
  const suffix = FILE_STATE_SUFFIXES.find(([candidate]) => candidate === state)?.[1] ?? ''
  return `${base}${suffix}`
}

function formatForPath(path: string): CredentialSourceFormat | undefined {
  if (fileState(path) !== 'enabled') return 'json'
  return FORMATS[extname(path).toLowerCase()]
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

async function writeIfChanged(path: string, text: string): Promise<void> {
  try {
    if (await readFile(path, 'utf8') === text) return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await atomicWriteFile(path, text)
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
      else if (entry.isFile() && formatForPath(path)) result.push(path)
    }
  }
  return result.sort()
}

export class GrokAccountManager {
  constructor(private readonly options: GrokManagerOptions) {}

  private managedName(credential: GrokCredential): string {
    return managedName(credential, this.options.fileNameStyle)
  }

  async scanDirectory(): Promise<GrokScanResult> {
    const directory = await this.directory()
    await mkdir(directory, { recursive: true })
    return this.importPaths(await files(directory), true, false)
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
    await this.options.deletedStore?.removeMany(parsed.credentials.map((credential) => credential.id))
    return this.mergeImported(parsed.credentials, parsed.errors)
  }

  async listAccounts(): Promise<GrokAccountSummary[]> {
    const records = this.dedupeRecords(await this.managedCredentialRecords())
    const statuses = await this.options.statusStore.getAll()
    return records.map(({ credential, path, disabled }) => {
      const status = statuses[credential.id]
      return {
        id: credential.id,
        email: credential.email,
        subject: credential.subject,
        teamId: credential.teamId,
        planType: status?.usage?.planType ?? credential.planType,
        sourcePath: path,
        sourceFormat: credential.sourceFormat,
        sourceDialect: credential.sourceDialect,
        canRefresh: Boolean(credential.refreshToken),
        expiresAt: credential.expiresAt,
        lastRefresh: credential.lastRefresh,
        status: status?.status ?? 'untested',
        detail: status?.detail ?? '未测试',
        lastCheckedAt: status?.checkedAt ?? null,
        usage: status?.usage ?? null,
        disabled
      }
    }).sort((a, b) => (a.email ?? a.subject ?? '').localeCompare(b.email ?? b.subject ?? ''))
  }

  async deleteAccounts(ids: string[]): Promise<DeleteAccountsResult> {
    const selected = new Set(ids)
    const records = await this.managedCredentialRecords()
    const removed = records.filter((item) => selected.has(item.credential.id))
    const removedIds = [...new Set(removed.map((item) => item.credential.id))]
    await this.options.deletedStore?.addMany(removedIds)
    try {
      await Promise.all(removed.map((item) => rm(item.path, { force: true })))
      await this.options.statusStore.removeMany(removedIds)
    } catch (error) {
      await this.options.deletedStore?.removeMany(removedIds).catch(() => undefined)
      throw error
    }
    return { deleted: removedIds.length, message: `已删除 ${removedIds.length} 个 Grok 账号和对应的托管凭证文件` }
  }

  async setEnabled(ids: string[], enabled: boolean): Promise<ManagedFileStateResult> {
    return this.setFileState(ids, enabled ? 'enabled' : 'disabled')
  }

  private async setFileState(ids: string[], state: ManagedFileState): Promise<ManagedFileStateResult> {
    const selected = new Set(ids)
    const records = (await this.managedCredentialRecords()).filter((item) => selected.has(item.credential.id))
    const recordsById = new Map<string, typeof records>()
    for (const record of records) {
      const group = recordsById.get(record.credential.id) ?? []
      group.push(record)
      recordsById.set(record.credential.id, group)
    }
    const directory = await this.directory()
    let changed = 0
    let skipped = 0
    for (const id of selected) {
      const group = recordsById.get(id) ?? []
      const preferred = this.dedupeRecords(group)[0]
      if (!preferred) {
        skipped += 1
        continue
      }
      const target = statePath(join(directory, this.managedName(preferred.credential)), state)
      const targetRecord = group.find((item) => resolve(item.path).toLowerCase() === resolve(target).toLowerCase())
      if (!targetRecord) {
        await rename(preferred.path, target)
        changed += 1
      } else if (resolve(targetRecord.path).toLowerCase() !== resolve(preferred.path).toLowerCase()) {
        await atomicWriteFile(target, serialized(preferred.credential))
        changed += 1
      }
      const duplicates = group.filter((item) => resolve(item.path).toLowerCase() !== resolve(target).toLowerCase())
      if (duplicates.length) {
        await Promise.all(duplicates.map((item) => rm(item.path, { force: true })))
        if (targetRecord && resolve(targetRecord.path).toLowerCase() === resolve(preferred.path).toLowerCase()) changed += 1
      }
      if (!duplicates.length && targetRecord) skipped += 1
    }
    return {
      changed,
      skipped,
      message: `${state === 'enabled' ? '启用' : state === 'disabled' ? '停用' : state === 'no_permission' ? '标记无权限' : '标记无用量'} ${changed} 个 Grok 文件${skipped ? `，跳过 ${skipped}` : ''}`
    }
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
        if (tested.status === 'quota_exhausted_weekly' || tested.status === 'quota_exhausted_5h') {
          await this.setFileState([credential.id], 'no_usage')
        } else if (tested.status === 'invalid' && (tested.httpStatus === 401 || tested.httpStatus === 403)) {
          await this.setFileState([credential.id], 'no_permission')
        } else if (tested.status === 'valid') {
          await this.setFileState([credential.id], 'enabled')
        }
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
    const records = (await this.managedCredentialRecords()).filter((item) => item.credential.id === credential.id)
    const record = this.dedupeRecords(records)[0]
    const path = statePath(join(directory, this.managedName(credential)), record?.fileState ?? 'enabled')
    await atomicWriteFile(path, serialized({ ...credential, sourcePath: path, sourceFormat: 'json', sourceDialect: 'cpa' }))
    await Promise.all(records.filter((item) => resolve(item.path).toLowerCase() !== resolve(path).toLowerCase()).map((item) => rm(item.path, { force: true })))
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
      const path = join(directory, this.managedName(item))
      await atomicWriteFile(path, serialized(item))
      paths.push(path)
    }
    return paths
  }

  async copyAccountsTo(ids: string[] | undefined, target: GrokAccountManager): Promise<GrokScanResult> {
    const available = await this.listCredentials(false)
    const uniqueIds = ids ? [...new Set(ids)] : available.map((credential) => credential.id)
    const wanted = new Set(uniqueIds)
    const selected = new Map(
      available
        .filter((credential) => wanted.has(credential.id))
        .map((credential) => [credential.id, credential])
    )
    const missing = uniqueIds.find((id) => !selected.has(id))
    if (missing) throw new Error(`Grok 账号不存在：${missing}`)
    const credentials = uniqueIds.map((id) => selected.get(id)!)
    return target.importCredentialsAdditive(credentials)
  }

  async importCredentialsAdditive(values: readonly GrokCredential[]): Promise<GrokScanResult> {
    const incoming = dedupeGrokCredentials(values)
    const existing = await this.listCredentials()
    const existingIds = new Set(existing.map((credential) => credential.id))
    const existingEmails = new Set(existing.flatMap((credential) => credential.email ? [credential.email.toLowerCase()] : []))
    const fresh = incoming.filter((credential) =>
      !existingIds.has(credential.id) && (!credential.email || !existingEmails.has(credential.email.toLowerCase()))
    )
    if (fresh.length === 0) {
      return { imported: 0, skipped: incoming.length, errors: [], accounts: await this.listAccounts() }
    }
    await this.options.deletedStore?.removeMany(fresh.map((credential) => credential.id))
    const result = await this.mergeImported(fresh, [])
    return { ...result, skipped: result.skipped + incoming.length - fresh.length }
  }

  private async importPaths(
    paths: string[],
    normalizeDirectorySources = false,
    restoreDeleted = true
  ): Promise<GrokScanResult> {
    const credentials: GrokCredential[] = []
    const errors: string[] = []
    for (const path of paths) {
      const format = formatForPath(path)
      if (!format) continue
      try {
        const info = await stat(path)
        if (info.size > MAX_FILE_BYTES) throw new Error('文件超过 100MB')
        if (format === 'zip') {
          const archive = unzipSync(new Uint8Array(await readFile(path)))
          for (const [name, data] of Object.entries(archive)) {
            const nested = formatForPath(name)
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
    if (this.options.deletedStore) {
      if (restoreDeleted) {
        await this.options.deletedStore.removeMany(credentials.map((credential) => credential.id))
      } else {
        const deleted = await this.options.deletedStore.list()
        return this.mergeImported(
          credentials.filter((credential) => !deleted.has(credential.id)),
          errors,
          normalizeDirectorySources
        )
      }
    }
    return this.mergeImported(credentials, errors, normalizeDirectorySources)
  }

  private async mergeImported(
    importedValues: GrokCredential[],
    errors: string[],
    normalizeDirectorySources = false
  ): Promise<GrokScanResult> {
    const existingRecords = this.dedupeRecords(await this.managedCredentialRecords())
    const existing = existingRecords.map((item) => item.credential)
    const imported = dedupeGrokCredentials(importedValues)
    const existingIds = new Set(existing.map((item) => item.id))
    const importedCount = imported.filter((item) => !existingIds.has(item.id)).length
    const merged = dedupeGrokCredentials([...existing, ...imported])
    const stateById = new Map(existingRecords.map((item) => [item.credential.id, item.fileState]))
    for (const credential of imported) {
      if (!stateById.has(credential.id)) stateById.set(credential.id, fileState(credential.sourcePath))
    }
    const directory = await this.directory()
    await mkdir(directory, { recursive: true })
    const targets = new Map<string, string>()
    for (const credential of merged) {
      const path = statePath(join(directory, this.managedName(credential)), stateById.get(credential.id) ?? 'enabled')
      await writeIfChanged(path, serialized({ ...credential, sourcePath: path, sourceFormat: 'json', sourceDialect: 'cpa' }))
      targets.set(credential.id, path)
    }
    const normalizedTargets = new Map([...targets].map(([id, path]) => [id, resolve(path).toLowerCase()]))
    const duplicates = (await this.managedCredentialRecords()).filter((item) => {
      const target = normalizedTargets.get(item.credential.id)
      return target !== undefined && resolve(item.path).toLowerCase() !== target
    })
    await Promise.all(duplicates.map((item) => rm(item.path, { force: true })))
    if (normalizeDirectorySources) {
      const targetPaths = new Set([...targets.values()].map((path) => resolve(path).toLowerCase()))
      const sourcePaths = new Set(importedValues.map((item) => item.sourcePath))
      await Promise.all([...sourcePaths].map(async (path) => {
        if (path.includes('#') || targetPaths.has(resolve(path).toLowerCase())) return
        const format = formatForPath(path)
        if (!format || format === 'zip') return
        const text = await readFile(path, 'utf8').catch(() => null)
        if (text === null) return
        const containsCodex = parseCredentialText(text, { sourcePath: path, format }).credentials.length > 0
        if (!containsCodex) await rm(path, { force: true })
      }))
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
      return dedupeGrokCredentials(this.dedupeRecords(await this.managedCredentialRecords()).map((item) => item.credential))
    }
    const directory = await this.directory()
    await mkdir(directory, { recursive: true })
    const result: GrokCredential[] = []
    for (const path of await files(directory)) {
      const format = formatForPath(path)
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

  private dedupeRecords(records: ManagedRecord[]): ManagedRecord[] {
    const preferred = new Map<string, ManagedRecord>()
    for (const record of records) {
      const current = preferred.get(record.credential.id)
      if (!current || (current.disabled && !record.disabled)) preferred.set(record.credential.id, record)
    }
    return [...preferred.values()]
  }

  private async managedCredentialRecords(): Promise<ManagedRecord[]> {
    const directory = await this.directory()
    await mkdir(directory, { recursive: true })
    const result: ManagedRecord[] = []
    for (const path of await files(directory)) {
      const fileName = basename(canonicalPath(path))
      if (formatForPath(path) !== 'json' || (this.options.fileNameStyle !== 'library' && !fileName.startsWith(MANAGED_PREFIX))) continue
      try {
        const parsed = parseGrokCredentialText(await readFile(path, 'utf8'), { sourcePath: path, format: 'json' })
        if (parsed.credentials.length !== 1) continue
        const credential = parsed.credentials[0]
        if (fileName.toLowerCase() !== this.managedName(credential).toLowerCase()) continue
        const state = fileState(path)
        result.push({ path, credential, disabled: state !== 'enabled', fileState: state })
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
