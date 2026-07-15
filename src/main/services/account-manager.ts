import { mkdir, readFile, readdir } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  AccountSummary,
  AppSettings,
  BatchTestResult,
  CredentialSourceFormat,
  NormalizedCredential,
  ScanResult,
  SwitchResult,
  TestResult
} from '../../shared/types'
import { dedupeCredentials, parseCredentialText } from '../accounts/parser'
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
}

interface TestAccountsOptions {
  signal?: AbortSignal
  onProgress?: (progress: { done: number; total: number }) => void
}

const FORMAT_BY_EXTENSION: Record<string, CredentialSourceFormat | undefined> = {
  '.json': 'json',
  '.txt': 'txt',
  '.js': 'js'
}

export class AccountManager {
  constructor(private readonly options: AccountManagerOptions) {}

  async scanDirectory(): Promise<ScanResult> {
    const settings = await this.options.settings()
    await mkdir(settings.accountDirectory, { recursive: true })
    const entries = await readdir(settings.accountDirectory, { withFileTypes: true })
    const paths = entries
      .filter((entry) => entry.isFile() && FORMAT_BY_EXTENSION[extname(entry.name).toLowerCase()])
      .map((entry) => join(settings.accountDirectory, entry.name))
    const result = await this.importFiles(paths)
    await this.reconcileScannedDirectory(settings.accountDirectory, paths)
    return { ...result, accounts: await this.listAccounts() }
  }

  async importFiles(paths: string[]): Promise<ScanResult> {
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
        const parsed = parseCredentialText(await readFile(path, 'utf8'), {
          sourcePath: path,
          format
        })
        credentials.push(...parsed.credentials)
        errors.push(...parsed.errors)
      } catch (error) {
        errors.push(`${path}: ${error instanceof Error ? error.message : '读取失败'}`)
      }
    }
    const deduped = dedupeCredentials(credentials)
    await this.options.vault.upsertMany(deduped)
    return {
      imported: deduped.length,
      skipped,
      errors,
      accounts: await this.listAccounts()
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
          canRefresh: credential.canRefresh,
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
    options.onProgress?.({ done, total })

    const worker = async (): Promise<void> => {
      while (!options.signal?.aborted) {
        const index = cursor
        cursor += 1
        const credential = credentials[index]
        if (!credential) return
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
        done += 1
        options.onProgress?.({ done, total })
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
    return this.options.switcher.switchTo(credential)
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

  private async reconcileScannedDirectory(directory: string, currentPaths: string[]): Promise<void> {
    const directoryPath = resolve(directory)
    const current = new Set(currentPaths.map((path) => resolve(path).toLowerCase()))
    const staleIds = (await this.options.vault.list())
      .filter((credential) => {
        const sourcePath = resolve(credential.sourcePath)
        const childPath = relative(directoryPath, sourcePath)
        const isChild =
          childPath !== '' &&
          childPath !== '..' &&
          !childPath.startsWith(`..${sep}`) &&
          !isAbsolute(childPath)
        return isChild && !current.has(sourcePath.toLowerCase())
      })
      .map((credential) => credential.id)
    await this.options.vault.removeMany(staleIds)
    await this.options.statusStore.removeMany(staleIds)
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
