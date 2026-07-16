import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import type {
  AccountStatus,
  BatchTestResult,
  CpaCodexAccountSummary,
  CpaCodexScanResult,
  CredentialSourceFormat,
  DeleteAccountsResult,
  ManagedFileStateResult,
  NormalizedCredential,
  TestResult
} from '../../shared/types'
import { dedupeCredentials, parseCredentialText } from '../accounts/parser'
import { parseGrokCredentialText } from '../accounts/grok-parser'
import { atomicWriteFile } from '../storage/atomic-file'
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
    test(credential: NormalizedCredential, signal?: AbortSignal): Promise<TestResult>
  }
}

interface TestOptions {
  signal?: AbortSignal
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
}

function safePart(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9@._+-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.slice(0, 80) || 'unknown'
}

function managedName(credential: NormalizedCredential): string {
  return `${MANAGED_PREFIX}${safePart(credential.email ?? credential.subject ?? 'unknown')}-${safePart(credential.planType ?? 'unknown')}-${credential.id.slice(0, 10)}.json`
}

function isDisabled(path: string): boolean {
  return path.toLowerCase().endsWith('.json.0')
}

function enabledPath(path: string): string {
  return isDisabled(path) ? path.slice(0, -2) : path
}

function statePath(path: string, enabled: boolean): string {
  const base = enabledPath(path)
  return enabled ? base : `${base}.0`
}

function formatForPath(path: string): CredentialSourceFormat | undefined {
  if (isDisabled(path)) return 'json'
  return FORMATS[extname(path).toLowerCase()]
}

