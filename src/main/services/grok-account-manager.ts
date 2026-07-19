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
  ImportSourceIssue,
  ManagedFileStateResult
} from '../../shared/types'
import { dedupeGrokCredentials, parseGrokCredentialText } from '../accounts/grok-parser'
import { atomicWriteFile } from '../storage/atomic-file'
import { DirectoryRecordIndex } from '../storage/directory-record-index'
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
  onCredentialsChanged?: () => Promise<void>
  onStatusesChanged?: () => Promise<void>
}

interface TestOptions {
  signal?: AbortSignal
  onProgress?: (progress: { done: number; total: number; runningIds: string[]; updatedAccount?: GrokAccountSummary }) => void
}

export interface GrokImportPreparation {
  credentials: GrokCredential[]
  errors: string[]
  recognized: number
  sourceCount: number
  unrecognized?: ImportSourceIssue[]
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

function sameGrokIdentity(left: GrokCredential, right: GrokCredential): boolean {
  if (left.id === right.id) return true
  if (left.email && right.email && left.email.toLowerCase() === right.email.toLowerCase()) return true
  return Boolean(left.subject && right.subject && left.subject === right.subject)
}

function sameGrokMaterial(left: GrokCredential, right: GrokCredential): boolean {
  return left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.idToken === right.idToken &&
    left.teamId === right.teamId
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
  private readonly recordIndex: DirectoryRecordIndex<ManagedRecord>
  private activeTestRecords: Map<string, ManagedRecord[]> | null = null

  constructor(private readonly options: GrokManagerOptions) {
    this.recordIndex = new DirectoryRecordIndex({
      directory: async () => {
        const directory = await this.directory()
        await mkdir(directory, { recursive: true })
        return directory
      },
      collectPaths: files,
      loadPath: (path) => this.loadManagedRecord(path)
    })
  }

  private managedName(credential: GrokCredential): string {
    return managedName(credential, this.options.fileNameStyle)
  }

  async scanDirectory(): Promise<GrokScanResult> {
    const directory = await this.directory()
    await mkdir(directory, { recursive: true })
    return this.commitPreparedWithOptions(
      await this.prepareFiles(await files(directory)),
      true,
      false
    )
  }

  async importDirectory(directory: string): Promise<GrokScanResult> {
    return this.importPrepared(await this.prepareDirectory(directory))
  }

  async importFiles(paths: string[]): Promise<GrokScanResult> {
    return this.importPrepared(await this.prepareFiles(paths))
  }

  async importPasted(text: string): Promise<GrokScanResult> {
    return this.importPrepared(await this.preparePasted(text))
  }

  async prepareDirectory(directory: string): Promise<GrokImportPreparation> {
    if (!(await stat(directory)).isDirectory()) throw new Error('选择的路径不是文件夹')
    return this.prepareFiles(await files(directory))
  }

  async preparePasted(text: string): Promise<GrokImportPreparation> {
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('粘贴内容超过安全限制')
    const parsed = parseGrokCredentialText(text, { sourcePath: 'pasted-grok.json', format: 'paste' })
    const credentials = dedupeGrokCredentials(parsed.credentials)
    return {
      credentials,
      errors: parsed.errors,
      recognized: credentials.length,
      sourceCount: 1,
      unrecognized: credentials.length === 0
        ? [{ sourcePath: 'pasted-grok.json', sourceFormat: 'paste', detail: parsed.errors.at(-1) ?? '未找到可用 Grok 凭据' }]
        : []
    }
  }

  async importPrepared(prepared: GrokImportPreparation): Promise<GrokScanResult> {
    await this.options.deletedStore?.removeMany(
      prepared.credentials.map((credential) => credential.id)
    )
    return this.mergeImported(prepared.credentials, prepared.errors)
  }

  async listAccounts(): Promise<GrokAccountSummary[]> {
    const records = this.dedupeRecords(await this.managedCredentialRecords())
    const statuses = await this.options.statusStore.getAll()
    return records
      .map((record) => this.summarize(record, statuses[record.credential.id]))
      .sort((a, b) => (a.email ?? a.subject ?? '').localeCompare(b.email ?? b.subject ?? ''))
  }

  async deleteAccounts(ids: string[]): Promise<DeleteAccountsResult> {
    const selected = new Set(ids)
    const records = await this.managedCredentialRecords()
    const removed = records.filter((item) => selected.has(item.credential.id))
    const removedIds = [...new Set(removed.map((item) => item.credential.id))]
    await this.options.deletedStore?.addMany(removedIds)
    try {
      await Promise.all(removed.map((item) => rm(item.path, { force: true })))
      this.recordIndex.invalidate()
      await this.options.statusStore.removeMany(removedIds)
      await this.options.onCredentialsChanged?.()
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
    let changed = 0
    let skipped = 0
    for (const id of selected) {
      const group = recordsById.get(id) ?? []
      const transition = await this.transitionRecordGroup(group, state)
      changed += transition.changed
      skipped += transition.skipped
    }
    this.recordIndex.invalidate()
    return {
      changed,
      skipped,
      message: `${state === 'enabled' ? '启用' : state === 'disabled' ? '停用' : state === 'no_permission' ? '标记无权限' : '标记无用量'} ${changed} 个 Grok 文件${skipped ? `，跳过 ${skipped}` : ''}`
    }
  }

  async testAccounts(ids?: string[], options: TestOptions = {}): Promise<GrokBatchTestResult> {
    const wanted = ids ? new Set(ids) : null
    const allRecords = await this.managedCredentialRecords()
    const recordsById = this.groupRecords(allRecords)
    this.activeTestRecords = recordsById
    const records = this.dedupeRecords(allRecords).filter((item) => !wanted || wanted.has(item.credential.id))
    const results: GrokTestResult[] = []
    const running = new Set<string>()
    let cursor = 0
    let done = 0
    options.onProgress?.({ done, total: records.length, runningIds: [] })
    const worker = async (): Promise<void> => {
      while (!options.signal?.aborted) {
        const initialRecord = records[cursor++]
        if (!initialRecord) return
        const credential = initialRecord.credential
        running.add(credential.id)
        options.onProgress?.({ done, total: records.length, runningIds: [...running] })
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
        await this.options.statusStore.setBuffered(tested)
        let updatedRecord = this.dedupeRecords(this.activeTestRecords?.get(credential.id) ?? [initialRecord])[0]
        if (this.options.fileNameStyle !== 'library') {
          if (tested.status === 'quota_exhausted_weekly' || tested.status === 'quota_exhausted_5h') {
            updatedRecord = (await this.transitionRecordGroup(this.activeTestRecords?.get(credential.id) ?? [updatedRecord], 'no_usage')).record ?? updatedRecord
          } else if (tested.status === 'invalid' && (tested.httpStatus === 401 || tested.httpStatus === 403)) {
            updatedRecord = (await this.transitionRecordGroup(this.activeTestRecords?.get(credential.id) ?? [updatedRecord], 'no_permission')).record ?? updatedRecord
          } else if (tested.status === 'valid') {
            updatedRecord = (await this.transitionRecordGroup(this.activeTestRecords?.get(credential.id) ?? [updatedRecord], 'enabled')).record ?? updatedRecord
          }
        }
        if (updatedRecord) this.activeTestRecords?.set(credential.id, [updatedRecord])
        running.delete(credential.id)
        done += 1
        options.onProgress?.({
          done,
          total: records.length,
          runningIds: [...running],
          ...(updatedRecord ? { updatedAccount: this.summarize(updatedRecord, tested) } : {})
        })
      }
    }
    const concurrency = Math.max(1, Math.min(12, await this.options.concurrency()))
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, worker))
      await this.options.statusStore.flush()
      await this.options.onStatusesChanged?.()
      return { tested: results.length, results, cancelled: Boolean(options.signal?.aborted) }
    } finally {
      this.activeTestRecords = null
      this.recordIndex.invalidate()
    }
  }

  async upsertRefreshed(credential: GrokCredential): Promise<void> {
    const directory = await this.directory()
    const records = this.activeTestRecords?.get(credential.id)
      ?? (await this.managedCredentialRecords()).filter((item) => item.credential.id === credential.id)
    const record = this.dedupeRecords(records)[0]
    const path = statePath(join(directory, this.managedName(credential)), record?.fileState ?? 'enabled')
    const storedCredential = { ...credential, sourcePath: path, sourceFormat: 'json' as const, sourceDialect: 'cpa' as const }
    await atomicWriteFile(path, serialized(storedCredential))
    await Promise.all(records.filter((item) => resolve(item.path).toLowerCase() !== resolve(path).toLowerCase()).map((item) => rm(item.path, { force: true })))
    const state = fileState(path)
    this.activeTestRecords?.set(credential.id, [{ path, credential: storedCredential, disabled: state !== 'enabled', fileState: state }])
    this.recordIndex.invalidate()
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

  async prepareFiles(paths: string[]): Promise<GrokImportPreparation> {
    const credentials: GrokCredential[] = []
    const errors: string[] = []
    const unrecognized: ImportSourceIssue[] = []
    for (const path of paths) {
      const format = formatForPath(path)
      if (!format) continue
      try {
        const info = await stat(path)
        if (info.size > MAX_FILE_BYTES) throw new Error('文件超过 100MB')
        if (format === 'zip') {
          const archive = unzipSync(new Uint8Array(await readFile(path)))
          let zipEntryUnrecognized = false
          for (const [name, data] of Object.entries(archive)) {
            const nested = formatForPath(name)
            if (!nested || nested === 'zip') continue
            const parsed = parseGrokCredentialText(strFromU8(data), { sourcePath: `${path}#${name}`, format: nested })
            credentials.push(...parsed.credentials)
            errors.push(...parsed.errors)
            zipEntryUnrecognized ||= parsed.credentials.length === 0
          }
          if (zipEntryUnrecognized) {
            unrecognized.push({
              sourcePath: path,
              sourceFormat: format,
              detail: 'ZIP 中有一个或多个条目未找到可用 Grok 凭据'
            })
          }
        } else {
          const parsed = parseGrokCredentialText(await readFile(path, 'utf8'), { sourcePath: path, format })
          credentials.push(...parsed.credentials)
          errors.push(...parsed.errors)
          if (parsed.credentials.length === 0) {
            unrecognized.push({
              sourcePath: path,
              sourceFormat: format,
              detail: parsed.errors.at(-1) ?? '未找到可用 Grok 凭据'
            })
          }
        }
      } catch (error) {
        const detail = `${path}: ${error instanceof Error ? error.message : '读取失败'}`
        errors.push(detail)
        unrecognized.push({ sourcePath: path, sourceFormat: format, detail })
      }
    }
    const deduped = dedupeGrokCredentials(credentials)
    return {
      credentials: deduped,
      errors,
      recognized: deduped.length,
      sourceCount: paths.length,
      unrecognized
    }
  }

  private async commitPreparedWithOptions(
    prepared: GrokImportPreparation,
    normalizeDirectorySources = false,
    restoreDeleted = true
  ): Promise<GrokScanResult> {
    const credentials = prepared.credentials
    if (this.options.deletedStore) {
      if (restoreDeleted) {
        await this.options.deletedStore.removeMany(credentials.map((credential) => credential.id))
      } else {
        const deleted = await this.options.deletedStore.list()
        return this.mergeImported(
          credentials.filter((credential) => !deleted.has(credential.id)),
          prepared.errors,
          normalizeDirectorySources
        )
      }
    }
    return this.mergeImported(credentials, prepared.errors, normalizeDirectorySources)
  }

  private async mergeImported(
    importedValues: GrokCredential[],
    errors: string[],
    normalizeDirectorySources = false
  ): Promise<GrokScanResult> {
    const existingRecords = this.dedupeRecords(await this.managedCredentialRecords())
    const existing = existingRecords.map((item) => item.credential)
    const imported = dedupeGrokCredentials(importedValues)
    const freshCredentials = imported.filter((item) =>
      !existing.some((current) => sameGrokIdentity(current, item))
    )
    const changedExistingIds = existing
      .filter((current) => imported.some((item) =>
        sameGrokIdentity(current, item) && !sameGrokMaterial(current, item)
      ))
      .map((credential) => credential.id)
    const importedCount = freshCredentials.length
    const merged = dedupeGrokCredentials([...existing, ...imported])
    const stateById = new Map<string, ManagedFileState>()
    for (const credential of merged) {
      const current = existingRecords.find((record) => sameGrokIdentity(record.credential, credential))
      if (current) stateById.set(credential.id, current.fileState)
    }
    for (const credential of imported) {
      const mergedCredential = merged.find((candidate) => sameGrokIdentity(candidate, credential)) ?? credential
      if (!stateById.has(mergedCredential.id)) {
        stateById.set(
          mergedCredential.id,
          this.options.fileNameStyle !== 'library' ? fileState(credential.sourcePath) : 'enabled'
        )
      }
    }
    const directory = await this.directory()
    await mkdir(directory, { recursive: true })
    const targets = new Map<string, string>()
    for (const credential of merged) {
      const path = statePath(join(directory, this.managedName(credential)), stateById.get(credential.id) ?? 'enabled')
      await writeIfChanged(path, serialized({ ...credential, sourcePath: path, sourceFormat: 'json', sourceDialect: 'cpa' }))
      targets.set(credential.id, path)
    }
    this.recordIndex.invalidate()
    const duplicates = (await this.managedCredentialRecords()).filter((item) => {
      const mergedCredential = merged.find((credential) => sameGrokIdentity(credential, item.credential))
      const target = mergedCredential ? targets.get(mergedCredential.id) : undefined
      return target !== undefined && resolve(item.path).toLowerCase() !== resolve(target).toLowerCase()
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
    this.recordIndex.invalidate()
    const affectedFinalIds = merged
      .filter((credential) => imported.some((incoming) => sameGrokIdentity(credential, incoming)))
      .map((credential) => credential.id)
    await this.options.statusStore.removeMany([
      ...new Set([
        ...freshCredentials.map((credential) => credential.id),
        ...changedExistingIds,
        ...(changedExistingIds.length > 0 ? affectedFinalIds : [])
      ])
    ])
    await this.options.onCredentialsChanged?.()
    return {
      imported: importedCount,
      skipped: imported.length - importedCount,
      errors,
      accounts: await this.listAccounts()
    }
  }

  async listCredentials(managedOnly = true): Promise<GrokCredential[]> {
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
    return this.recordIndex.list()
  }

  private async loadManagedRecord(path: string): Promise<ManagedRecord[]> {
    const fileName = basename(canonicalPath(path))
    if (formatForPath(path) !== 'json' || (this.options.fileNameStyle !== 'library' && !fileName.startsWith(MANAGED_PREFIX))) return []
    try {
      const parsed = parseGrokCredentialText(await readFile(path, 'utf8'), { sourcePath: path, format: 'json' })
      if (parsed.credentials.length !== 1) return []
      const credential = parsed.credentials[0]
      if (fileName.toLowerCase() !== this.managedName(credential).toLowerCase()) return []
      const state = fileState(path)
      return [{ path, credential, disabled: state !== 'enabled', fileState: state }]
    } catch {
      return []
    }
  }

  private groupRecords(records: readonly ManagedRecord[]): Map<string, ManagedRecord[]> {
    const grouped = new Map<string, ManagedRecord[]>()
    for (const record of records) {
      const group = grouped.get(record.credential.id) ?? []
      group.push(record)
      grouped.set(record.credential.id, group)
    }
    return grouped
  }

  private async transitionRecordGroup(
    group: readonly ManagedRecord[],
    state: ManagedFileState
  ): Promise<{ changed: number; skipped: number; record: ManagedRecord | null }> {
    const preferred = this.dedupeRecords([...group])[0]
    if (!preferred) return { changed: 0, skipped: 1, record: null }
    const directory = await this.directory()
    const target = statePath(join(directory, this.managedName(preferred.credential)), state)
    const targetKey = resolve(target).toLowerCase()
    const targetRecord = group.find((item) => resolve(item.path).toLowerCase() === targetKey)
    let changed = 0
    if (!targetRecord) {
      await rename(preferred.path, target)
      changed += 1
    } else if (resolve(preferred.path).toLowerCase() !== targetKey) {
      await atomicWriteFile(target, serialized(preferred.credential))
      changed += 1
    }
    const duplicates = group.filter((item) => resolve(item.path).toLowerCase() !== targetKey)
    if (duplicates.length > 0) {
      await Promise.all(duplicates.map((item) => rm(item.path, { force: true })))
      if (targetRecord && resolve(preferred.path).toLowerCase() === targetKey) changed += 1
    }
    const credential = {
      ...preferred.credential,
      sourcePath: target,
      sourceFormat: 'json' as const,
      sourceDialect: 'cpa' as const
    }
    this.recordIndex.invalidate()
    return {
      changed,
      skipped: changed === 0 ? 1 : 0,
      record: { path: target, credential, disabled: state !== 'enabled', fileState: state }
    }
  }

  private summarize(record: ManagedRecord, status?: GrokTestResult): GrokAccountSummary {
    const { credential, path, disabled } = record
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
  }

  private async directory(): Promise<string> {
    return resolve(await this.options.directory())
  }
}
