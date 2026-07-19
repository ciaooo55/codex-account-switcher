import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type {
  AccountStatus,
  CredentialSourceFormat,
  DisplayAccountStatus,
  GrokCredential,
  GrokTestResult,
  ImportPreviewBatchTestResult,
  ImportPreviewCommitRequest,
  ImportPreviewCommitResult,
  ImportPreviewDecision,
  ImportPreviewDisposition,
  ImportPreviewItem,
  ImportPreviewManualMode,
  ImportPreviewRefineRequest,
  ImportPreviewResult,
  ImportPreviewTestRequest,
  ImportPreviewTestSummary,
  ImportPreviewUnrecognized,
  NormalizedCredential,
  TestResult,
  UsageSummary
} from '../../shared/types'
import type { AccountManager, CodexImportPreparation } from './account-manager'
import type { GrokAccountManager, GrokImportPreparation } from './grok-account-manager'

const SESSION_TTL_MS = 20 * 60 * 1_000
const NO_CODEX_CREDENTIAL = /^No usable credentials found in /i
const NO_GROK_CREDENTIAL = /^未在 .+ 中找到 Grok 凭据$/

type PreparedCredential =
  | { provider: 'codex'; credential: NormalizedCredential }
  | { provider: 'grok'; credential: GrokCredential }

type StoredPreviewTest =
  | { provider: 'codex'; result: TestResult }
  | { provider: 'grok'; result: GrokTestResult }

interface ImportPreviewServiceOptions {
  concurrency: () => Promise<number>
  testCodex: (
    credential: NormalizedCredential,
    signal?: AbortSignal
  ) => Promise<{ credential: NormalizedCredential; result: TestResult }>
  testGrok: (
    credential: GrokCredential,
    signal?: AbortSignal
  ) => Promise<{ credential: GrokCredential; result: GrokTestResult }>
}

interface ImportPreviewTestOptions {
  signal?: AbortSignal
  onProgress?: (progress: {
    done: number
    total: number
    runningKeys: string[]
    updatedItem?: ImportPreviewItem
  }) => void
}

interface StoredImportSession {
  createdAt: number
  expiresAt: number
  recognized: number
  errors: string[]
  sourceCount: number
  items: ImportPreviewItem[]
  unrecognized: ImportPreviewUnrecognized[]
  sourceText: Map<string, string>
  credentials: Map<string, PreparedCredential>
  tests: Map<string, StoredPreviewTest>
}

function displayStatus(status: AccountStatus): DisplayAccountStatus {
  if (
    status === 'untested' ||
    status === 'valid' ||
    status === 'quota_exhausted_5h' ||
    status === 'quota_exhausted_weekly'
  ) return status
  if (status === 'quota_exhausted') return 'quota_exhausted_5h'
  if (['invalid', 'no_permission', 'workspace_deactivated', 'non_refreshable'].includes(status)) {
    return 'invalid'
  }
  return 'unknown_error'
}

function cloneUsage(usage: UsageSummary | null): UsageSummary | null {
  if (!usage) return null
  return {
    ...usage,
    windows: usage.windows.map((window) => ({ ...window })),
    credits: usage.credits ? { ...usage.credits } : usage.credits,
    spendLimit: usage.spendLimit ? { ...usage.spendLimit } : usage.spendLimit
  }
}

function previewTestSummary(result: TestResult | GrokTestResult): ImportPreviewTestSummary {
  return {
    status: 'stage' in result ? displayStatus(result.status) : result.status,
    detail: result.detail,
    checkedAt: result.checkedAt,
    httpStatus: result.httpStatus,
    refreshed: result.refreshed,
    usage: cloneUsage(result.usage)
  }
}

function sameCodexIdentity(left: NormalizedCredential, right: NormalizedCredential): boolean {
  if (left.id === right.id) return true
  if (left.email && right.email && left.email.toLowerCase() === right.email.toLowerCase()) return true
  return Boolean(left.subject && right.subject && left.subject === right.subject)
}

