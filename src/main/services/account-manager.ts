import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import type {
  AccountSummary,
  AppSettings,
  AutoSwitchRunResult,
  BatchTestResult,
  CredentialSourceFormat,
  DeleteAccountsResult,
  NormalizedCredential,
  ScanResult,
  SwitchResult,
  TestResult
} from '../../shared/types'
import { dedupeCredentials, parseCredentialText } from '../accounts/parser'
import { ManagedCredentialLibrary } from '../storage/managed-library'
import type { CredentialVault } from '../storage/vault'
import type { StatusStore } from '../storage/status-store'

interface TesterLike {
  test(credential: NormalizedCredential, signal?: AbortSignal): Promise<TestResult>
}

interface SwitcherLike {
  switchTo(credential: NormalizedCredential): Promise<SwitchResult>
  restoreLatest(): Promise<SwitchResult>
  restoreApiMode(): Promise<SwitchResult>
}

interface AccountManagerOptions {
  settings: () => AppSettings | Promise<AppSettings>
  vault: CredentialVault
  statusStore: StatusStore
  tester: TesterLike
  switcher: SwitcherLike
  managedImportDirectory?: string
  deletedStore?: {
    list(): Promise<Set<string>>
    addMany(ids: string[]): Promise<void>
    removeMany(ids: string[]): Promise<void>
  }
}

interface ImportFilesOptions {
  archiveSources?: boolean
  restoreDeleted?: boolean
}

interface ManagerTestProgress {
  done: number
  total: number
  runningIds: string[]
  updatedAccount?: AccountSummary
}

interface TestAccountsOptions {
  signal?: AbortSignal
  onProgress?: (progress: ManagerTestProgress) => void
}

const FORMAT_BY_EXTENSION: Record<string, CredentialSourceFormat | undefined> = {
  '.json': 'json',
  '.jsonl': 'jsonl',
  '.txt': 'txt',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.md': 'md',
  '.zip': 'zip'
}

const MAX_SCAN_DEPTH = 32
const MAX_SCAN_FILES = 20_000
const MAX_ZIP_BYTES = 25 * 1024 * 1024
const MAX_ZIP_ENTRIES = 2_000
const MAX_ZIP_ENTRY_BYTES = 20 * 1024 * 1024
const MAX_ZIP_TOTAL_BYTES = 100 * 1024 * 1024
const MAX_SOURCE_FILE_BYTES = 100 * 1024 * 1024

async function collectSupportedFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  const stack = [{ directory, depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.depth > MAX_SCAN_DEPTH) continue
    const entries = await readdir(current.directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(current.directory, entry.name)
      if (entry.isDirectory()) stack.push({ directory: path, depth: current.depth + 1 })
      else if (entry.isFile() && FORMAT_BY_EXTENSION[extname(entry.name).toLowerCase()]) {
        files.push(path)
        if (files.length > MAX_SCAN_FILES) throw new Error('账号目录文件数量超过安全限制')
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right))
}

export class AccountManager {
  private readonly managedLibrary: ManagedCredentialLibrary | null

  constructor(private readonly options: AccountManagerOptions) {
    this.managedLibrary = options.managedImportDirectory
      ? new ManagedCredentialLibrary(options.managedImportDirectory)
      : null
  }

  async scanDirectory(): Promise<ScanResult> {
    const settings = await this.options.settings()
    const directory = this.options.managedImportDirectory ?? settings.accountDirectory
    await mkdir(directory, { recursive: true })
    const paths = await collectSupportedFiles(directory)
    const result = await this.importFiles(paths, {
      archiveSources: false,
      restoreDeleted: false
    })
    return { ...result, accounts: await this.listAccounts() }
  }

  async importDirectory(directory: string): Promise<ScanResult> {
    const info = await stat(directory)
    if (!info.isDirectory()) throw new Error('选择的路径不是文件夹')
    return this.importFiles(await collectSupportedFiles(directory), {
      archiveSources: true,
      restoreDeleted: true
    })
  }

  async importFiles(paths: string[], options: ImportFilesOptions = {}): Promise<ScanResult> {
    const credentials: NormalizedCredential[] = []
    const errors: string[] = []
    let skipped = 0
    for (const path of paths) {
      const format = FORMAT_BY_EXTENSION[extname(path).toLowerCase()]
      if (!format) {
        skipped += 1
        continue
      }
      try {
        const parsed = await this.parseCredentialFile(path, format)
        credentials.push(...parsed.credentials)
        errors.push(...parsed.errors)
      } catch (error) {
        errors.push(`${path}: ${error instanceof Error ? error.message : '读取失败'}`)
      }
    }
    let deduped = dedupeCredentials(credentials)
    if (this.options.deletedStore) {
      if (options.restoreDeleted === false) {
        const deleted = await this.options.deletedStore.list()
        deduped = deduped.filter((credential) => !deleted.has(credential.id))
      } else {
        await this.options.deletedStore.removeMany(deduped.map((credential) => credential.id))
      }
    }
    const existing = dedupeCredentials(await this.options.vault.list())
    const existingIds = new Set(existing.map((credential) => credential.id))
    const imported = deduped.filter((credential) => !existingIds.has(credential.id)).length
    skipped += deduped.length - imported
    const merged = dedupeCredentials([...existing, ...deduped])
    const stored = await this.persistManagedLibrary(merged, existing)
    await this.options.vault.replace(stored)
    return {
      imported,
      skipped,
      errors,
      accounts: await this.listAccounts()
    }
  }

