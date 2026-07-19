import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import type {
  CredentialSourceFormat,
  LibraryHealthIssue,
  LibraryHealthIssueKind,
  LibraryHealthRepairResult,
  LibraryHealthReport
} from '../../shared/types'
import { parseGrokCredentialText } from '../accounts/grok-parser'
import { parseCredentialText } from '../accounts/parser'
import type { AccountMetadataStore } from '../storage/account-metadata'
import type { AccountManager } from './account-manager'
import type { CpaCodexManager } from './cpa-codex-manager'
import type { GrokAccountManager } from './grok-account-manager'

interface StatusStoreLike {
  getAll(): Promise<Record<string, unknown>>
  removeMany(ids: string[]): Promise<void>
}

interface LibraryHealthOptions {
  codexDirectory: string
  grokDirectory: string
  cpaDirectory: () => string | Promise<string>
  quarantineDirectory: string
  accountManager: AccountManager
  grokManager: GrokAccountManager
  cpaCodexManager: CpaCodexManager
  cpaGrokManager: GrokAccountManager
  metadataStore: AccountMetadataStore
  statusStores: {
    codex: StatusStoreLike
    grok: StatusStoreLike
    cpaCodex: StatusStoreLike
    cpaGrok: StatusStoreLike
  }
}

type RepairDescriptor =
  | { type: 'canonicalize'; scope: 'aa-codex' | 'aa-grok' | 'cpa'; paths: string[] }
  | { type: 'quarantine'; scope: 'aa-codex' | 'aa-grok' | 'cpa'; paths: string[] }
  | { type: 'remove-status'; store: keyof LibraryHealthOptions['statusStores']; ids: string[] }
  | { type: 'remove-metadata'; ids: string[] }

interface StoredReport {
  createdAt: number
  report: LibraryHealthReport
  repairs: Map<string, RepairDescriptor>
}

interface ParsedFile {
  path: string
  codexIds: string[]
  grokIds: string[]
  recognized: number
  malformed: boolean
  canonical: boolean
}

const REPORT_TTL_MS = 20 * 60 * 1_000
const MAX_FILES = 30_000
const MAX_FILE_BYTES = 100 * 1024 * 1024

function formatForPath(path: string): CredentialSourceFormat | null {
  if (/\.json\.(?:0|无权限|无用量)$/i.test(path)) return 'json'
  const extension = extname(path).toLowerCase()
  if (extension === '.json') return 'json'
  if (extension === '.jsonl') return 'jsonl'
  if (extension === '.txt') return 'txt'
  if (extension === '.md') return 'md'
  if (['.js', '.mjs', '.cjs'].includes(extension)) return 'js'
  if (extension === '.zip') return 'zip'
  return null
}

function issueId(scope: string, kind: string, identity: string): string {
  return createHash('sha256').update(`${scope}\0${kind}\0${identity}`).digest('hex').slice(0, 24)
}

