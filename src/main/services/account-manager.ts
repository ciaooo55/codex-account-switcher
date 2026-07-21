import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import type {
  AccountSummary,
  AppSettings,
  AutoSwitchRunResult,
  BatchTestResult,
  CodexTestMode,
  CredentialSourceFormat,
  DeleteAccountsResult,
  ImportSourceIssue,
  NormalizedCredential,
  OAuthAuthorizationSession,
  RefreshTokenClientMode,
  ScanResult,
  SwitchResult,
  TestResult
} from '../../shared/types'
import { dedupeCredentials, parseCredentialText } from '../accounts/parser'
import { ManagedCredentialLibrary } from '../storage/managed-library'
import type { CredentialVault } from '../storage/vault'
import type { StatusStore } from '../storage/status-store'
import { findMatchingCodexCredential } from './account-status-sync'

interface TesterLike {
  test(credential: NormalizedCredential, signal?: AbortSignal, mode?: CodexTestMode): Promise<TestResult>
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
  refreshTokenImporter?: {
    resolve(
      text: string,
      mode: RefreshTokenClientMode,
      source?: { sourcePath: string; format: CredentialSourceFormat }
    ): Promise<{ credentials: NormalizedCredential[]; errors: string[]; total: number }>
  }
  oauthAuthorizationImporter?: {
    start(): OAuthAuthorizationSession
    complete(
      sessionId: string,
      callbackInput: string
    ): Promise<{ credentials: NormalizedCredential[]; errors: string[]; total: number }>
  }
  deletedStore?: {
    list(): Promise<Set<string>>
    addMany(ids: string[]): Promise<void>
    removeMany(ids: string[]): Promise<void>
  }
  onCredentialsChanged?: () => Promise<void>
  onStatusesChanged?: () => Promise<void>
}

interface ImportFilesOptions {
  archiveSources?: boolean
  restoreDeleted?: boolean
  authoritative?: boolean
}

export interface CodexImportPreparation {
  credentials: NormalizedCredential[]
  errors: string[]
  recognized: number
  sourceCount: number
  unrecognized?: ImportSourceIssue[]
}

interface ManagerTestProgress {
  done: number
  total: number
  runningIds: string[]
  updatedAccount?: AccountSummary
}

interface TestAccountsOptions {
  signal?: AbortSignal
  mode?: CodexTestMode
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
const SWITCH_REFRESH_GRACE_MS = 2 * 60 * 1_000
const EMBEDDED_ACCESS_TOKEN_PATTERN =
  /["']?(?:access_token|accessToken|personal_access_token|personalAccessToken|OPENAI_ACCESS_TOKEN|token)["']?\s*[:=]\s*["']?\s*(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|at-[A-Za-z0-9._~+/=-]{8,})/i
const STATUSES_REQUIRING_SWITCH_VALIDATION = new Set<TestResult['status']>([
  'workspace_deactivated',
  'no_permission',
  'invalid',
  'needs_refresh',
  'non_refreshable'
])

function credentialNeedsRefresh(credential: NormalizedCredential, now = Date.now()): boolean {
  if (!credential.accessExpiresAt) return false
  const expiresAt = Date.parse(credential.accessExpiresAt)
  return Number.isFinite(expiresAt) && expiresAt <= now + SWITCH_REFRESH_GRACE_MS
}

function shouldAttemptRefreshTokenImport(text: string): boolean {
  return !EMBEDDED_ACCESS_TOKEN_PATTERN.test(text)
}

function sameCredentialIdentity(
  left: NormalizedCredential,
  right: NormalizedCredential
): boolean {
  if (left.id === right.id) return true
  if (left.email && right.email && left.email.toLowerCase() === right.email.toLowerCase()) return true
  return Boolean(left.subject && right.subject && left.subject === right.subject)
}

function sameCredentialMaterial(
  left: NormalizedCredential,
  right: NormalizedCredential
): boolean {
  return left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.idToken === right.idToken &&
    left.accountId === right.accountId &&
    left.authKind === right.authKind
}

function formatForPath(path: string): CredentialSourceFormat | undefined {
  if (/\.json\.(?:0|无权限|无用量)$/i.test(path)) return 'json'
  return FORMAT_BY_EXTENSION[extname(path).toLowerCase()]
}

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
      else if (entry.isFile() && formatForPath(entry.name)) {
        files.push(path)
        if (files.length > MAX_SCAN_FILES) throw new Error('账号目录文件数量超过安全限制')
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right))
}