  async importPasted(text: string): Promise<ScanResult> {
    if (Buffer.byteLength(text, 'utf8') > MAX_SOURCE_FILE_BYTES) {
      throw new Error('粘贴内容超过安全限制')
    }
    const parsed = parseCredentialText(text, {
      sourcePath: 'pasted-credential.json',
      format: 'paste'
    })
    const credentials = dedupeCredentials(parsed.credentials)
    if (credentials.length === 0) {
      return {
        imported: 0,
        skipped: 0,
        errors: parsed.errors,
        accounts: await this.listAccounts()
      }
    }
    await this.options.deletedStore?.removeMany(credentials.map((credential) => credential.id))
    const existing = dedupeCredentials(await this.options.vault.list())
    const existingIds = new Set(existing.map((credential) => credential.id))
    const imported = credentials.filter((credential) => !existingIds.has(credential.id)).length
    const merged = dedupeCredentials([...existing, ...credentials])
    const stored = await this.persistManagedLibrary(merged, existing)
    await this.options.vault.replace(stored)
    return {
      imported,
      skipped: credentials.length - imported,
      errors: [],
      accounts: await this.listAccounts()
    }
  }

  async deleteAccounts(ids: string[]): Promise<DeleteAccountsResult> {
    const requested = new Set(ids)
    const before = await this.options.vault.list()
    const existingIds = before
      .filter((credential) => requested.has(credential.id))
      .map((credential) => credential.id)
    const existingSet = new Set(existingIds)
    const remaining = before.filter((credential) => !existingSet.has(credential.id))
    try {
      await this.options.deletedStore?.addMany(existingIds)
      const stored = await this.persistManagedLibrary(remaining, before)
      await this.options.vault.replace(stored)
      await this.options.statusStore.removeMany(existingIds)
    } catch (error) {
      await this.options.deletedStore?.removeMany(existingIds).catch(() => undefined)
      await this.options.vault.replace(before).catch(() => undefined)
      await this.managedLibrary?.replace(before).catch(() => undefined)
      throw error
    }
    return {
      deleted: existingIds.length,
      message: `已删除 ${existingIds.length} 个账号和对应的 aa 凭证文件，外部原始文件未修改`
    }
  }

  async migrateManagedDirectory(sourceDirectory: string): Promise<void> {
    const targetDirectory = this.options.managedImportDirectory
    if (!targetDirectory || resolve(sourceDirectory) === resolve(targetDirectory)) return
    let paths: string[]
    try {
      paths = await collectSupportedFiles(sourceDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (paths.length === 0) return
    await this.importFiles(paths, { archiveSources: true, restoreDeleted: false })
  }

  async listAccounts(): Promise<AccountSummary[]> {
    const settings = await this.options.settings()
    const credentials = await this.options.vault.list()
    const statuses = await this.options.statusStore.getAll()
    const activeId = await this.activeCredentialId(settings.authPath)
    return credentials
      .map((credential) => {
        const status = statuses[credential.id]
        return {
          id: credential.id,
          email: credential.email,
          workspaceId: credential.accountId,
          planType: status?.usage?.planType ?? credential.planType,
          sourcePath: credential.sourcePath,
          sourceFormat: credential.sourceFormat,
          sourceDialect: credential.sourceDialect,
          canRefresh: credential.canRefresh,
          switchable: Boolean(
            (credential.idToken && credential.refreshToken) || credential.accountId
          ),
          accessExpiresAt: credential.accessExpiresAt,
          lastRefresh: credential.lastRefresh,
          status: status?.status ?? 'untested',
          detail: status?.detail ?? '未测试',
          lastCheckedAt: status?.checkedAt ?? null,
          usage: status?.usage ?? null,
          active: credential.id === activeId
        } satisfies AccountSummary
      })
      .sort((left, right) => {
        if (left.active !== right.active) return left.active ? -1 : 1
        return (left.email ?? left.sourcePath).localeCompare(right.email ?? right.sourcePath)
      })
  }

  async testAccounts(
    ids?: string[],
    options: TestAccountsOptions = {}
  ): Promise<BatchTestResult> {
    const settings = await this.options.settings()
    const idSet = ids ? new Set(ids) : null
    const credentials = (await this.options.vault.list()).filter(
      (credential) => !idSet || idSet.has(credential.id)
    )
    const results: TestResult[] = []
    let cursor = 0
    let done = 0
    const total = credentials.length
    const runningIds = new Set<string>()
    options.onProgress?.({ done, total, runningIds: [] })

    const worker = async (): Promise<void> => {
      while (!options.signal?.aborted) {
        const index = cursor
        cursor += 1
        const credential = credentials[index]
        if (!credential) return
        runningIds.add(credential.id)
        options.onProgress?.({ done, total, runningIds: [...runningIds] })
        let result: TestResult
        try {
          result = await this.options.tester.test(credential, options.signal)
        } catch {
          result = {
            accountId: credential.id,
            status: 'network_error',
            detail: '检测任务异常终止',
            checkedAt: new Date().toISOString(),
            httpStatus: null,
            stage: 'local',
            refreshed: false,
            usage: null
          }
        }
        results.push(result)
        await this.updateCredentialPlan(credential.id, result)
        await this.options.statusStore.set(result)
        runningIds.delete(credential.id)
        done += 1
        const updatedAccount = (await this.listAccounts()).find(
          (account) => account.id === credential.id
        )
        options.onProgress?.({
          done,
          total,
          runningIds: [...runningIds],
          ...(updatedAccount ? { updatedAccount } : {})
        })
      }
    }
    const concurrency = Math.max(1, Math.min(12, settings.concurrency))
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()))
    await this.persistVaultLibrary()
    return { tested: results.length, results, cancelled: Boolean(options.signal?.aborted) }
  }

