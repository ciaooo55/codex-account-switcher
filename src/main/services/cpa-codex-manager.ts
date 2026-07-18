import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import type {
  AccountStatus,
  BatchTestResult,
  CodexTestMode,
  CpaCodexAccountSummary,
  CpaCodexScanResult,
  CredentialSourceFormat,
  DeleteAccountsResult,
  ManagedFileStateResult,
  NormalizedCredential,
  ScanResult,
  TestResult
} from '../../shared/types'
import { dedupeCredentials, parseCredentialText } from '../accounts/parser'
import { parseGrokCredentialText } from '../accounts/grok-parser'
import { atomicWriteFile } from '../storage/atomic-file'
import { DirectoryRecordIndex } from '../storage/directory-record-index'
import type { StatusStore } from '../storage/status-store'
import { serializeCpaCredential } from './exporter'

const FORMATS: Record<string, CredentialSourceFormat | undefined> = {
  '.json': 'json', '.jsonl': 'jsonl', '.txt': 'txt', '.md': 'md',
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.zip': 'zip'
}
const MAX_FILE_BYTES = 100 * 1024 * 1024
const MANAGED_PREFIX = 'codex-'

interface Options {
  directory: () => string | Promise<string>
  concurrency: () => number | Promise<number>
  statusStore: StatusStore
  deletedStore?: {
    list(): Promise<Set<string>>
    addMany(ids: string[]): Promise<void>
    removeMany(ids: string[]): Promise<void>
  }
  tester: {
    test(credential: NormalizedCredential, signal?: AbortSignal, mode?: CodexTestMode): Promise<TestResult>
  }
}

interface TestOptions {
  signal?: AbortSignal
  mode?: CodexTestMode
  onProgress?: (progress: {
    done: number
    total: number
    runningIds: string[]
    updatedAccount?: CpaCodexAccountSummary
  }) => void
}

interface ManagedRecord {
  path: string
  credential: NormalizedCredential
  disabled: boolean
  fileState: CpaFileState
}

type CpaFileState = 'enabled' | 'disabled' | 'no_permission' | 'no_usage'

const FILE_STATE_SUFFIXES: ReadonlyArray<readonly [CpaFileState, string]> = [
  ['disabled', '.0'],
  ['no_permission', '.无权限'],
  ['no_usage', '.无用量']
]

function safePart(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9@._+-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.slice(0, 80) || 'unknown'
}

function managedName(credential: NormalizedCredential): string {
  return `${MANAGED_PREFIX}${safePart(credential.email ?? credential.subject ?? 'unknown')}-${safePart(credential.planType ?? 'unknown')}-${credential.id.slice(0, 10)}.json`
}

function fileState(path: string): CpaFileState {
  const lower = path.toLowerCase()
  const matched = FILE_STATE_SUFFIXES.find(([, suffix]) => lower.endsWith(`.json${suffix}`))
  return matched?.[0] ?? 'enabled'
}

function canonicalPath(path: string): string {
  const state = fileState(path)
  if (state === 'enabled') return path
  const suffix = FILE_STATE_SUFFIXES.find(([candidate]) => candidate === state)![1]
  return path.slice(0, -suffix.length)
}

function statePath(path: string, state: CpaFileState): string {
  const base = canonicalPath(path)
  const suffix = FILE_STATE_SUFFIXES.find(([candidate]) => candidate === state)?.[1] ?? ''
  return `${base}${suffix}`
}

function formatForPath(path: string): CredentialSourceFormat | undefined {
  if (fileState(path) !== 'enabled') return 'json'
  return FORMATS[extname(path).toLowerCase()]
}