function within(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path))
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`))
}

async function collectFiles(directory: string): Promise<string[]> {
  const result: string[] = []
  const stack = [directory]
  while (stack.length > 0) {
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
      else if (entry.isFile() && formatForPath(path)) {
        result.push(path)
        if (result.length > MAX_FILES) throw new Error('账号库文件数量超过体检上限')
      }
    }
  }
  return result.sort((left, right) => left.localeCompare(right))
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= values.length) return
      results[index] = await operation(values[index])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker())
  )
  return results
}

function uniqueIdentity(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}

async function parseFile(
  path: string,
  canonicalPaths: ReadonlySet<string>
): Promise<ParsedFile> {
  const format = formatForPath(path)
  if (!format) return { path, codexIds: [], grokIds: [], recognized: 0, malformed: true, canonical: false }
  if (format === 'zip') {
    return { path, codexIds: [], grokIds: [], recognized: 0, malformed: false, canonical: false }
  }
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) {
      return { path, codexIds: [], grokIds: [], recognized: 0, malformed: true, canonical: false }
    }
    const text = await readFile(path, 'utf8')
    const codex = parseCredentialText(text, { sourcePath: path, format })
    const grok = parseGrokCredentialText(text, { sourcePath: path, format })
    const codexIds = uniqueIdentity(codex.credentials.map((credential) => credential.id))
    const grokIds = uniqueIdentity(grok.credentials.map((credential) => credential.id))
    return {
      path,
      codexIds,
      grokIds,
      recognized: codexIds.length + grokIds.length,
      malformed: codexIds.length === 0 && grokIds.length === 0,
      canonical: canonicalPaths.has(resolve(path).toLowerCase())
    }
  } catch {
    return { path, codexIds: [], grokIds: [], recognized: 0, malformed: true, canonical: false }
  }
}

function createIssue(
  scope: LibraryHealthIssue['scope'],
  kind: LibraryHealthIssueKind,
  title: string,
  detail: string,
  paths: string[],
  accountIds: string[],
  repairable: boolean,
  repairAction: string | null
): LibraryHealthIssue {
  const identity = [...paths, ...accountIds, title].sort().join('|')
  return {
    id: issueId(scope, kind, identity),
    scope,
    severity: kind === 'malformed_file' ? 'error' : kind.startsWith('orphan_') ? 'info' : 'warning',
    kind,
    title,
    detail,
    paths,
    accountIds,
    repairable,
    repairAction
  }
}

function duplicateIssues(
  scope: 'aa-codex' | 'aa-grok' | 'cpa',
  files: readonly ParsedFile[],
  provider: 'codex' | 'grok'
): LibraryHealthIssue[] {
  const grouped = new Map<string, string[]>()
  for (const file of files) {
    const ids = provider === 'codex' ? file.codexIds : file.grokIds
    for (const id of ids) {
      const paths = grouped.get(id) ?? []
      paths.push(file.path)
      grouped.set(id, paths)
    }
  }
  return [...grouped]
    .filter(([, paths]) => new Set(paths.map((path) => resolve(path).toLowerCase())).size > 1)
    .map(([id, paths]) => createIssue(
      scope,
      'duplicate_identity',
      `${provider === 'codex' ? 'Codex' : 'Grok'} 同一账号存在多个文件`,
      `同一稳定身份出现在 ${paths.length} 个凭证文件中`,
      [...new Set(paths)],
      [id],
      true,
      '保留信息最完整的凭证并统一为一账号一文件'
    ))
}

export class LibraryHealthService {
  private readonly reports = new Map<string, StoredReport>()

  constructor(private readonly options: LibraryHealthOptions) {}

  async inspect(): Promise<LibraryHealthReport> {
    this.prune()
    await this.options.metadataStore.getAll()
    const cpaDirectory = resolve(await this.options.cpaDirectory())
    const [codexAccounts, grokAccounts, cpaCodexAccounts, cpaGrokAccounts] = await Promise.all([
      this.options.accountManager.listAccounts(),
      this.options.grokManager.listAccounts(),
      this.options.cpaCodexManager.listAccounts(),
      this.options.cpaGrokManager.listAccounts()
    ])
    const canonicalCodex = new Set(codexAccounts.map((account) => resolve(account.sourcePath).toLowerCase()))
    const canonicalGrok = new Set(grokAccounts.map((account) => resolve(account.sourcePath).toLowerCase()))
    const canonicalCpa = new Set([
      ...cpaCodexAccounts.map((account) => resolve(account.sourcePath).toLowerCase()),
      ...cpaGrokAccounts.map((account) => resolve(account.sourcePath).toLowerCase())
    ])
    const [codexPaths, grokPaths, cpaPaths] = await Promise.all([
      collectFiles(this.options.codexDirectory),
      collectFiles(this.options.grokDirectory),
      collectFiles(cpaDirectory)
    ])
    const [codexFiles, grokFiles, cpaFiles] = await Promise.all([
      mapConcurrent(codexPaths, 12, (path) => parseFile(path, canonicalCodex)),
      mapConcurrent(grokPaths, 12, (path) => parseFile(path, canonicalGrok)),
      mapConcurrent(cpaPaths, 12, (path) => parseFile(path, canonicalCpa))
    ])
    const issues: LibraryHealthIssue[] = []
    const repairs = new Map<string, RepairDescriptor>()
    const add = (issue: LibraryHealthIssue, repair?: RepairDescriptor): void => {
      issues.push(issue)
      if (repair && issue.repairable) repairs.set(issue.id, repair)
    }
    const addFileIssues = (
      scope: 'aa-codex' | 'aa-grok' | 'cpa',
      files: readonly ParsedFile[],
      expectedProvider: 'codex' | 'grok' | 'mixed'
    ): void => {
      for (const file of files) {
        if (file.malformed) {
          const issue = createIssue(
            scope,
            'malformed_file',
            '无法识别的凭证文件',
            '文件不能解析为 Codex 或 Grok 凭证，可移出账号库后单独检查',
            [file.path],
            [],
            true,
            '移动到应用隔离目录'
          )
          add(issue, { type: 'quarantine', scope, paths: [file.path] })
          continue
        }
        if (file.codexIds.length > 0 && file.grokIds.length > 0) {
          const issue = createIssue(
            scope,
            'mixed_provider_file',
            '单个文件混合 Codex 与 Grok 账号',
            '修复后会按账号类型拆分为独立标准 JSON',
            [file.path],
            [...file.codexIds, ...file.grokIds],
            true,
            '按提供商和账号拆分文件'
          )
          add(issue, { type: 'canonicalize', scope, paths: [file.path] })
        }
        if (file.recognized > 1) {
          const issue = createIssue(
            scope,
            'multi_account_file',
            '单个文件包含多个账号',
            `检测到 ${file.recognized} 个账号，修复后会统一为一账号一文件`,
            [file.path],
            [...file.codexIds, ...file.grokIds],
            true,
            '拆分并统一文件名'
          )
          add(issue, { type: 'canonicalize', scope, paths: [file.path] })
        }
        const wrongProvider = expectedProvider === 'codex'
          ? file.grokIds.length > 0
          : expectedProvider === 'grok'
            ? file.codexIds.length > 0
            : false
        if (!file.canonical || wrongProvider) {
          const issue = createIssue(
            scope,
            'noncanonical_file',
            wrongProvider ? '账号位于错误的分类目录' : '文件名或格式不是托管标准',
            '修复后会写入标准 CPA 字段并按邮箱、等级统一命名',
            [file.path],
            [...file.codexIds, ...file.grokIds],
            true,
            '规范化并移动到正确位置'
          )
          add(issue, { type: 'canonicalize', scope, paths: [file.path] })
        }
      }
      for (const issue of duplicateIssues(scope, files, 'codex')) {
        add(issue, { type: 'canonicalize', scope, paths: issue.paths })
      }
      for (const issue of duplicateIssues(scope, files, 'grok')) {
        add(issue, { type: 'canonicalize', scope, paths: issue.paths })
      }
    }
    addFileIssues('aa-codex', codexFiles, 'codex')
    addFileIssues('aa-grok', grokFiles, 'grok')
    addFileIssues('cpa', cpaFiles, 'mixed')

    const validIds = {
      codex: new Set(codexAccounts.map((account) => account.id)),
      grok: new Set(grokAccounts.map((account) => account.id)),
      cpaCodex: new Set(cpaCodexAccounts.map((account) => account.id)),
      cpaGrok: new Set(cpaGrokAccounts.map((account) => account.id))
    }
    for (const storeName of Object.keys(this.options.statusStores) as Array<keyof typeof validIds>) {
      const entries = await this.options.statusStores[storeName].getAll()
      const orphanIds = Object.keys(entries).filter((id) => !validIds[storeName].has(id))
      if (orphanIds.length === 0) continue
      const issue = createIssue(
        storeName.startsWith('cpa') ? 'cpa' : storeName === 'codex' ? 'aa-codex' : 'aa-grok',
        'orphan_status',
        '存在已删除账号的状态缓存',
        `${orphanIds.length} 条检测状态已没有对应凭证`,
        [],
        orphanIds,
        true,
        '删除孤立状态缓存'
      )
      add(issue, { type: 'remove-status', store: storeName, ids: orphanIds })
    }

    const allAccountIds = new Set([
      ...validIds.codex,
      ...validIds.grok,
      ...validIds.cpaCodex,
      ...validIds.cpaGrok
    ])
    const metadata = await this.options.metadataStore.getAll()
    const orphanMetadataIds = Object.keys(metadata).filter((id) => !allAccountIds.has(id))
    if (orphanMetadataIds.length > 0) {
      const issue = createIssue(
        'metadata',
        'orphan_metadata',
        '存在已删除账号的标签信息',
        `${orphanMetadataIds.length} 条别名、标签或分组没有对应账号`,
        [],
        orphanMetadataIds,
        true,
        '删除孤立账号元数据'
      )
      add(issue, { type: 'remove-metadata', ids: orphanMetadataIds })
    }

    const snapshotId = randomUUID()
    const report: LibraryHealthReport = {
      snapshotId,
      generatedAt: new Date().toISOString(),
      scannedFiles: codexFiles.length + grokFiles.length + cpaFiles.length,
      healthyAccounts: allAccountIds.size,
      issues
    }
    this.reports.set(snapshotId, { createdAt: Date.now(), report, repairs })
    return report
  }

  async repair(snapshotId: string, issueIds: readonly string[]): Promise<LibraryHealthRepairResult> {
    this.prune()
    const stored = this.reports.get(snapshotId)
    if (!stored) throw new Error('账号库体检结果已过期，请重新检查')
    const selected = [...new Set(issueIds)]
    const descriptors = selected.flatMap((id) => {
      const descriptor = stored.repairs.get(id)
      return descriptor ? [{ id, descriptor }] : []
    })
    const errors: string[] = []
    const canonicalScopes = new Map<'aa-codex' | 'aa-grok' | 'cpa', Set<string>>()
    for (const { descriptor } of descriptors) {
      try {
        if (descriptor.type === 'canonicalize') {
          const paths = canonicalScopes.get(descriptor.scope) ?? new Set<string>()
          for (const path of descriptor.paths) paths.add(path)
          canonicalScopes.set(descriptor.scope, paths)
        }
        else if (descriptor.type === 'remove-status') {
          await this.options.statusStores[descriptor.store].removeMany(descriptor.ids)
        } else if (descriptor.type === 'remove-metadata') {
          await this.options.metadataStore.removeMany(descriptor.ids)
        } else {
          await this.quarantine(descriptor.scope, descriptor.paths)
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : '修复操作失败')
      }
    }
    for (const [scope, paths] of canonicalScopes) {
      try {
        await this.canonicalize(scope, [...paths])
      } catch (error) {
        errors.push(`${scope}: ${error instanceof Error ? error.message : '规范化失败'}`)
      }
    }
    this.reports.delete(snapshotId)
    const report = await this.inspect()
    const remaining = new Set(report.issues.map((issue) => issue.id))
    const repaired = selected.filter((id) => !remaining.has(id)).length
    const skipped = selected.length - repaired
    return {
      repaired,
      skipped,
      errors,
      message: `已修复 ${repaired} 项${skipped ? `，${skipped} 项仍需处理` : ''}${errors.length ? `，出现 ${errors.length} 个错误` : ''}`,
      report
    }
  }

  private async canonicalize(
    scope: 'aa-codex' | 'aa-grok' | 'cpa',
    inputPaths: readonly string[]
  ): Promise<void> {
    const cpaDirectory = resolve(await this.options.cpaDirectory())
    const root = scope === 'aa-codex'
      ? resolve(this.options.codexDirectory)
      : scope === 'aa-grok'
        ? resolve(this.options.grokDirectory)
        : cpaDirectory
    const paths = [...new Set(inputPaths.map((path) => resolve(path)))]
    for (const path of paths) {
      if (!within(root, path)) throw new Error('待规范化文件不在受管理账号目录内')
    }

    // Parse both providers before any manager can rename or remove a mixed source file.
    const [codex, grok] = await Promise.all([
      this.options.accountManager.prepareFiles(paths),
      this.options.grokManager.prepareFiles(paths)
    ])
    if (codex.credentials.length + grok.credentials.length === 0) {
      throw new Error('选中文件中没有可规范化的凭证')
    }

    if (scope === 'cpa') {
      await Promise.all([
        codex.credentials.length > 0
          ? this.options.cpaCodexManager.importFiles(paths)
          : Promise.resolve(),
        grok.credentials.length > 0
          ? this.options.cpaGrokManager.importPrepared(grok)
          : Promise.resolve()
      ])
    } else {
      await Promise.all([
        codex.credentials.length > 0
          ? this.options.accountManager.importPrepared(codex)
          : Promise.resolve(),
        grok.credentials.length > 0
          ? this.options.grokManager.importPrepared(grok)
          : Promise.resolve()
      ])
    }

    const protectedPaths = new Set<string>()
    if (scope === 'aa-codex') {
      for (const account of await this.options.accountManager.listAccounts()) {
        protectedPaths.add(resolve(account.sourcePath).toLowerCase())
      }
    } else if (scope === 'aa-grok') {
      for (const account of await this.options.grokManager.listAccounts()) {
        protectedPaths.add(resolve(account.sourcePath).toLowerCase())
      }
    } else {
      const [codexAccounts, grokAccounts] = await Promise.all([
        this.options.cpaCodexManager.listAccounts(),
        this.options.cpaGrokManager.listAccounts()
      ])
      for (const account of [...codexAccounts, ...grokAccounts]) {
        protectedPaths.add(resolve(account.sourcePath).toLowerCase())
      }
    }
    await Promise.all(paths.map(async (path) => {
      if (!protectedPaths.has(resolve(path).toLowerCase())) await rm(path, { force: true })
    }))
  }

  private async quarantine(
    scope: 'aa-codex' | 'aa-grok' | 'cpa',
    paths: readonly string[]
  ): Promise<void> {
    const cpaDirectory = resolve(await this.options.cpaDirectory())
    const root = scope === 'aa-codex'
      ? resolve(this.options.codexDirectory)
      : scope === 'aa-grok'
        ? resolve(this.options.grokDirectory)
        : cpaDirectory
    const directory = join(this.options.quarantineDirectory, scope)
    await mkdir(directory, { recursive: true })
    for (const source of paths) {
      if (!within(root, source)) throw new Error('待隔离文件不在受管理账号目录内')
      const target = join(directory, `${Date.now()}-${randomUUID().slice(0, 8)}-${basename(source)}`)
      await copyFile(source, target)
      await rm(source, { force: true })
    }
  }

  private prune(now = Date.now()): void {
    for (const [id, report] of this.reports) {
      if (report.createdAt + REPORT_TTL_MS <= now) this.reports.delete(id)
    }
  }
}
