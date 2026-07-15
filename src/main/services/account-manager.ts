import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import type {
  AccountSummary,
  AppSettings,
  BatchTestResult,
  CredentialSourceFormat,
  DeleteAccountsResult,
  NormalizedCredential,
  ScanResult,
  SwitchResult,
  TestResult
} from '../../shared/types'
import { dedupeCredentials, parseCredentialText } from '../accounts/parser'
import { serializeSub2ApiBundle } from './exporter'
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
  constructor(private readonly options: AccountManagerOptions) {}

  async scanDirectory(): Promise<ScanResult> {
    const settings = await this.options.settings()
    await mkdir(settings.accountDirectory, { recursive: true })
    const paths = await collectSupportedFiles(settings.accountDirectory)
    const result = await this.importFiles(paths, {
      archiveSources: Boolean(this.options.managedImportDirectory),
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
        let sourcePath = path
        if (options.archiveSources && parsed.credentials.length > 0) {
          sourcePath = await this.archiveSourceFile(path)
        }
        credentials.push(
          ...parsed.credentials.map((credential) => ({ ...credential, sourcePath }))
        )
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
    const merged = dedupeCredentials([...(await this.options.vault.list()), ...deduped])
    await this.options.vault.replace(merged)
    return {
      imported: deduped.length,
      skipped,
      errors,
      accounts: await this.listAccounts()
    }
  }

  async importPasted(text: string): Promise<ScanResult> {
    if (text.length > MAX_ZIP_TOTAL_BYTES) throw new Error('粘贴内容超过安全限制')
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
    const sourcePath = await this.archivePastedCredentials(credentials)
    const stored = credentials.map((credential) => ({ ...credential, sourcePath }))
    await this.options.deletedStore?.removeMany(stored.map((credential) => credential.id))
    const merged = dedupeCredentials([...(await this.options.vault.list()), ...stored])
    await this.options.vault.replace(merged)
    return {
      imported: stored.length,
      skipped: 0,
      errors: [],
      accounts: await this.listAccounts()
    }
  }

  async deleteAccounts(ids: string[]): Promise<DeleteAccountsResult> {
    const requested = new Set(ids)
    const existingIds = (await this.options.vault.list())
      .filter((credential) => requested.has(credential.id))
      .map((credential) => credential.id)
    await this.options.deletedStore?.addMany(existingIds)
    await this.options.vault.removeMany(existingIds)
    await this.options.statusStore.removeMany(existingIds)
    return {
      deleted: existingIds.length,
      message: `已从账号库删除 ${existingIds.length} 个账号，原始文件未修改`
    }
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
          switchable: Boolean(credential.idToken && credential.refreshToken),
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
    return { tested: results.length, results, cancelled: Boolean(options.signal?.aborted) }
  }

  async switchAccount(id: string): Promise<SwitchResult> {
    const credential = await this.options.vault.get(id)
    if (!credential) return { ok: false, message: '账号不存在', backupPath: null }
    const result = await this.options.tester.test(credential)
    await this.options.statusStore.set(result)
    if (!['valid', 'quota_exhausted', 'model_unavailable'].includes(result.status)) {
      return { ok: false, message: `账号不可切换：${result.detail}`, backupPath: null }
    }
    const latestCredential = (await this.options.vault.get(id)) ?? credential
    return this.options.switcher.switchTo(latestCredential)
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

  private async archiveSourceFile(sourcePath: string): Promise<string> {
    const directory = this.options.managedImportDirectory
    if (!directory) return sourcePath
    await mkdir(directory, { recursive: true })
    const filename = basename(sourcePath)
    const extension = extname(filename)
    const stem = extension ? filename.slice(0, -extension.length) : filename
    const source = await readFile(sourcePath)
    for (let suffix = 1; suffix < 10_000; suffix += 1) {
      const candidate = join(
        directory,
        suffix === 1 ? filename : `${stem}-${suffix}${extension}`
      )
      try {
        const existing = await readFile(candidate)
        if (existing.equals(source)) return candidate
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await copyFile(sourcePath, candidate, constants.COPYFILE_EXCL)
        return candidate
      }
    }
    throw new Error('托管导入目录无法生成可用文件名')
  }

  private async archivePastedCredentials(
    credentials: readonly NormalizedCredential[]
  ): Promise<string> {
    const directory = this.options.managedImportDirectory
    if (!directory) return 'pasted-credential.json'
    await mkdir(directory, { recursive: true })
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
    const targetPath = await this.availableManagedPath(`pasted-${stamp}.json`)
    await writeFile(
      targetPath,
      `${JSON.stringify(serializeSub2ApiBundle(credentials), null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    )
    return targetPath
  }

  private async availableManagedPath(filename: string): Promise<string> {
    const directory = this.options.managedImportDirectory
    if (!directory) return filename
    const extension = extname(filename)
    const stem = extension ? filename.slice(0, -extension.length) : filename
    for (let suffix = 1; suffix < 10_000; suffix += 1) {
      const candidate = join(
        directory,
        suffix === 1 ? filename : `${stem}-${suffix}${extension}`
      )
      try {
        await stat(candidate)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate
        throw error
      }
    }
    throw new Error('托管导入目录无法生成可用文件名')
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