function sameGrokIdentity(left: GrokCredential, right: GrokCredential): boolean {
  if (left.id === right.id) return true
  if (left.email && right.email && left.email.toLowerCase() === right.email.toLowerCase()) return true
  return Boolean(left.subject && right.subject && left.subject === right.subject)
}

function sameCodexMaterial(left: NormalizedCredential, right: NormalizedCredential): boolean {
  return left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.idToken === right.idToken &&
    left.accountId === right.accountId &&
    left.authKind === right.authKind
}

function sameGrokMaterial(left: GrokCredential, right: GrokCredential): boolean {
  return left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.idToken === right.idToken &&
    left.teamId === right.teamId
}

function sourceRoot(path: string): string {
  const markers = ['#', '::']
  const marker = markers
    .map((value) => path.indexOf(value))
    .filter((value) => value >= 0)
    .sort((left, right) => left - right)[0]
  if (marker !== undefined) return path.slice(0, marker)
  if (/^pasted-/i.test(path) || path === 'oauth-callback') return 'pasted-input'
  return path
}

function sameSource(left: string, right: string): boolean {
  return sourceRoot(left).toLocaleLowerCase() === sourceRoot(right).toLocaleLowerCase()
}

function rebaseSource<T extends { sourcePath: string; sourceFormat: CredentialSourceFormat }>(
  credential: T,
  source: ImportPreviewUnrecognized
): T {
  return {
    ...credential,
    sourcePath: source.sourcePath,
    sourceFormat: source.sourceFormat
  }
}

function disposition(
  materialMatches: boolean,
  identityConflict: boolean,
  hasExisting: boolean
): { value: ImportPreviewDisposition; decision: ImportPreviewDecision; detail: string } {
  if (!hasExisting) return { value: 'new', decision: 'add', detail: '账号库中没有相同身份，将新增账号' }
  if (materialMatches) return { value: 'duplicate', decision: 'skip', detail: '账号和凭证内容均已存在' }
  if (identityConflict) {
    return {
      value: 'conflict',
      decision: 'skip',
      detail: '邮箱相同但用户标识不同，请确认后再覆盖现有凭证'
    }
  }
  return { value: 'update', decision: 'replace', detail: '相同账号包含不同或更完整的凭证，可与现有内容合并更新' }
}

function codexItem(
  credential: NormalizedCredential,
  existing: readonly NormalizedCredential[],
  index: number,
  keyPrefix = 'codex'
): ImportPreviewItem {
  const current = existing.find((item) => sameCodexIdentity(item, credential))
  const identityConflict = Boolean(
    current?.email && credential.email &&
    current.email.toLowerCase() === credential.email.toLowerCase() &&
    current.subject && credential.subject && current.subject !== credential.subject
  )
  const state = disposition(
    Boolean(current && sameCodexMaterial(current, credential)),
    identityConflict,
    Boolean(current)
  )
  return {
    key: `${keyPrefix}:${credential.id}:${index}`,
    provider: 'codex',
    credentialId: credential.id,
    existingCredentialId: current?.id ?? null,
    email: credential.email,
    planType: credential.planType,
    identity: credential.subject ?? credential.accountId ?? credential.email ?? credential.id.slice(0, 12),
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
    disposition: state.value,
    detail: state.detail,
    suggestedDecision: state.decision,
    test: null
  }
}

function grokItem(
  credential: GrokCredential,
  existing: readonly GrokCredential[],
  index: number,
  keyPrefix = 'grok'
): ImportPreviewItem {
  const current = existing.find((item) => sameGrokIdentity(item, credential))
  const identityConflict = Boolean(
    current?.email && credential.email &&
    current.email.toLowerCase() === credential.email.toLowerCase() &&
    current.subject && credential.subject && current.subject !== credential.subject
  )
  const state = disposition(
    Boolean(current && sameGrokMaterial(current, credential)),
    identityConflict,
    Boolean(current)
  )
  return {
    key: `${keyPrefix}:${credential.id}:${index}`,
    provider: 'grok',
    credentialId: credential.id,
    existingCredentialId: current?.id ?? null,
    email: credential.email,
    planType: credential.planType,
    identity: credential.subject ?? credential.teamId ?? credential.email ?? credential.id.slice(0, 12),
    sourcePath: credential.sourcePath,
    sourceFormat: credential.sourceFormat,
    sourceDialect: credential.sourceDialect,
    canRefresh: Boolean(credential.refreshToken),
    switchable: false,
    disposition: state.value,
    detail: state.detail,
    suggestedDecision: state.decision,
    test: null
  }
}