function serialized(credential: NormalizedCredential): string {
  return `${JSON.stringify({ ...serializeCpaCredential(credential), disabled: false }, null, 2)}\n`
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
  constructor(private readonly options: Options) {}

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

  async exportCredentials(values: NormalizedCredential[]): Promise<CpaCodexScanResult> {
    const directory = await this.directory()
    await mkdir(directory, { recursive: true })
    const incoming = dedupeCredentials(values)
    await this.options.deletedStore?.removeMany(incoming.map((credential) => credential.id))
    const existing = await this.readPaths(await files(directory))
    const existingIds = new Set(dedupeCredentials(existing.credentials).map((item) => item.id))
    const fresh = incoming.filter((item) => !existingIds.has(item.id))
    const result = await this.mergeImported(fresh, [])
    return {
      ...result,
      imported: fresh.length,
      skipped: incoming.length - fresh.length,
      errors: existing.errors,
      accounts: await this.listAccounts()
    }
  }

  async listAccounts(): Promise<CpaCodexAccountSummary[]> {
    const records = this.dedupeRecords(await this.managedRecords())
    const statuses = await this.options.statusStore.getAll()
    return records.map(({ credential, path, disabled }) => {
      const status = statuses[credential.id]
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
    }).sort((a, b) => (a.email ?? a.sourcePath).localeCompare(b.email ?? b.sourcePath))
  }

  async deleteAccounts(ids: string[]): Promise<DeleteAccountsResult> {
    const selected = new Set(ids)
    const directory = await this.directory()
    const paths = await files(directory)
    const existingIds = new Set<string>()
    await this.options.deletedStore?.addMany([...selected])
    try {
      for (const path of paths) {
        if (!/\.json(?:\.0)?$/i.test(path)) continue
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

        const disabled = isDisabled(path)
        await rm(path, { force: true })
        for (const credential of remaining) {
          const target = statePath(join(directory, managedName(credential)), !disabled)
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
      await this.options.statusStore.removeMany([...existingIds])
    } catch (error) {
      await this.options.deletedStore?.removeMany([...selected]).catch(() => undefined)
      throw error
    }
    const removed = existingIds.size
    return { deleted: removed, message: `已删除 ${removed} 个 CPA Codex 账号及目录内全部同账号副本` }
  }

  async setEnabled(ids: string[], enabled: boolean): Promise<ManagedFileStateResult> {
    const selected = new Set(ids)
    const records = (await this.managedRecords()).filter((item) => selected.has(item.credential.id))
    const recordsById = new Map<string, ManagedRecord[]>()
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
      const target = statePath(join(directory, managedName(preferred.credential)), enabled)
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
      message: `${enabled ? '启用' : '停用'} ${changed} 个 CPA Codex 文件${skipped ? `，跳过 ${skipped}` : ''}`
    }
  }

  async testAccounts(ids?: string[], options: TestOptions = {}): Promise<BatchTestResult> {
    const wanted = ids ? new Set(ids) : null
    const records = this.dedupeRecords(await this.managedRecords())
      .filter((item) => !wanted || wanted.has(item.credential.id))
    const results: TestResult[] = []
    const running = new Set<string>()
    let cursor = 0
    let done = 0
    options.onProgress?.({ done, total: records.length, runningIds: [] })
    const worker = async (): Promise<void> => {
      while (!options.signal?.aborted) {
        const record = records[cursor++]
        if (!record) return
        running.add(record.credential.id)
        options.onProgress?.({ done, total: records.length, runningIds: [...running] })
        let tested: TestResult
        try {
          tested = await this.options.tester.test(record.credential, options.signal)
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
        results.push(tested)
        await this.options.statusStore.set(tested)
        await this.applyQuotaFileState(record.credential.id, tested.status)
        running.delete(record.credential.id)
        done += 1
        const updatedAccount = (await this.listAccounts()).find((item) => item.id === record.credential.id)
        options.onProgress?.({ done, total: records.length, runningIds: [...running], ...(updatedAccount ? { updatedAccount } : {}) })
      }
    }
    const concurrency = Math.max(1, Math.min(12, await this.options.concurrency()))
    await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, worker))
    return { tested: results.length, results, cancelled: Boolean(options.signal?.aborted) }
  }

  async upsertRefreshed(credential: NormalizedCredential): Promise<void> {
    const records = (await this.managedRecords()).filter((item) => item.credential.id === credential.id)
    const record = this.dedupeRecords(records)[0]
    const directory = await this.directory()
    const path = statePath(join(directory, managedName(credential)), !record?.disabled)
    await atomicWriteFile(path, serialized({ ...credential, sourcePath: path, sourceFormat: 'json', sourceDialect: 'cpa' }))
    await Promise.all(records.filter((item) => resolve(item.path).toLowerCase() !== resolve(path).toLowerCase()).map((item) => rm(item.path, { force: true })))
  }

  private async applyQuotaFileState(id: string, status: AccountStatus): Promise<void> {
    if (status === 'quota_exhausted_weekly') await this.setEnabled([id], false)
    else if (status === 'valid') await this.setEnabled([id], true)
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
    const stateById = new Map(existingRecords.map((item) => [item.credential.id, item.disabled]))
    for (const credential of imported) {
      if (!stateById.has(credential.id)) stateById.set(credential.id, isDisabled(credential.sourcePath))
    }
    const directory = await this.directory()
    await mkdir(directory, { recursive: true })
    const targets = new Map<string, string>()
    for (const credential of merged) {
      const path = statePath(join(directory, managedName(credential)), !stateById.get(credential.id))
      await writeIfChanged(path, serialized({ ...credential, sourcePath: path, sourceFormat: 'json', sourceDialect: 'cpa' }))
      targets.set(credential.id, path)
    }
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
    const result: ManagedRecord[] = []
    for (const path of await files(directory)) {
      if (!basename(enabledPath(path)).startsWith(MANAGED_PREFIX) || formatForPath(path) !== 'json') continue
      try {
        const parsed = parseCredentialText(await readFile(path, 'utf8'), { sourcePath: path, format: 'json' })
        if (parsed.credentials.length !== 1) continue
        const credential = parsed.credentials[0]
        if (basename(enabledPath(path)).toLowerCase() !== managedName(credential).toLowerCase()) continue
        result.push({ path, credential, disabled: isDisabled(path) })
      } catch {
        // Similar user filenames are not treated as managed CPA files.
      }
    }
    return result
  }

  private async directory(): Promise<string> {
    return resolve(await this.options.directory())
  }
}