  async switchAccount(id: string): Promise<SwitchResult> {
    const credential = await this.options.vault.get(id)
    if (!credential) return { ok: false, message: '账号不存在', backupPath: null }
    const result = await this.options.tester.test(credential)
    await this.updateCredentialPlan(credential.id, result)
    await this.options.statusStore.set(result)
    await this.persistVaultLibrary()
    if (!['valid', 'quota_exhausted', 'quota_exhausted_5h', 'quota_exhausted_weekly', 'model_unavailable'].includes(result.status)) {
      return { ok: false, message: `账号不可切换：${result.detail}`, backupPath: null }
    }
    const latestCredential = (await this.options.vault.get(id)) ?? credential
    return this.options.switcher.switchTo(latestCredential)
  }

  async autoSwitch(
    candidateIds: string[],
    onProgress?: (progress: ManagerTestProgress) => void
  ): Promise<AutoSwitchRunResult> {
    const checkedAccountIds: string[] = []
    const accounts = await this.listAccounts()
    const active = accounts.find((account) => account.active)
    if (!active) {
      return { ok: false, switched: false, message: '当前 auth.json 未匹配到账号库凭证', checkedAccountIds, switchedAccountId: null }
    }
    const activeCredential = await this.options.vault.get(active.id)
    if (!activeCredential) {
      return { ok: false, switched: false, message: '当前账号已不在凭证库中', checkedAccountIds, switchedAccountId: null }
    }
    const notify = async (id: string, result: TestResult): Promise<void> => {
      checkedAccountIds.push(id)
      await this.updateCredentialPlan(id, result)
      await this.options.statusStore.set(result)
      await this.persistVaultLibrary()
      const updatedAccount = (await this.listAccounts()).find((account) => account.id === id)
      onProgress?.({
        done: checkedAccountIds.length,
        total: Math.max(1, candidateIds.length + 1),
        runningIds: [],
        ...(updatedAccount ? { updatedAccount } : {})
      })
    }
    onProgress?.({ done: 0, total: Math.max(1, candidateIds.length + 1), runningIds: [active.id] })
    const activeResult = await this.options.tester.test(activeCredential)
    await notify(active.id, activeResult)
    const triggerStatuses = new Set<TestResult['status']>([
      'quota_exhausted',
      'quota_exhausted_5h',
      'quota_exhausted_weekly',
      'no_permission',
      'invalid',
      'non_refreshable'
    ])
    if (!triggerStatuses.has(activeResult.status)) {
      return {
        ok: true,
        switched: false,
        message: `当前账号无需切换：${activeResult.detail}`,
        checkedAccountIds,
        switchedAccountId: null
      }
    }

    const uniqueCandidates = [...new Set(candidateIds)].filter((id) => id !== active.id)
    for (const id of uniqueCandidates) {
      const summary = accounts.find((account) => account.id === id)
      if (!summary?.switchable) continue
      const credential = await this.options.vault.get(id)
      if (!credential) continue
      onProgress?.({
        done: checkedAccountIds.length,
        total: Math.max(1, uniqueCandidates.length + 1),
        runningIds: [id]
      })
      const result = await this.options.tester.test(credential)
      await notify(id, result)
      if (result.status !== 'valid') continue
      const latestCredential = (await this.options.vault.get(id)) ?? credential
      const switched = await this.options.switcher.switchTo(latestCredential)
      if (!switched.ok) continue
      return {
        ok: true,
        switched: true,
        message: `${activeResult.detail}；已自动切换到 ${summary.email ?? '候选账号'}`,
        checkedAccountIds,
        switchedAccountId: id
      }
    }
    return {
      ok: false,
      switched: false,
      message: `${activeResult.detail}；选定账号池中没有可用凭证`,
      checkedAccountIds,
      switchedAccountId: null
    }
  }