function serialized(credential: NormalizedCredential, priority?: number): string {
  return `${JSON.stringify({ ...serializeCpaCredential(credential, priority), disabled: false }, null, 2)}\n`
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
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
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

export class CpaCodexManager {
  private readonly recordIndex: DirectoryRecordIndex<ManagedRecord>
  private activeTestRecords: Map<string, ManagedRecord[]> | null = null

  constructor(private readonly options: Options) {
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

  async scanDirectory(): Promise<CpaCodexScanResult> {
    const directory = await this.directory()
    await mkdir(directory, { recursive: true })
    const parsed = await this.readPaths(await files(directory))
    const deleted = await this.options.deletedStore?.list()
    const credentials = deleted
      ? parsed.credentials.filter((credential) => !deleted.has(credential.id))
      : parsed.credentials
    return this.mergeImported(credentials, parsed.errors, true)
  }

  async importFiles(paths: string[]): Promise<CpaCodexScanResult> {
    const result = await this.readPaths(paths)
    await this.options.deletedStore?.removeMany(result.credentials.map((credential) => credential.id))
    return this.mergeImported(result.credentials, result.errors)
  }

  async importDirectory(directory: string): Promise<CpaCodexScanResult> {
    if (!(await stat(directory)).isDirectory()) throw new Error('选择的路径不是文件夹')
    return this.importPaths(await files(directory))
  }

  async importPasted(text: string): Promise<CpaCodexScanResult> {
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('粘贴内容超过安全限制')
    const parsed = parseCredentialText(text, { sourcePath: 'pasted-cpa-codex.json', format: 'paste' })
    await this.options.deletedStore?.removeMany(parsed.credentials.map((credential) => credential.id))
    return this.mergeImported(parsed.credentials, parsed.errors)
  }

  async exportCredentials(
    values: NormalizedCredential[],
    defaultPriority = 10,
    priorities: Readonly<Record<string, number>> = {}
  ): Promise<CpaCodexScanResult> {
    const directory = await this.directory()
    await mkdir(directory, { recursive: true })
    const incoming = dedupeCredentials(values)
    await this.options.deletedStore?.removeMany(incoming.map((credential) => credential.id))
    const records = await this.managedRecords()
    const managed = new Map(this.dedupeRecords(records).map((record) => [record.credential.id, record]))
    const parsed = await this.readPaths(await files(directory))
    const existing = new Map(dedupeCredentials(parsed.credentials).map((credential) => [credential.id, credential]))
    const sourceCounts = new Map<string, number>()
    for (const credential of parsed.credentials) {
      sourceCounts.set(credential.sourcePath, (sourceCounts.get(credential.sourcePath) ?? 0) + 1)
    }
    let imported = 0
    for (const credential of incoming) {
      const current = managed.get(credential.id)
      const previous = existing.get(credential.id)
      const reusableSource = previous && sourceCounts.get(previous.sourcePath) === 1 &&
        !previous.sourcePath.includes('#') && formatForPath(previous.sourcePath) === 'json'
        ? previous.sourcePath
        : null
      const target = current?.path ?? reusableSource ?? join(directory, managedName(credential))
      await atomicWriteFile(
        target,
        serialized(
          { ...credential, sourcePath: target, sourceFormat: 'json', sourceDialect: 'cpa' },
          priorities[credential.id] ?? defaultPriority
        )
      )
      const duplicatePaths = records
        .filter((record) => record.credential.id === credential.id && resolve(record.path).toLowerCase() !== resolve(target).toLowerCase())
        .map((record) => record.path)
      await Promise.all(duplicatePaths.map((path) => rm(path, { force: true })))
      if (!previous) imported += 1
    }
    this.recordIndex.invalidate()
    return {
      imported,
      skipped: incoming.length - imported,
      errors: parsed.errors,
      accounts: await this.listAccounts()
    }
  }

  async copyAccountsTo(
    ids: string[] | undefined,
    target: { importCredentialsAdditive(values: readonly NormalizedCredential[]): Promise<ScanResult> }
  ): Promise<ScanResult> {
    const parsed = await this.readPaths(await files(await this.directory()))
    const available = dedupeCredentials(parsed.credentials)
    const wanted = ids ? new Set(ids) : null
    const selected = available.filter((credential) => !wanted || wanted.has(credential.id))
    if (wanted) {
      const selectedIds = new Set(selected.map((credential) => credential.id))
      const missing = [...wanted].find((id) => !selectedIds.has(id))
      if (missing) throw new Error(`CPA Codex 账号不存在：${missing}`)
    }
    const result = await target.importCredentialsAdditive(selected)
    return { ...result, errors: [...parsed.errors, ...result.errors] }
  }

  async listAccounts(): Promise<CpaCodexAccountSummary[]> {
    const records = this.dedupeRecords(await this.managedRecords())
    const statuses = await this.options.statusStore.getAll()
    return records
      .map((record) => this.summarize(record, statuses[record.credential.id]))
      .sort((a, b) => (a.email ?? a.sourcePath).localeCompare(b.email ?? b.sourcePath))
  }

  async deleteAccounts(ids: string[]): Promise<DeleteAccountsResult> {
    const selected = new Set(ids)
    const directory = await this.directory()
    const paths = await files(directory)
    const existingIds = new Set<string>()
    await this.options.deletedStore?.addMany([...selected])
    try {
      for (const path of paths) {
        if (!/\.json(?:\.0|\.无权限|\.无用量)?$/i.test(path)) continue
        const text = await readFile(path, 'utf8').catch(() => null)
        if (text === null) continue
        const format = formatForPath(path)
        if (format !== 'json') continue
        const codex = parseCredentialText(text, { sourcePath: path, format: 'json' }).credentials
        const matched = codex.filter((item) => selected.has(item.id))
        if (matched.length === 0) continue
        for (const credential of matched) existingIds.add(credential.id)
        const remaining = dedupeCredentials(codex.filter((item) => !selected.has(item.id)))
        const containsGrok = parseGrokCredentialText(text, { sourcePath: path, format: 'json' }).credentials.length > 0
        if (containsGrok) continue

        const previousState = fileState(path)
        await rm(path, { force: true })
        for (const credential of remaining) {
          const target = statePath(join(directory, managedName(credential)), previousState)
          await atomicWriteFile(target, serialized({
            ...credential,
            sourcePath: target,
            sourceFormat: 'json',
            sourceDialect: 'cpa'
          }))
        }
      }
      if (existingIds.size === 0) {
        await this.options.deletedStore?.removeMany([...selected])
        return { deleted: 0, message: '没有找到要删除的 CPA Codex 账号' }
      }
      this.recordIndex.invalidate()
      await this.options.statusStore.removeMany([...existingIds])
    } catch (error) {
      await this.options.deletedStore?.removeMany([...selected]).catch(() => undefined)
      throw error
    }
    const removed = existingIds.size
    return { deleted: removed, message: `已删除 ${removed} 个 CPA Codex 账号及目录内全部同账号副本` }
  }

  async setEnabled(ids: string[], enabled: boolean): Promise<ManagedFileStateResult> {
    return this.setFileState(ids, enabled ? 'enabled' : 'disabled')
  }

  private async setFileState(ids: string[], state: CpaFileState): Promise<ManagedFileStateResult> {
    const selected = new Set(ids)
    const records = (await this.managedRecords()).filter((item) => selected.has(item.credential.id))
    const recordsById = new Map<string, ManagedRecord[]>()
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
      message: `${state === 'enabled' ? '启用' : state === 'disabled' ? '停用' : state === 'no_permission' ? '标记无权限' : '标记无用量'} ${changed} 个 CPA Codex 文件${skipped ? `，跳过 ${skipped}` : ''}`
    }
  }

  async testAccounts(ids?: string[], options: TestOptions = {}): Promise<BatchTestResult> {
    const wanted = ids ? new Set(ids) : null
    const allRecords = await this.managedRecords()
    this.activeTestRecords = this.groupRecords(allRecords)
    const records = this.dedupeRecords(allRecords)
      .filter((item) => !wanted || wanted.has(item.credential.id))
    const results: TestResult[] = []
    const running = new Set<string>()
    let cursor = 0
    let done = 0
    const previousStatuses = options.mode === 'refresh'
      ? await this.options.statusStore.getAll()
      : {}
    options.onProgress?.({ done, total: records.length, runningIds: [] })
    const worker = async (): Promise<void> => {
      while (!options.signal?.aborted) {
        const record = records[cursor++]
        if (!record) return
        running.add(record.credential.id)
        options.onProgress?.({ done, total: records.length, runningIds: [...running] })
        let tested: TestResult
        try {
          tested = await this.options.tester.test(record.credential, options.signal, options.mode ?? 'full')
        } catch {
          tested = {
            accountId: record.credential.id,
            status: 'network_error',
            detail: '检测任务异常终止',
            checkedAt: new Date().toISOString(),
            httpStatus: null,
            stage: 'local',
            refreshed: false,
            usage: null
          }
        }
        const previous = previousStatuses[record.credential.id]
        const storedResult = options.mode === 'refresh' && !tested.usage && previous?.usage
          ? { ...tested, usage: previous.usage }
          : tested
        results.push(storedResult)
        await this.options.statusStore.setBuffered(storedResult)
        let updatedRecord = this.dedupeRecords(this.activeTestRecords?.get(record.credential.id) ?? [record])[0]
        if (options.mode !== 'refresh') {
          const state = this.fileStateForStatus(storedResult.status)
          if (state) {
            updatedRecord = (await this.transitionRecordGroup(
              this.activeTestRecords?.get(record.credential.id) ?? [updatedRecord],
              state
            )).record ?? updatedRecord
          }
        }
        if (updatedRecord) this.activeTestRecords?.set(record.credential.id, [updatedRecord])
        running.delete(record.credential.id)
        done += 1
        options.onProgress?.({
          done,
          total: records.length,
          runningIds: [...running],
          ...(updatedRecord ? { updatedAccount: this.summarize(updatedRecord, storedResult) } : {})
        })
      }
    }
    const concurrency = Math.max(1, Math.min(12, await this.options.concurrency()))
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, worker))
      await this.options.statusStore.flush()
      return { tested: results.length, results, cancelled: Boolean(options.signal?.aborted) }
    } finally {
      this.activeTestRecords = null
      this.recordIndex.invalidate()
    }
  }

  async upsertRefreshed(credential: NormalizedCredential): Promise<void> {
    const records = this.activeTestRecords?.get(credential.id)
      ?? (await this.managedRecords()).filter((item) => item.credential.id === credential.id)
    const record = this.dedupeRecords(records)[0]
    const directory = await this.directory()
    const path = statePath(join(directory, managedName(credential)), record?.fileState ?? 'enabled')
    const storedCredential = { ...credential, sourcePath: path, sourceFormat: 'json' as const, sourceDialect: 'cpa' as const }
    await atomicWriteFile(path, serialized(storedCredential))
    await Promise.all(records.filter((item) => resolve(item.path).toLowerCase() !== resolve(path).toLowerCase()).map((item) => rm(item.path, { force: true })))
    const state = fileState(path)
    this.activeTestRecords?.set(credential.id, [{ path, credential: storedCredential, disabled: state !== 'enabled', fileState: state }])
    this.recordIndex.invalidate()
  }

  private async importPaths(paths: string[]): Promise<CpaCodexScanResult> {
    const parsed = await this.readPaths(paths)
    return this.mergeImported(parsed.credentials, parsed.errors)
  }

  private async readPaths(paths: string[]): Promise<{ credentials: NormalizedCredential[]; errors: string[] }> {
    const credentials: NormalizedCredential[] = []
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
            const parsed = parseCredentialText(strFromU8(data), { sourcePath: `${path}#${name}`, format: nested })
            credentials.push(...parsed.credentials)
          }
        } else {
          const parsed = parseCredentialText(await readFile(path, 'utf8'), { sourcePath: path, format })
          credentials.push(...parsed.credentials)
        }
      } catch (error) {
        errors.push(`${path}: ${error instanceof Error ? error.message : '读取失败'}`)
      }
    }
    return { credentials, errors }
  }

  private async mergeImported(
    values: NormalizedCredential[],
    errors: string[],
    normalizeDirectorySources = false
  ): Promise<CpaCodexScanResult> {
    const existingRecords = this.dedupeRecords(await this.managedRecords())
    const existing = existingRecords.map((item) => item.credential)
    const imported = dedupeCredentials(values)
    const existingIds = new Set(existing.map((item) => item.id))
    const importedCount = imported.filter((item) => !existingIds.has(item.id)).length
    const merged = dedupeCredentials([...existing, ...imported])
    const stateById = new Map(existingRecords.map((item) => [item.credential.id, item.fileState]))
    for (const credential of imported) {
      if (!stateById.has(credential.id)) stateById.set(credential.id, fileState(credential.sourcePath))
    }
    const directory = await this.directory()
    await mkdir(directory, { recursive: true })
    const targets = new Map<string, string>()
    for (const credential of merged) {
      const path = statePath(join(directory, managedName(credential)), stateById.get(credential.id) ?? 'enabled')
      await writeIfChanged(path, serialized({ ...credential, sourcePath: path, sourceFormat: 'json', sourceDialect: 'cpa' }))
      targets.set(credential.id, path)
    }
    this.recordIndex.invalidate()
    const normalizedTargets = new Map([...targets].map(([id, path]) => [id, resolve(path).toLowerCase()]))
    const duplicates = (await this.managedRecords()).filter((item) => {
      const target = normalizedTargets.get(item.credential.id)
      return target !== undefined && resolve(item.path).toLowerCase() !== target
    })
    await Promise.all(duplicates.map((item) => rm(item.path, { force: true })))
    if (normalizeDirectorySources) {
      const targetPaths = new Set([...targets.values()].map((path) => resolve(path).toLowerCase()))
      const sourcePaths = new Set(values.map((item) => item.sourcePath))
      await Promise.all([...sourcePaths].map(async (path) => {
        if (path.includes('#')) return
        const normalized = resolve(path).toLowerCase()
        if (targetPaths.has(normalized)) return
        const format = formatForPath(path)
        if (!format || format === 'zip') return
        const text = await readFile(path, 'utf8').catch(() => null)
        if (text === null) return
        const containsGrok = parseGrokCredentialText(text, { sourcePath: path, format }).credentials.length > 0
        if (!containsGrok) await rm(path, { force: true })
      }))
    }
    this.recordIndex.invalidate()
    return {
      imported: importedCount,
      skipped: imported.length - importedCount,
      errors,
      accounts: await this.listAccounts()
    }
  }

  private dedupeRecords(records: ManagedRecord[]): ManagedRecord[] {
    const preferred = new Map<string, ManagedRecord>()
    for (const record of records) {
      const current = preferred.get(record.credential.id)
      if (!current || (current.disabled && !record.disabled)) preferred.set(record.credential.id, record)
    }
    return [...preferred.values()]
  }

  private async managedRecords(): Promise<ManagedRecord[]> {
    const directory = await this.directory()
    await mkdir(directory, { recursive: true })
    return this.recordIndex.list()
  }

  private async loadManagedRecord(path: string): Promise<ManagedRecord[]> {
    if (!basename(canonicalPath(path)).startsWith(MANAGED_PREFIX) || formatForPath(path) !== 'json') return []
    try {
      const parsed = parseCredentialText(await readFile(path, 'utf8'), { sourcePath: path, format: 'json' })
      if (parsed.credentials.length !== 1) return []
      const credential = parsed.credentials[0]
      if (basename(canonicalPath(path)).toLowerCase() !== managedName(credential).toLowerCase()) return []
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

  private fileStateForStatus(status: AccountStatus): CpaFileState | null {
    if (['quota_exhausted', 'quota_exhausted_5h', 'quota_exhausted_weekly'].includes(status)) return 'no_usage'
    if (status === 'no_permission') return 'no_permission'
    if (status === 'valid') return 'enabled'
    return null
  }

  private async transitionRecordGroup(
    group: readonly ManagedRecord[],
    state: CpaFileState
  ): Promise<{ changed: number; skipped: number; record: ManagedRecord | null }> {
    const preferred = this.dedupeRecords([...group])[0]
    if (!preferred) return { changed: 0, skipped: 1, record: null }
    const directory = await this.directory()
    const target = statePath(join(directory, managedName(preferred.credential)), state)
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

  private summarize(record: ManagedRecord, status?: TestResult): CpaCodexAccountSummary {
    const { credential, path, disabled } = record
    return {
      id: credential.id,
      email: credential.email,
      workspaceId: credential.accountId,
      planType: status?.usage?.planType ?? credential.planType,
      sourcePath: path,
      sourceDialect: credential.sourceDialect,
      canRefresh: credential.canRefresh,
      accessExpiresAt: credential.accessExpiresAt,
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