function publicSession(id: string, session: StoredImportSession): ImportPreviewResult {
  return {
    sessionId: id,
    createdAt: new Date(session.createdAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    sourceCount: session.sourceCount,
    recognized: session.recognized,
    errors: [...session.errors],
    items: session.items.map((item) => ({
      ...item,
      test: item.test
        ? { ...item.test, usage: cloneUsage(item.test.usage) }
        : item.test
    })),
    unrecognized: session.unrecognized.map((item) => ({ ...item }))
  }
}

export class ImportPreviewService {
  private readonly sessions = new Map<string, StoredImportSession>()

  constructor(
    private readonly codexManager: AccountManager,
    private readonly grokManager: GrokAccountManager,
    private readonly options?: ImportPreviewServiceOptions
  ) {}

  async create(
    codex: CodexImportPreparation,
    grok: GrokImportPreparation,
    inputText?: string
  ): Promise<ImportPreviewResult> {
    this.prune()
    const [existingCodex, existingGrok] = await Promise.all([
      this.codexManager.listCredentials(),
      this.grokManager.listCredentials()
    ])
    const credentials = new Map<string, PreparedCredential>()
    const items: ImportPreviewItem[] = []
    codex.credentials.forEach((credential, index) => {
      const item = codexItem(credential, existingCodex, index)
      items.push(item)
      credentials.set(item.key, { provider: 'codex', credential })
    })
    grok.credentials.forEach((credential, index) => {
      const item = grokItem(credential, existingGrok, index)
      items.push(item)
      credentials.set(item.key, { provider: 'grok', credential })
    })
    const recognized = codex.recognized + grok.recognized
    const recognizedSources = [
      ...codex.credentials.map((credential) => credential.sourcePath),
      ...grok.credentials.map((credential) => credential.sourcePath)
    ]
    const unknownBySource = new Map<string, ImportPreviewUnrecognized>()
    for (const source of [...(codex.unrecognized ?? []), ...(grok.unrecognized ?? [])]) {
      // A provider parser reports the other provider as "unknown" for a valid
      // mixed import. Only retain sources that neither parser recognized.
      if (recognizedSources.some((path) => sameSource(path, source.sourcePath))) continue
      const identity = `${sourceRoot(source.sourcePath).toLocaleLowerCase()}\0${source.sourceFormat}`
      if (!unknownBySource.has(identity)) {
        unknownBySource.set(identity, {
          ...source,
          key: `unknown:${unknownBySource.size}:${randomUUID()}`
        })
      }
    }
    const unrecognized = [...unknownBySource.values()]
    const sourceText = new Map<string, string>()
    if (inputText !== undefined) {
      for (const source of unrecognized) {
        if (sourceRoot(source.sourcePath) === 'pasted-input') {
          sourceText.set(source.key, inputText)
        }
      }
    }
    const errors = [...codex.errors, ...grok.errors].filter((error) =>
      recognized === 0 || (!NO_CODEX_CREDENTIAL.test(error) && !NO_GROK_CREDENTIAL.test(error))
    )
    const now = Date.now()
    const session: StoredImportSession = {
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      recognized,
      errors: [...new Set(errors)],
      sourceCount: Math.max(codex.sourceCount, grok.sourceCount),
      items,
      unrecognized,
      sourceText,
      credentials,
      tests: new Map()
    }
    const id = randomUUID()
    this.sessions.set(id, session)
    return publicSession(id, session)
  }

  async refine(request: ImportPreviewRefineRequest): Promise<ImportPreviewResult> {
    this.prune()
    const session = this.sessions.get(request.sessionId)
    if (!session) throw new Error('导入预检已过期，请重新识别凭证')
    const source = session.unrecognized.find((item) => item.key === request.sourceKey)
    if (!source) throw new Error('未找到仍待处理的未识别来源，请刷新导入预检')

    let prepared: CodexImportPreparation | GrokImportPreparation
    try {
      const root = sourceRoot(source.sourcePath)
      const inputText = session.sourceText.get(source.key)
      const loadText = async (): Promise<string> => {
        if (inputText !== undefined) return inputText
        if (root === 'pasted-input') throw new Error('原始粘贴内容已不可用，请返回后重新粘贴')
        return readFile(root, 'utf8')
      }

      if (request.mode === 'codex_rt' || request.mode === 'mobile_rt') {
        if (source.sourceFormat === 'zip') {
          throw new Error('ZIP 来源不能直接按 Refresh Token 兑换，请选择 Codex JSON/AT 或 Grok JSON/AT')
        }
        prepared = await this.codexManager.prepareRefreshTokens(
          await loadText(),
          request.mode === 'mobile_rt' ? 'mobile' : 'codex'
        )
      } else if (request.mode === 'codex') {
        prepared = inputText !== undefined
          ? await this.codexManager.preparePasted(inputText)
          : await this.codexManager.prepareFiles([root])
      } else {
        prepared = inputText !== undefined
          ? await this.grokManager.preparePasted(inputText)
          : await this.grokManager.prepareFiles([root])
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : '重新识别失败'
      source.detail = detail
      session.errors = [...new Set([...session.errors, detail])]
      return publicSession(request.sessionId, session)
    }

    const sourceIssues = prepared.unrecognized ?? []
    const credentials = prepared.credentials.map((credential) => rebaseSource(credential, source))
    if (credentials.length === 0) {
      source.detail = sourceIssues[0]?.detail ?? prepared.errors.at(-1) ?? '所选识别方式没有找到可用凭据'
      session.errors = [...new Set([...session.errors, ...prepared.errors])]
      return publicSession(request.sessionId, session)
    }

    session.errors = [...new Set([...session.errors, ...prepared.errors])]
    if (request.mode === 'grok') {
      let existing = [
        ...(await this.grokManager.listCredentials()),
        ...[...session.credentials.values()]
          .filter((stored): stored is { provider: 'grok'; credential: GrokCredential } => stored.provider === 'grok')
          .map((stored) => stored.credential)
      ]
      const keyPrefix = `refined-grok-${session.items.length}`
      credentials.forEach((credential, index) => {
        const item = grokItem(credential as GrokCredential, existing, index, keyPrefix)
        session.items.push(item)
        session.credentials.set(item.key, { provider: 'grok', credential: credential as GrokCredential })
        existing = [...existing, credential as GrokCredential]
      })
    } else {
      let existing = [
        ...(await this.codexManager.listCredentials()),
        ...[...session.credentials.values()]
          .filter((stored): stored is { provider: 'codex'; credential: NormalizedCredential } => stored.provider === 'codex')
          .map((stored) => stored.credential)
      ]
      const keyPrefix = `refined-codex-${session.items.length}`
      credentials.forEach((credential, index) => {
        const item = codexItem(credential as NormalizedCredential, existing, index, keyPrefix)
        session.items.push(item)
        session.credentials.set(item.key, { provider: 'codex', credential: credential as NormalizedCredential })
        existing = [...existing, credential as NormalizedCredential]
      })
    }
    session.recognized += prepared.recognized
    if (sourceIssues.length > 0) {
      source.detail = sourceIssues[0]?.detail ?? prepared.errors.at(-1) ?? '部分凭据仍未识别'
      session.errors = [...new Set([...session.errors, ...prepared.errors])]
    } else {
      session.unrecognized = session.unrecognized.filter((item) => item.key !== source.key)
      session.sourceText.delete(source.key)
    }
    return publicSession(request.sessionId, session)
  }

  async test(
    request: ImportPreviewTestRequest,
    options: ImportPreviewTestOptions = {}
  ): Promise<ImportPreviewBatchTestResult> {
    this.prune()
    const session = this.sessions.get(request.sessionId)
    if (!session) throw new Error('导入预检已过期，请重新识别凭证')
    if (!this.options) throw new Error('当前环境未配置导入凭证检测器')
    session.expiresAt = Date.now() + SESSION_TTL_MS

    const requestedKeys = request.itemKeys
      ? [...new Set(request.itemKeys)]
      : session.items.map((item) => item.key)
    const availableKeys = new Set(session.items.map((item) => item.key))
    const unknownKey = requestedKeys.find((key) => !availableKeys.has(key))
    if (unknownKey) throw new Error('检测列表包含已失效的导入账号，请刷新预览后重试')
    if (requestedKeys.length === 0) throw new Error('请至少选择一个要检测的账号')

    const [existingCodex, existingGrok, configuredConcurrency] = await Promise.all([
      this.codexManager.listCredentials(),
      this.grokManager.listCredentials(),
      this.options.concurrency()
    ])
    const runningKeys = new Set<string>()
    let cursor = 0
    let done = 0
    options.onProgress?.({ done, total: requestedKeys.length, runningKeys: [] })

    const worker = async (): Promise<void> => {
      while (!options.signal?.aborted) {
        const key = requestedKeys[cursor++]
        if (!key) return
        const stored = session.credentials.get(key)
        const previousItem = session.items.find((item) => item.key === key)
        if (!stored || !previousItem) throw new Error('导入预检内容不完整，请重新识别凭证')
        runningKeys.add(key)
        options.onProgress?.({ done, total: requestedKeys.length, runningKeys: [...runningKeys] })

        let nextStored: PreparedCredential = stored
        let storedTest: StoredPreviewTest
        try {
          if (stored.provider === 'codex') {
            const tested = await this.options!.testCodex(stored.credential, options.signal)
            const planType = tested.result.usage?.planType?.trim()
            const credential = planType && tested.credential.planType !== planType
              ? { ...tested.credential, planType }
              : tested.credential
            nextStored = { provider: 'codex', credential }
            storedTest = { provider: 'codex', result: tested.result }
          } else {
            const tested = await this.options!.testGrok(stored.credential, options.signal)
            const planType = tested.result.usage?.planType?.trim()
            const credential = planType && tested.credential.planType !== planType
              ? { ...tested.credential, planType }
              : tested.credential
            nextStored = { provider: 'grok', credential }
            storedTest = { provider: 'grok', result: tested.result }
          }
        } catch {
          if (options.signal?.aborted) {
            runningKeys.delete(key)
            return
          }
          const checkedAt = new Date().toISOString()
          storedTest = stored.provider === 'codex'
            ? {
                provider: 'codex',
                result: {
                  accountId: stored.credential.id,
                  status: 'network_error',
                  detail: '检测任务异常终止',
                  checkedAt,
                  httpStatus: null,
                  stage: 'local',
                  refreshed: false,
                  usage: null
                }
              }
            : {
                provider: 'grok',
                result: {
                  accountId: stored.credential.id,
                  status: 'unknown_error',
                  detail: '检测任务异常终止',
                  checkedAt,
                  httpStatus: null,
                  refreshed: false,
                  usage: null
                }
              }
        }

        if (options.signal?.aborted) {
          runningKeys.delete(key)
          return
        }

        const rebuilt = nextStored.provider === 'codex'
          ? codexItem(nextStored.credential, existingCodex, 0)
          : grokItem(nextStored.credential, existingGrok, 0)
        const updatedItem: ImportPreviewItem = {
          ...rebuilt,
          key,
          test: previewTestSummary(storedTest.result)
        }
        session.credentials.set(key, nextStored)
        session.tests.set(key, storedTest)
        session.items = session.items.map((item) => item.key === key ? updatedItem : item)
        session.expiresAt = Date.now() + SESSION_TTL_MS
        runningKeys.delete(key)
        done += 1
        options.onProgress?.({
          done,
          total: requestedKeys.length,
          runningKeys: [...runningKeys],
          updatedItem: { ...updatedItem, test: updatedItem.test ? { ...updatedItem.test, usage: cloneUsage(updatedItem.test.usage) } : null }
        })
      }
    }

    const concurrency = Math.max(1, Math.min(12, configuredConcurrency))
    await Promise.all(Array.from({ length: Math.min(concurrency, requestedKeys.length) }, () => worker()))
    return {
      tested: done,
      cancelled: Boolean(options.signal?.aborted),
      preview: publicSession(request.sessionId, session)
    }
  }

  async commit(request: ImportPreviewCommitRequest): Promise<ImportPreviewCommitResult> {
    this.prune()
    const session = this.sessions.get(request.sessionId)
    if (!session) throw new Error('导入预检已过期，请重新识别凭证')
    if (session.unrecognized.length > 0 && request.skipUnrecognized !== true) {
      throw new Error(`仍有 ${session.unrecognized.length} 个来源无法识别，请返回选择识别方式，或明确勾选跳过`)
    }
    const codexCredentials: NormalizedCredential[] = []
    const grokCredentials: GrokCredential[] = []
    const codexTests: TestResult[] = []
    const grokTests: GrokTestResult[] = []
    let added = 0
    let updated = 0
    let ignored = request.skipUnrecognized === true ? session.unrecognized.length : 0
    for (const item of session.items) {
      const decision = request.decisions[item.key] ?? item.suggestedDecision
      if (decision === 'skip') {
        ignored += 1
        continue
      }
      const stored = session.credentials.get(item.key)
      if (!stored) throw new Error('导入预检内容不完整，请重新识别凭证')
      const tested = session.tests.get(item.key)
      const targetId = item.existingCredentialId ?? stored.credential.id
      if (stored.provider === 'codex') {
        codexCredentials.push(stored.credential)
        if (tested?.provider === 'codex') codexTests.push({ ...tested.result, accountId: targetId })
      } else {
        grokCredentials.push(stored.credential)
        if (tested?.provider === 'grok') grokTests.push({ ...tested.result, accountId: targetId })
      }
      if (item.disposition === 'new') added += 1
      else if (item.disposition === 'update' || item.disposition === 'conflict') updated += 1
      else ignored += 1
    }

    const [codex, grok] = await Promise.all([
      codexCredentials.length > 0
        ? this.codexManager.importPrepared({
            credentials: codexCredentials,
            errors: [],
            recognized: codexCredentials.length,
            sourceCount: session.sourceCount,
            unrecognized: []
          })
        : Promise.resolve({
            imported: 0,
            skipped: 0,
            errors: [],
            accounts: await this.codexManager.listAccounts()
          }),
      grokCredentials.length > 0
        ? this.grokManager.importPrepared({
            credentials: grokCredentials,
            errors: [],
            recognized: grokCredentials.length,
            sourceCount: session.sourceCount,
            unrecognized: []
          })
        : Promise.resolve({
            imported: 0,
            skipped: 0,
            errors: [],
            accounts: await this.grokManager.listAccounts()
          })
    ])
    await Promise.all([
      codexTests.length > 0
        ? this.codexManager.persistImportedTestResults(codexTests)
        : Promise.resolve(),
      grokTests.length > 0
        ? this.grokManager.persistImportedTestResults(grokTests)
        : Promise.resolve()
    ])
    this.sessions.delete(request.sessionId)
    return {
      imported: codex.imported + grok.imported,
      skipped: codex.skipped + grok.skipped + ignored,
      recognized: session.recognized,
      errors: [...new Set([...session.errors, ...codex.errors, ...grok.errors])],
      codexImported: codex.imported,
      codexSkipped: codex.skipped,
      grokImported: grok.imported,
      grokSkipped: grok.skipped,
      accounts: codex.accounts,
      grokAccounts: grok.accounts,
      added,
      updated,
      ignored
    }
  }

  discard(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  private prune(now = Date.now()): void {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id)
    }
  }
}