  async restoreLatest(): Promise<SwitchResult> {
    return this.options.switcher.restoreLatest()
  }

  async restoreApiMode(): Promise<SwitchResult> {
    return this.options.switcher.restoreApiMode()
  }

  async getSourcePath(id: string): Promise<string | null> {
    return (await this.options.vault.get(id))?.sourcePath ?? null
  }

  private async parseCredentialFile(
    path: string,
    format: CredentialSourceFormat
  ): Promise<{ credentials: NormalizedCredential[]; errors: string[] }> {
    if (format !== 'zip') {
      const metadata = await stat(path)
      if (!metadata.isFile()) throw new Error('账号来源不是文件')
      if (metadata.size > MAX_SOURCE_FILE_BYTES) throw new Error('账号文件超过 100MB 安全限制')
      return parseCredentialText(await readFile(path, 'utf8'), { sourcePath: path, format })
    }

    const archive = await readFile(path)
    if (archive.byteLength > MAX_ZIP_BYTES) throw new Error('ZIP 文件超过安全限制')
    let entriesSeen = 0
    let totalBytes = 0
    const entries = unzipSync(new Uint8Array(archive), {
      filter: (entry) => {
        entriesSeen += 1
        if (entriesSeen > MAX_ZIP_ENTRIES) throw new Error('ZIP 条目数量超过安全限制')
        if (entry.originalSize > MAX_ZIP_ENTRY_BYTES) throw new Error('ZIP 单个条目超过安全限制')
        totalBytes += entry.originalSize
        if (totalBytes > MAX_ZIP_TOTAL_BYTES) throw new Error('ZIP 解压大小超过安全限制')
        const normalizedName = entry.name.replace(/\\/g, '/')
        if (
          normalizedName.startsWith('/') ||
          normalizedName.split('/').includes('..') ||
          /^[A-Za-z]:/.test(normalizedName)
        ) {
          throw new Error('ZIP 包含不安全路径')
        }
        return Boolean(FORMAT_BY_EXTENSION[extname(normalizedName).toLowerCase()])
      }
    })
    const credentials: NormalizedCredential[] = []
    const errors: string[] = []
    for (const [entryName, bytes] of Object.entries(entries)) {
      const entryFormat = FORMAT_BY_EXTENSION[extname(entryName).toLowerCase()]
      if (!entryFormat || entryFormat === 'zip') continue
      const parsed = parseCredentialText(strFromU8(bytes), {
        sourcePath: `${path}::${entryName}`,
        format: entryFormat
      })
      credentials.push(
        ...parsed.credentials.map((credential) => ({
          ...credential,
          sourcePath: path,
          sourceFormat: 'zip' as const
        }))
      )
      errors.push(...parsed.errors)
    }
    return { credentials, errors }
  }

  private async persistManagedLibrary(
    credentials: readonly NormalizedCredential[],
    rollbackCredentials: readonly NormalizedCredential[] = []
  ): Promise<NormalizedCredential[]> {
    if (!this.managedLibrary) return dedupeCredentials(credentials)
    try {
      return await this.managedLibrary.replace(credentials)
    } catch (error) {
      await this.managedLibrary.replace(rollbackCredentials).catch(() => undefined)
      throw error
    }
  }

  private async persistVaultLibrary(): Promise<void> {
    if (!this.managedLibrary) return
    const before = await this.options.vault.list()
    const stored = await this.persistManagedLibrary(before, before)
    await this.options.vault.replace(stored)
  }

  private async updateCredentialPlan(id: string, result: TestResult): Promise<void> {
    const planType = result.usage?.planType?.trim()
    if (!planType) return
    const current = await this.options.vault.get(id)
    if (!current || current.planType === planType) return
    await this.options.vault.upsertMany([{ ...current, planType }])
  }

  private async activeCredentialId(authPath: string): Promise<string | null> {
    try {
      const parsed = parseCredentialText(await readFile(authPath, 'utf8'), {
        sourcePath: authPath,
        format: 'json'
      })
      return parsed.credentials[0]?.id ?? null
    } catch {
      return null
    }
  }
}