function summarizeAccount(
  credential: NormalizedCredential,
  status: TestResult | undefined,
  activeId: string | null
): AccountSummary {
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
      credential.authKind === 'personal_access_token' ||
      credential.accessToken.startsWith('at-') ||
      (credential.idToken && credential.refreshToken) ||
      credential.accountId
    ),
    switchMode: credential.authKind === 'personal_access_token' || credential.accessToken.startsWith('at-')
      ? 'personal_access_token'
      : credential.idToken && credential.refreshToken
        ? 'oauth'
        : credential.accountId
          ? 'external'
          : 'test-only',
    accessExpiresAt: credential.accessExpiresAt,
    lastRefresh: credential.lastRefresh,
    status: status?.status ?? 'untested',
    detail: status?.detail ?? '未测试',
    lastCheckedAt: status?.checkedAt ?? null,
    usage: status?.usage ?? null,
    active: credential.id === activeId
  }
}

export class AccountManager {
  private activeAuthIdentityCache: {
    authPath: string
    mtimeMs: number
    size: number
    credential: NormalizedCredential | null
  } | null = null

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
      restoreDeleted: false,
      authoritative: Boolean(this.managedLibrary)
    })
    return { ...result, accounts: await this.listAccounts() }
  }

  async importDirectory(directory: string): Promise<ScanResult> {
    const prepared = await this.prepareDirectory(directory)
    return this.commitPreparedWithOptions(prepared, {
      archiveSources: true,
      restoreDeleted: true
    })
  }

  async importFiles(paths: string[], options: ImportFilesOptions = {}): Promise<ScanResult> {
    return this.commitPreparedWithOptions(await this.prepareFiles(paths), options)
  }

  async prepareDirectory(directory: string): Promise<CodexImportPreparation> {
    const info = await stat(directory)
    if (!info.isDirectory()) throw new Error('选择的路径不是文件夹')
    return this.prepareFiles(await collectSupportedFiles(directory))
  }

  async prepareFiles(paths: string[]): Promise<CodexImportPreparation> {
    const credentials: NormalizedCredential[] = []
    const errors: string[] = []
    const unrecognized: ImportSourceIssue[] = []
    for (const path of paths) {
      const format = formatForPath(path)
      if (!format) continue
      try {
        const parsed = await this.parseCredentialFile(path, format)
        credentials.push(...parsed.credentials)
        errors.push(...parsed.errors)
        if (parsed.unrecognized || parsed.credentials.length === 0) {
          unrecognized.push({
            sourcePath: path,
            sourceFormat: format,
            detail: parsed.errors.at(-1) ?? '未找到可用 Codex 凭据'
          })
        }
      } catch (error) {
        const detail = `${path}: ${error instanceof Error ? error.message : '读取失败'}`
        errors.push(detail)
        unrecognized.push({ sourcePath: path, sourceFormat: format, detail })
      }
    }
    const deduped = dedupeCredentials(credentials)
    return {
      credentials: deduped,
      errors,
      recognized: deduped.length,
      sourceCount: paths.length,
      unrecognized
    }
  }

  private async commitPreparedWithOptions(
    prepared: CodexImportPreparation,
    options: ImportFilesOptions = {}
  ): Promise<ScanResult> {
    let deduped = prepared.credentials
    if (this.options.deletedStore) {
      if (options.restoreDeleted === false) {
        const deleted = await this.options.deletedStore.list()
        deduped = deduped.filter((credential) => !deleted.has(credential.id))
      } else {
        await this.options.deletedStore.removeMany(deduped.map((credential) => credential.id))
      }
    }
    const existing = dedupeCredentials(await this.options.vault.list())
    const freshCredentials = deduped.filter((credential) =>
      !existing.some((current) => sameCredentialIdentity(current, credential))
    )
    const changedExistingIds = existing
      .filter((current) => deduped.some((credential) =>
        sameCredentialIdentity(current, credential) && !sameCredentialMaterial(current, credential)
      ))
      .map((credential) => credential.id)
    const imported = freshCredentials.length
    const skipped = prepared.credentials.length - imported
    const authoritative = options.authoritative === true && prepared.errors.length === 0
    const merged = authoritative ? deduped : dedupeCredentials([...existing, ...deduped])
    const mergedIds = new Set(merged.map((credential) => credential.id))
    const removedIds = existing
      .filter((credential) => !mergedIds.has(credential.id))
      .map((credential) => credential.id)
    const stored = await this.persistManagedLibrary(merged, existing)
    await this.options.vault.replace(stored)
    const affectedFinalIds = merged
      .filter((credential) => deduped.some((incoming) => sameCredentialIdentity(credential, incoming)))
      .map((credential) => credential.id)
    const resetStatusIds = [
      ...new Set([
        ...removedIds,
        ...freshCredentials.map((credential) => credential.id),
        ...changedExistingIds,
        ...(changedExistingIds.length > 0 ? affectedFinalIds : [])
      ])
    ]
    if (resetStatusIds.length > 0) {
      await this.options.statusStore.removeMany(resetStatusIds)
    }
    await this.options.onCredentialsChanged?.()
    return {
      imported,
      skipped,
      recognized: prepared.recognized,
      errors: prepared.errors,
      accounts: await this.listAccounts()
    }
  }

  async importPasted(text: string): Promise<ScanResult> {
    const prepared = await this.preparePasted(text)
    return this.importResolvedCredentials(
      prepared.credentials,
      prepared.errors,
      prepared.recognized
    )
  }

  async preparePasted(text: string): Promise<CodexImportPreparation> {
    if (Buffer.byteLength(text, 'utf8') > MAX_SOURCE_FILE_BYTES) {
      throw new Error('粘贴内容超过安全限制')
    }
    let parsed = parseCredentialText(text, {
      sourcePath: 'pasted-credential.json',
      format: 'paste'
    })
    let recognized = parsed.credentials.length
    let partialRefreshFailure = false
    if (
      parsed.credentials.length === 0 &&
      this.options.refreshTokenImporter &&
      shouldAttemptRefreshTokenImport(text)
    ) {
      const refreshed = await this.options.refreshTokenImporter.resolve(text, 'auto')
      if (refreshed.total > 0) {
        parsed = refreshed
        recognized = refreshed.total
        partialRefreshFailure = refreshed.credentials.length < refreshed.total
      }
    }
    return {
      credentials: dedupeCredentials(parsed.credentials),
      errors: parsed.errors,
      recognized,
      sourceCount: 1,
      unrecognized: parsed.credentials.length === 0 || partialRefreshFailure
        ? [{ sourcePath: 'pasted-credential.json', sourceFormat: 'paste', detail: parsed.errors.at(-1) ?? '未找到可用 Codex 凭据' }]
        : []
    }
  }

  async importRefreshTokens(text: string, mode: RefreshTokenClientMode): Promise<ScanResult> {
    const prepared = await this.prepareRefreshTokens(text, mode)
    return this.importResolvedCredentials(prepared.credentials, prepared.errors, prepared.recognized)
  }

  async prepareRefreshTokens(
    text: string,
    mode: RefreshTokenClientMode
  ): Promise<CodexImportPreparation> {
    if (Buffer.byteLength(text, 'utf8') > MAX_SOURCE_FILE_BYTES) {
      throw new Error('粘贴内容超过安全限制')
    }
    if (!this.options.refreshTokenImporter) throw new Error('Refresh Token 导入器不可用')
    const parsed = await this.options.refreshTokenImporter.resolve(text, mode)
    return {
      credentials: dedupeCredentials(parsed.credentials),
      errors: parsed.errors,
      recognized: parsed.total,
      sourceCount: 1,
      unrecognized: parsed.credentials.length === 0 || parsed.total > parsed.credentials.length
        ? [{ sourcePath: 'pasted-refresh-tokens.txt', sourceFormat: 'paste', detail: parsed.errors.at(-1) ?? '没有成功兑换任何 Refresh Token' }]
        : []
    }
  }

  startOAuthAuthorization(): OAuthAuthorizationSession {
    if (!this.options.oauthAuthorizationImporter) throw new Error('OAuth 授权导入器不可用')
    return this.options.oauthAuthorizationImporter.start()
  }

  async completeOAuthAuthorization(sessionId: string, callbackInput: string): Promise<ScanResult> {
    const prepared = await this.prepareOAuthAuthorization(sessionId, callbackInput)
    return this.importResolvedCredentials(prepared.credentials, prepared.errors, prepared.recognized)
  }

  async prepareOAuthAuthorization(
    sessionId: string,
    callbackInput: string
  ): Promise<CodexImportPreparation> {
    if (!this.options.oauthAuthorizationImporter) throw new Error('OAuth 授权导入器不可用')
    const parsed = await this.options.oauthAuthorizationImporter.complete(sessionId, callbackInput)
    return {
      credentials: dedupeCredentials(parsed.credentials),
      errors: parsed.errors,
      recognized: parsed.total,
      sourceCount: 1,
      unrecognized: parsed.credentials.length === 0
        ? [{ sourcePath: 'oauth-callback', sourceFormat: 'paste', detail: parsed.errors.at(-1) ?? 'OAuth 回调中没有可用凭据' }]
        : []
    }
  }

  async importPrepared(prepared: CodexImportPreparation): Promise<ScanResult> {
    return this.importResolvedCredentials(
      prepared.credentials,
      prepared.errors,
      prepared.recognized
    )
  }

  async importCredentialsAdditive(input: readonly NormalizedCredential[]): Promise<ScanResult> {
    const credentials = dedupeCredentials(input)
    const existing = dedupeCredentials(await this.options.vault.list())
    const fresh = credentials.filter((credential) =>
      !existing.some((current) => sameCredentialIdentity(current, credential))
    )
    if (fresh.length === 0) {
      return { imported: 0, skipped: credentials.length, errors: [], accounts: await this.listAccounts() }
    }
    const result = await this.importResolvedCredentials(fresh, [])
    return { ...result, skipped: result.skipped + credentials.length - fresh.length }
  }

  private async importResolvedCredentials(
    input: readonly NormalizedCredential[],
    errors: readonly string[],
    recognized = input.length
  ): Promise<ScanResult> {
    const credentials = dedupeCredentials(input)
    if (credentials.length === 0) {
      return {
        imported: 0,
        skipped: 0,
        recognized,
        errors: [...errors],
        accounts: await this.listAccounts()
      }
    }
    await this.options.deletedStore?.removeMany(credentials.map((credential) => credential.id))
    const existing = dedupeCredentials(await this.options.vault.list())
    const freshCredentials = credentials.filter((credential) =>
      !existing.some((current) => sameCredentialIdentity(current, credential))
    )
    const changedExistingIds = existing
      .filter((current) => credentials.some((credential) =>
        sameCredentialIdentity(current, credential) && !sameCredentialMaterial(current, credential)
      ))
      .map((credential) => credential.id)
    const imported = freshCredentials.length
    const merged = dedupeCredentials([...existing, ...credentials])
    const affectedFinalIds = merged
      .filter((credential) => credentials.some((incoming) => sameCredentialIdentity(credential, incoming)))
      .map((credential) => credential.id)
    const stored = await this.persistManagedLibrary(merged, existing)
    await this.options.vault.replace(stored)
    await this.options.statusStore.removeMany([
      ...new Set([
        ...freshCredentials.map((credential) => credential.id),
        ...changedExistingIds,
        ...(changedExistingIds.length > 0 ? affectedFinalIds : [])
      ])
    ])
    await this.options.onCredentialsChanged?.()
    return {
      imported,
      skipped: credentials.length - imported,
      recognized,
      errors: [...errors],
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
      await this.options.onCredentialsChanged?.()
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

  async rebuildManagedLibraryFromVault(): Promise<void> {
    await this.persistVaultLibrary()
  }

  async listAccounts(): Promise<AccountSummary[]> {
    const settings = await this.options.settings()
    const credentials = await this.options.vault.list()
    const statuses = await this.options.statusStore.getAll()
    const activeId = await this.activeCredentialId(settings.authPath, credentials)
    return credentials
      .map((credential) => summarizeAccount(credential, statuses[credential.id], activeId))
      .sort((left, right) => {
        if (left.active !== right.active) return left.active ? -1 : 1
        return (left.email ?? left.sourcePath).localeCompare(right.email ?? right.sourcePath)
      })
  }

  async listCredentials(): Promise<NormalizedCredential[]> {
    return this.options.vault.list()
  }

  async testAccounts(
    ids?: string[],
    options: TestAccountsOptions = {}
  ): Promise<BatchTestResult> {
    const settings = await this.options.settings()
    const idSet = ids ? new Set(ids) : null
    const allCredentials = await this.options.vault.list()
    const credentials = allCredentials.filter(
      (credential) => !idSet || idSet.has(credential.id)
    )
    const results: TestResult[] = []
    const planUpdates = new Map<string, NormalizedCredential>()
    let cursor = 0
    let done = 0
    const total = credentials.length
    const runningIds = new Set<string>()
    const previousStatuses = options.mode === 'refresh'
      ? await this.options.statusStore.getAll()
      : {}
    const activeId = await this.activeCredentialId(settings.authPath, allCredentials)
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
          result = await this.options.tester.test(credential, options.signal, options.mode ?? 'full')
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
        const previous = previousStatuses[credential.id]
        const storedResult = options.mode === 'refresh' && !result.usage && previous?.usage
          ? { ...result, usage: previous.usage }
          : result
        results.push(storedResult)
        const latest = (await this.options.vault.get(credential.id)) ?? credential
        const planType = storedResult.usage?.planType?.trim()
        const summarizedCredential = planType && latest.planType !== planType
          ? { ...latest, planType }
          : latest
        if (summarizedCredential !== latest) {
          planUpdates.set(summarizedCredential.id, summarizedCredential)
        }
        await this.options.statusStore.setBuffered(storedResult)
        runningIds.delete(credential.id)
        done += 1
        options.onProgress?.({
          done,
          total,
          runningIds: [...runningIds],
          updatedAccount: summarizeAccount(summarizedCredential, storedResult, activeId)
        })
      }
    }
    const concurrency = Math.max(1, Math.min(12, settings.concurrency))
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()))
    await this.options.statusStore.flush()
    if (planUpdates.size > 0) await this.options.vault.upsertMany([...planUpdates.values()])
    await this.persistVaultLibrary()
    await this.options.onStatusesChanged?.()
    return { tested: results.length, results, cancelled: Boolean(options.signal?.aborted) }
  }

  async persistImportedTestResults(results: readonly TestResult[]): Promise<void> {
    for (const result of results) await this.options.statusStore.setBuffered(result)
    await this.options.statusStore.flush()
    if (results.length > 0) await this.options.onStatusesChanged?.()
  }

  async switchAccount(id: string): Promise<SwitchResult> {
    const credential = await this.options.vault.get(id)
    if (!credential) return { ok: false, message: '账号不存在', backupPath: null }

    const cached = (await this.options.statusStore.getAll())[credential.id]
    const needsSilentValidation = credentialNeedsRefresh(credential) ||
      Boolean(cached && STATUSES_REQUIRING_SWITCH_VALIDATION.has(cached.status))
    if (needsSilentValidation) {
      const result = await this.options.tester.test(credential, undefined, 'full')
      await this.updateCredentialPlan(credential.id, result)
      await this.options.statusStore.set(result)
      await this.persistVaultLibrary()
      await this.options.onStatusesChanged?.()
      if (!['valid', 'quota_exhausted', 'quota_exhausted_5h', 'quota_exhausted_weekly', 'model_unavailable'].includes(result.status)) {
        return { ok: false, message: `账号不可切换：${result.detail}`, backupPath: null }
      }
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
    const planUpdates = new Map<string, NormalizedCredential>()
    const notify = async (id: string, result: TestResult): Promise<void> => {
      checkedAccountIds.push(id)
      const latest = await this.options.vault.get(id)
      const planType = result.usage?.planType?.trim()
      const summarized = latest && planType && latest.planType !== planType
        ? { ...latest, planType }
        : latest
      if (summarized && summarized !== latest) planUpdates.set(id, summarized)
      await this.options.statusStore.setBuffered(result)
      onProgress?.({
        done: checkedAccountIds.length,
        total: Math.max(1, candidateIds.length + 1),
        runningIds: [],
        ...(summarized ? { updatedAccount: summarizeAccount(summarized, result, active.id) } : {})
      })
    }
    try {
      onProgress?.({ done: 0, total: Math.max(1, candidateIds.length + 1), runningIds: [active.id] })
      const activeResult = await this.options.tester.test(activeCredential, undefined, 'full')
      await notify(active.id, activeResult)
      const triggerStatuses = new Set<TestResult['status']>([
        'quota_exhausted',
        'quota_exhausted_5h',
        'quota_exhausted_weekly',
        'workspace_deactivated',
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
        const result = await this.options.tester.test(credential, undefined, 'full')
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
    } finally {
      await this.options.statusStore.flush()
      if (planUpdates.size > 0) await this.options.vault.upsertMany([...planUpdates.values()])
      if (checkedAccountIds.length > 0) await this.persistVaultLibrary()
      if (checkedAccountIds.length > 0) await this.options.onStatusesChanged?.()
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
  ): Promise<{ credentials: NormalizedCredential[]; errors: string[]; unrecognized?: boolean }> {
    if (format !== 'zip') {
      const metadata = await stat(path)
      if (!metadata.isFile()) throw new Error('账号来源不是文件')
      if (metadata.size > MAX_SOURCE_FILE_BYTES) throw new Error('账号文件超过 100MB 安全限制')
      const text = await readFile(path, 'utf8')
      const parsed = parseCredentialText(text, { sourcePath: path, format })
      if (
        parsed.credentials.length > 0 ||
        !this.options.refreshTokenImporter ||
        !shouldAttemptRefreshTokenImport(text)
      ) return { ...parsed, unrecognized: parsed.credentials.length === 0 }
      const refreshed = await this.options.refreshTokenImporter.resolve(text, 'auto', {
        sourcePath: path,
        format
      })
      return refreshed.total > 0
        ? { ...refreshed, unrecognized: refreshed.credentials.length < refreshed.total }
        : { ...parsed, unrecognized: true }
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
          return Boolean(formatForPath(normalizedName))
      }
    })
    const credentials: NormalizedCredential[] = []
    const errors: string[] = []
    let unrecognized = false
    for (const [entryName, bytes] of Object.entries(entries)) {
      const entryFormat = formatForPath(entryName)
      if (!entryFormat || entryFormat === 'zip') continue
      const entryText = strFromU8(bytes)
      const parsed = parseCredentialText(entryText, {
        sourcePath: `${path}::${entryName}`,
        format: entryFormat
      })
      const resolved =
        parsed.credentials.length > 0 ||
        !this.options.refreshTokenImporter ||
        !shouldAttemptRefreshTokenImport(entryText)
          ? { ...parsed, unrecognized: parsed.credentials.length === 0 }
          : await this.options.refreshTokenImporter.resolve(entryText, 'auto', {
            sourcePath: `${path}::${entryName}`,
            format: entryFormat
          })
      if ('total' in resolved) unrecognized ||= resolved.credentials.length < resolved.total
      else unrecognized ||= resolved.credentials.length === 0
      credentials.push(
        ...resolved.credentials.map((credential) => ({
          ...credential,
          sourcePath: path,
          sourceFormat: 'zip' as const
        }))
      )
      errors.push(...resolved.errors)
    }
    return { credentials, errors, unrecognized }
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

  private async activeCredentialId(
    authPath: string,
    credentials?: readonly NormalizedCredential[]
  ): Promise<string | null> {
    try {
      const info = await stat(authPath)
      const cached = this.activeAuthIdentityCache
      const cacheHit = Boolean(
        cached
        && cached.authPath === authPath
        && cached.mtimeMs === info.mtimeMs
        && cached.size === info.size
      )
      let active = cacheHit ? cached!.credential : null
      if (!cacheHit) {
        const text = await readFile(authPath, 'utf8')
        const parsed = parseCredentialText(text, {
          sourcePath: authPath,
          format: 'json'
        })
        active = parsed.credentials[0] ?? null
        this.activeAuthIdentityCache = {
          authPath,
          mtimeMs: info.mtimeMs,
          size: info.size,
          credential: active
        }
      }
      if (!active) return null
      const match = findMatchingCodexCredential(
        active,
        credentials ?? await this.options.vault.list()
      )
      return match?.id ?? active.id
    } catch {
      this.activeAuthIdentityCache = null
      return null
    }
  }
}

