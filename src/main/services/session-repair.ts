import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionRepairPreview, SessionRepairResult } from '../../shared/types'

const DEFAULT_PROVIDER = 'openai'
const SESSION_DIRECTORIES = ['sessions', 'archived_sessions'] as const
const MANAGED_BY = 'Codex Account Switcher provider sync'

type FaultStage = 'after-rollouts' | 'after-sqlite' | 'after-global-state'

interface SessionRepairOptions {
  codexHome: string
  backupRetention?: number
  now?: () => Date
  faultInjector?: (stage: FaultStage) => void
}

interface RolloutChange {
  path: string
  originalSessionMetaLines: string[]
  nextSessionMetaLine: string
  contentHash: string
  originalAtime: Date
  originalMtime: Date
  rewriteNeeded: boolean
  threadId: string | null
  cwd: string | null
  hasUserEvent: boolean
  providers: string[]
  hasEncryptedContent: boolean
}

interface RolloutInspection {
  change: RolloutChange | null
  lockedPath: string | null
}

interface SqliteCounts {
  provider: number
  userEvent: number
  cwd: number
}

interface GlobalStatePlan {
  path: string
  originalText: string | null
  nextText: string | null
  changedKeys: number
  projectlessThreadIds: Set<string>
}

interface RepairPlan {
  preview: SessionRepairPreview
  changes: RolloutChange[]
  databasePaths: string[]
  userEventThreadIds: Set<string>
  cwdByThreadId: Map<string, string>
  globalState: GlobalStatePlan
  selectedThreadIds: Set<string> | null
}

interface BackupEntry {
  source: string
  backup: string
}

interface BackupState {
  directory: string
  databaseFiles: BackupEntry[]
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function validProvider(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value)
}

function currentProvider(configText: string): string {
  for (const line of configText.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break
    const match = line.match(/^\s*model_provider\s*=\s*["']([^"']+)["']/)
    if (match?.[1]?.trim()) return match[1].trim()
  }
  return DEFAULT_PROVIDER
}

function splitLineEnding(segment: string): [string, string] {
  if (segment.endsWith('\r\n')) return [segment.slice(0, -2), '\r\n']
  if (segment.endsWith('\n')) return [segment.slice(0, -1), '\n']
  return [segment, '']
}

function normalizeWorkspacePath(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('\\\\?\\unc\\')) {
    return `\\\\${trimmed.slice(8).replaceAll('/', '\\')}`
  }
  if (trimmed.startsWith('\\\\?\\')) {
    return trimmed.slice(4).replaceAll('\\', '/')
  }
  return trimmed
}

function dedupeWorkspacePaths(values: unknown): string[] {
  const input = Array.isArray(values) ? values : typeof values === 'string' ? [values] : []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of input) {
    if (typeof item !== 'string') continue
    const normalized = normalizeWorkspacePath(item)
    if (!normalized) continue
    const key = normalized.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }
  return result
}

function normalizeObjectPathKeys(value: unknown): Record<string, unknown> | null {
  const source = record(value)
  if (!source) return null
  const next: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    next[normalizeWorkspacePath(key) ?? key] = item
  }
  return next
}

function normalizedGlobalState(source: Record<string, unknown>): Record<string, unknown> {
  const next = { ...source }
  for (const key of ['electron-saved-workspace-roots', 'project-order'] as const) {
    if (key in source) next[key] = dedupeWorkspacePaths(source[key])
  }
  if ('active-workspace-roots' in source) {
    const paths = dedupeWorkspacePaths(source['active-workspace-roots'])
    next['active-workspace-roots'] = Array.isArray(source['active-workspace-roots'])
      ? paths
      : (paths[0] ?? source['active-workspace-roots'])
  }
  const labels = normalizeObjectPathKeys(source['electron-workspace-root-labels'])
  if (labels) next['electron-workspace-root-labels'] = labels
  const preferences = record(source['open-in-target-preferences'])
  if (preferences) {
    const perPath = normalizeObjectPathKeys(preferences.perPath)
    next['open-in-target-preferences'] = perPath
      ? { ...preferences, perPath }
      : { ...preferences }
  }
  return next
}

function changedGlobalKeys(
  original: Record<string, unknown>,
  next: Record<string, unknown>
): number {
  return Object.keys(next).filter(
    (key) => JSON.stringify(original[key]) !== JSON.stringify(next[key])
  ).length
}

function isLockedError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'EACCES' || code === 'EPERM' || code === 'EBUSY'
}

function sqliteNumber(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const escaped = table.replaceAll('"', '""')
  return new Set(
    db
      .prepare(`PRAGMA table_info("${escaped}")`)
      .all()
      .map((row) => String((row as Record<string, unknown>).name ?? ''))
  )
}

function inspectDatabase(
  path: string,
  targetProvider: string,
  userEventThreadIds: Set<string>,
  cwdByThreadId: Map<string, string>,
  selectedThreadIds: Set<string> | null
): { counts: SqliteCounts; providers: string[] } {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const columns = tableColumns(db, 'threads')
    if (!columns.has('model_provider')) {
      return { counts: { provider: 0, userEvent: 0, cwd: 0 }, providers: [] }
    }
    let provider = 0
    if (selectedThreadIds) {
      const query = db.prepare(
        "SELECT COUNT(*) AS count FROM threads WHERE id = ? AND COALESCE(model_provider, '') <> ?"
      )
      for (const id of selectedThreadIds) {
        provider += sqliteNumber((query.get(id, targetProvider) as Record<string, unknown> | undefined)?.count)
      }
    } else {
      const providerRow = db
        .prepare("SELECT COUNT(*) AS count FROM threads WHERE COALESCE(model_provider, '') <> ?")
        .get(targetProvider) as Record<string, unknown> | undefined
      provider = sqliteNumber(providerRow?.count)
    }
    const providers = db
      .prepare(
        "SELECT DISTINCT COALESCE(model_provider, '') AS provider FROM threads WHERE COALESCE(model_provider, '') <> ''"
      )
      .all()
      .map((row) => String((row as Record<string, unknown>).provider ?? ''))
      .filter(Boolean)
    let userEvent = 0
    if (columns.has('has_user_event')) {
      const query = db.prepare(
        'SELECT COUNT(*) AS count FROM threads WHERE id = ? AND COALESCE(has_user_event, 0) <> 1'
      )
      for (const id of userEventThreadIds) {
        userEvent += sqliteNumber((query.get(id) as Record<string, unknown> | undefined)?.count)
      }
    }
    let cwd = 0
    if (columns.has('cwd')) {
      const query = db.prepare(
        "SELECT COUNT(*) AS count FROM threads WHERE id = ? AND COALESCE(cwd, '') <> ?"
      )
      for (const [id, pathValue] of cwdByThreadId) {
        cwd += sqliteNumber(
          (query.get(id, pathValue) as Record<string, unknown> | undefined)?.count
        )
      }
    }
    return {
      counts: {
        provider,
        userEvent,
        cwd
      },
      providers
    }
  } finally {
    db.close()
  }
}

function updateDatabase(
  path: string,
  targetProvider: string,
  userEventThreadIds: Set<string>,
  cwdByThreadId: Map<string, string>,
  selectedThreadIds: Set<string> | null
): SqliteCounts {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    const columns = tableColumns(db, 'threads')
    if (!columns.has('model_provider')) return { provider: 0, userEvent: 0, cwd: 0 }
    db.exec('BEGIN IMMEDIATE')
    try {
      let provider = 0
      if (selectedThreadIds) {
        const update = db.prepare(
          "UPDATE threads SET model_provider = ? WHERE id = ? AND COALESCE(model_provider, '') <> ?"
        )
        for (const id of selectedThreadIds) {
          provider += Number(update.run(targetProvider, id, targetProvider).changes)
        }
      } else {
        provider = Number(
          db
            .prepare("UPDATE threads SET model_provider = ? WHERE COALESCE(model_provider, '') <> ?")
            .run(targetProvider, targetProvider).changes
        )
      }
      let userEvent = 0
      if (columns.has('has_user_event')) {
        const update = db.prepare(
          'UPDATE threads SET has_user_event = 1 WHERE id = ? AND COALESCE(has_user_event, 0) <> 1'
        )
        for (const id of userEventThreadIds) userEvent += Number(update.run(id).changes)
      }
      let cwd = 0
      if (columns.has('cwd')) {
        const update = db.prepare(
          "UPDATE threads SET cwd = ? WHERE id = ? AND COALESCE(cwd, '') <> ?"
        )
        for (const [id, value] of cwdByThreadId) {
          cwd += Number(update.run(value, id, value).changes)
        }
      }
      db.exec('COMMIT')
      return { provider, userEvent, cwd }
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // The original error is more useful.
      }
      throw error
    }
  } finally {
    db.close()
  }
}

async function collectRolloutPaths(root: string): Promise<string[]> {
  const result: string[] = []
  async function visit(path: string): Promise<void> {
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) result.push(child)
    }
  }
  await visit(root)
  return result.sort()
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
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

function sessionMeta(line: string): { root: Record<string, unknown>; payload: Record<string, unknown> } | null {
  try {
    const root = record(JSON.parse(line))
    const payload = record(root?.payload)
    return root?.type === 'session_meta' && payload ? { root, payload } : null
  } catch {
    return null
  }
}

async function rolloutChange(
  path: string,
  targetProvider: string,
  selectedThreadIds?: ReadonlySet<string> | null
): Promise<RolloutChange | null> {
  const metadata = await stat(path)
  const hash = createHash('sha256')
  let pending = Buffer.alloc(0)
  let originalSessionMetaLine: string | null = null
  let nextSessionMetaLine = ''
  const providers: string[] = []
  let rewriteNeeded = false
  let threadId: string | null = null
  let cwd: string | null = null
  let hasUserEvent = false
  let hasEncryptedContent = false
  let searchTail = ''

  const inspectLine = (line: string): void => {
    if (originalSessionMetaLine !== null || !line.trim()) return
    const parsed = sessionMeta(line)
    if (!parsed) return
    originalSessionMetaLine = line
    const { root, payload } = parsed
    if (typeof payload.id === 'string') threadId = payload.id
    if (typeof payload.cwd === 'string') cwd = normalizeWorkspacePath(payload.cwd)
    const provider = typeof payload.model_provider === 'string' ? payload.model_provider : '(missing)'
    providers.push(provider)
    if (provider !== targetProvider) {
      payload.model_provider = targetProvider
      rewriteNeeded = true
    }
    nextSessionMetaLine = JSON.stringify(root)
  }

  for await (const rawChunk of createReadStream(path)) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    hash.update(chunk)
    const searchable = searchTail + chunk.toString('utf8')
    hasUserEvent ||= searchable.includes('"user_message"') || searchable.includes('"user_input"')
    hasEncryptedContent ||= searchable.includes('encrypted_content')
    searchTail = searchable.slice(-64)

    if (originalSessionMetaLine === null) {
      pending = Buffer.concat([pending, chunk])
      let newline = pending.indexOf(0x0a)
      while (newline >= 0 && originalSessionMetaLine === null) {
        const segment = pending.subarray(0, newline + 1).toString('utf8')
        pending = pending.subarray(newline + 1)
        inspectLine(splitLineEnding(segment)[0])
        newline = pending.indexOf(0x0a)
      }
      if (
        originalSessionMetaLine !== null &&
        selectedThreadIds &&
        (!threadId || !selectedThreadIds.has(threadId))
      ) {
        return null
      }
      if (originalSessionMetaLine === null && pending.byteLength > 16 * 1024 * 1024) {
        throw new Error('会话元数据行超过安全限制')
      }
    }
  }
  if (originalSessionMetaLine === null && pending.byteLength > 0) {
    inspectLine(pending.toString('utf8'))
  }
  if (originalSessionMetaLine === null) return null
  return {
    path,
    originalSessionMetaLines: [originalSessionMetaLine],
    nextSessionMetaLine,
    contentHash: hash.digest('hex'),
    originalAtime: metadata.atime,
    originalMtime: metadata.mtime,
    rewriteNeeded,
    threadId,
    cwd,
    hasUserEvent,
    providers,
    hasEncryptedContent
  }
}

async function writeChunk(stream: ReturnType<typeof createWriteStream>, chunk: Buffer): Promise<void> {
  if (stream.write(chunk)) return
  await once(stream, 'drain')
}

async function replaceSessionMeta(path: string, replacementLine: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const previous = `${path}.${randomUUID()}.previous`
  const output = createWriteStream(temporary)
  const outputFinished = finished(output)
  let pending = Buffer.alloc(0)
  let replaced = false
  try {
    for await (const rawChunk of createReadStream(path)) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
      if (replaced) {
        await writeChunk(output, chunk)
        continue
      }
      pending = Buffer.concat([pending, chunk])
      let newline = pending.indexOf(0x0a)
      while (newline >= 0 && !replaced) {
        const segment = pending.subarray(0, newline + 1)
        pending = pending.subarray(newline + 1)
        const text = segment.toString('utf8')
        const [line, ending] = splitLineEnding(text)
        if (sessionMeta(line)) {
          await writeChunk(output, Buffer.from(replacementLine + ending, 'utf8'))
          replaced = true
        } else {
          await writeChunk(output, segment)
        }
        newline = pending.indexOf(0x0a)
      }
      if (replaced && pending.byteLength > 0) {
        await writeChunk(output, pending)
        pending = Buffer.alloc(0)
      }
    }
    if (!replaced && pending.byteLength > 0) {
      const line = pending.toString('utf8')
      if (sessionMeta(line)) {
        await writeChunk(output, Buffer.from(replacementLine, 'utf8'))
        replaced = true
      } else {
        await writeChunk(output, pending)
      }
    }
    if (!replaced) throw new Error('会话元数据已发生变化')
    output.end()
    await outputFinished
    await rename(path, previous)
    try {
      await rename(temporary, path)
      await rm(previous, { force: true })
    } catch (error) {
      await rm(path, { force: true })
      await rename(previous, path)
      throw error
    }
  } catch (error) {
    output.destroy()
    await outputFinished.catch(() => undefined)
    await rm(temporary, { force: true })
    throw error
  }
}

async function atomicReplace(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const previous = `${path}.${randomUUID()}.previous`
  await writeFile(temporary, text, 'utf8')
  await rename(path, previous)
  try {
    await rename(temporary, path)
    await rm(previous, { force: true })
  } catch (error) {
    await rm(path, { force: true })
    await rename(previous, path)
    await rm(temporary, { force: true })
    throw error
  }
}

async function existingDatabasePaths(home: string): Promise<string[]> {
  const result: string[] = []
  const legacy = join(home, 'state_5.sqlite')
  try {
    if ((await stat(legacy)).isFile()) result.push(legacy)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const sqliteDirectory = join(home, 'sqlite')
  try {
    for (const entry of await readdir(sqliteDirectory, { withFileTypes: true })) {
      if (entry.isFile() && ['.db', '.sqlite'].includes(extname(entry.name).toLowerCase())) {
        result.push(join(sqliteDirectory, entry.name))
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return result.sort()
}

async function loadGlobalState(home: string): Promise<GlobalStatePlan> {
  const path = join(home, '.codex-global-state.json')
  let originalText: string | null = null
  try {
    originalText = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const source = record(originalText ? JSON.parse(originalText) : null) ?? {}
  const projectlessThreadIds = new Set(
    (Array.isArray(source['projectless-thread-ids']) ? source['projectless-thread-ids'] : [])
      .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
  )
  const next = normalizedGlobalState(source)
  const changedKeys = changedGlobalKeys(source, next)
  return {
    path,
    originalText,
    nextText: changedKeys > 0 ? `${JSON.stringify(next, null, 2)}\n` : originalText,
    changedKeys,
    projectlessThreadIds
  }
}

async function hashFile(hash: ReturnType<typeof createHash>, path: string): Promise<void> {
  try {
    hash.update(path)
    hash.update(await readFile(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    hash.update(`${path}:missing`)
  }
}

async function snapshotId(
  targetProvider: string,
  configPath: string,
  globalPath: string,
  changes: RolloutChange[],
  databasePaths: string[],
  selectedThreadIds: Set<string> | null
): Promise<string> {
  const hash = createHash('sha256').update(targetProvider)
  if (selectedThreadIds) {
    for (const id of [...selectedThreadIds].sort()) hash.update(id)
  }
  await hashFile(hash, configPath)
  await hashFile(hash, globalPath)
  for (const change of changes) {
    hash.update(change.path)
    hash.update(change.contentHash)
  }
  for (const path of databasePaths) {
    await hashFile(hash, path)
    await hashFile(hash, `${path}-wal`)
    await hashFile(hash, `${path}-shm`)
  }
  return hash.digest('hex')
}

async function copyIfExists(source: string, target: string): Promise<boolean> {
  try {
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export class SessionRepairService {
  private readonly backupRetention: number
  private readonly now: () => Date

  constructor(private readonly options: SessionRepairOptions) {
    this.backupRetention = Math.max(1, Math.min(100, options.backupRetention ?? 20))
    this.now = options.now ?? (() => new Date())
  }

  async preview(explicitTarget?: string, threadIds?: readonly string[]): Promise<SessionRepairPreview> {
    return (await this.buildPlan(explicitTarget, threadIds)).preview
  }

  async apply(
    snapshot: string,
    explicitTarget: string,
    threadIds?: readonly string[]
  ): Promise<SessionRepairResult> {
    if (!validProvider(explicitTarget)) return this.failure('供应商 ID 无效', explicitTarget)
    const lockPath = join(this.options.codexHome, 'tmp', 'account-switcher-provider-sync.lock')
    try {
      await mkdir(dirname(lockPath), { recursive: true })
      await mkdir(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return this.failure('已有历史会话修复任务正在运行', explicitTarget)
      }
      return this.failure(error instanceof Error ? error.message : '无法创建修复锁', explicitTarget)
    }

    let backup: BackupState | null = null
    let plan: RepairPlan | null = null
    try {
      plan = await this.buildPlan(explicitTarget, threadIds)
      if (plan.preview.snapshotId !== snapshot) {
        return this.failure('Codex 数据已在预览后发生变化，请重新预览', explicitTarget)
      }
      const sqliteRows =
        plan.preview.sqliteProviderRows +
        plan.preview.sqliteUserEventRows +
        plan.preview.sqliteCwdRows
      if (
        plan.preview.changedSessionFiles === 0 &&
        sqliteRows === 0 &&
        plan.preview.globalStateKeys === 0
      ) {
        return {
          ok: true,
          message: '历史会话已经与当前供应商一致',
          targetProvider: explicitTarget,
          changedSessionFiles: 0,
          sqliteRowsUpdated: 0,
          globalStateKeysUpdated: 0,
          backupPath: null
        }
      }
      backup = await this.createBackup(plan)
      await mapConcurrent(
        plan.changes.filter((item) => item.rewriteNeeded),
        2,
        async (change) => {
          await replaceSessionMeta(change.path, change.nextSessionMetaLine)
          await utimes(change.path, change.originalAtime, change.originalMtime)
        }
      )
      this.options.faultInjector?.('after-rollouts')

      const updated: SqliteCounts = { provider: 0, userEvent: 0, cwd: 0 }
      for (const path of plan.databasePaths) {
        const counts = updateDatabase(
          path,
          explicitTarget,
          plan.userEventThreadIds,
          plan.cwdByThreadId,
          plan.selectedThreadIds
        )
        updated.provider += counts.provider
        updated.userEvent += counts.userEvent
        updated.cwd += counts.cwd
      }
      this.options.faultInjector?.('after-sqlite')

      if (plan.globalState.changedKeys > 0 && plan.globalState.nextText !== null) {
        if (plan.globalState.originalText === null) {
          await mkdir(dirname(plan.globalState.path), { recursive: true })
          await writeFile(plan.globalState.path, plan.globalState.nextText, 'utf8')
        } else {
          await atomicReplace(plan.globalState.path, plan.globalState.nextText)
        }
        await writeFile(`${plan.globalState.path}.bak`, plan.globalState.nextText, 'utf8')
      }
      this.options.faultInjector?.('after-global-state')
      const verification = await this.buildPlan(explicitTarget, threadIds)
      const pendingRows =
        verification.preview.sqliteProviderRows +
        verification.preview.sqliteUserEventRows +
        verification.preview.sqliteCwdRows
      if (
        verification.preview.changedSessionFiles > 0 ||
        pendingRows > 0 ||
        verification.preview.globalStateKeys > 0
      ) {
        throw new Error(
          `修复后复检未通过：仍有 ${verification.preview.changedSessionFiles} 个会话文件和 ${pendingRows} 条状态记录待修复`
        )
      }
      await this.pruneBackups()
      const skipped = verification.preview.skippedLockedFiles.length
      return {
        ok: true,
        message: `历史会话修复完成并复检通过：文件 ${plan.preview.changedSessionFiles}，状态 ${updated.provider + updated.userEvent + updated.cwd}，全局配置 ${plan.globalState.changedKeys}${skipped > 0 ? `；${skipped} 个锁定文件未处理` : ''}`,
        targetProvider: explicitTarget,
        changedSessionFiles: plan.preview.changedSessionFiles,
        sqliteRowsUpdated: updated.provider + updated.userEvent + updated.cwd,
        globalStateKeysUpdated: plan.globalState.changedKeys,
        backupPath: backup.directory
      }
    } catch (error) {
      if (plan && backup) await this.rollback(plan, backup)
      return this.failure(
        `历史会话修复失败，已回滚: ${error instanceof Error ? error.message : String(error)}`,
        explicitTarget,
        backup?.directory ?? null
      )
    } finally {
      await rm(lockPath, { recursive: true, force: true })
    }
  }

  private async buildPlan(
    explicitTarget?: string,
    threadIds?: readonly string[]
  ): Promise<RepairPlan> {
    const configPath = join(this.options.codexHome, 'config.toml')
    let configText = ''
    try {
      configText = await readFile(configPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const configuredProvider = currentProvider(configText)
    const targetProvider = explicitTarget?.trim() || configuredProvider
    if (!validProvider(targetProvider)) throw new Error('供应商 ID 无效')
    const globalState = await loadGlobalState(this.options.codexHome)
    const rolloutPaths = (
      await Promise.all(
        SESSION_DIRECTORIES.map((directory) =>
          collectRolloutPaths(join(this.options.codexHome, directory))
        )
      )
    ).flat()
    const selectedThreadIds = threadIds && threadIds.length > 0
      ? new Set(threadIds.filter((id) => Boolean(id.trim())))
      : null
    const inspections = await mapConcurrent<string, RolloutInspection>(rolloutPaths, 4, async (path) => {
      try {
        return {
          change: await rolloutChange(path, targetProvider, selectedThreadIds),
          lockedPath: null
        }
      } catch (error) {
        if (isLockedError(error)) return { change: null, lockedPath: path }
        throw error
      }
    })
    const allChanges = inspections.flatMap((inspection) => inspection.change ? [inspection.change] : [])
    const changes = selectedThreadIds
      ? allChanges.filter((change) => change.threadId && selectedThreadIds.has(change.threadId))
      : allChanges
    const skippedLockedFiles = inspections.flatMap((inspection) => inspection.lockedPath ? [inspection.lockedPath] : [])
    const userEventThreadIds = new Set(
      changes
        .filter((change) => change.hasUserEvent)
        .map((change) => change.threadId)
        .filter((value): value is string => Boolean(value))
    )
    const cwdByThreadId = new Map<string, string>()
    for (const change of changes) {
      if (
        change.threadId &&
        change.cwd &&
        !globalState.projectlessThreadIds.has(change.threadId)
      ) {
        cwdByThreadId.set(change.threadId, change.cwd)
      }
    }
    const databasePaths = await existingDatabasePaths(this.options.codexHome)
    const sqliteCounts: SqliteCounts = { provider: 0, userEvent: 0, cwd: 0 }
    const providers = new Set<string>([DEFAULT_PROVIDER, configuredProvider])
    for (const change of changes) {
      for (const provider of change.providers) {
        if (validProvider(provider)) providers.add(provider)
      }
    }
    for (const path of databasePaths) {
      const inspected = inspectDatabase(
        path,
        targetProvider,
        userEventThreadIds,
        cwdByThreadId,
        selectedThreadIds
      )
      sqliteCounts.provider += inspected.counts.provider
      sqliteCounts.userEvent += inspected.counts.userEvent
      sqliteCounts.cwd += inspected.counts.cwd
      for (const provider of inspected.providers) if (validProvider(provider)) providers.add(provider)
    }
    providers.add(targetProvider)
    const encryptedChanges = changes.filter(
      (change) =>
        change.hasEncryptedContent && change.providers.some((provider) => provider !== targetProvider)
    )
    const encryptedProviders = new Set(
      encryptedChanges.flatMap((change) => change.providers.filter((item) => item !== targetProvider))
    )
    const preview: SessionRepairPreview = {
      snapshotId: await snapshotId(
        targetProvider,
        configPath,
        globalState.path,
        changes,
        databasePaths,
        selectedThreadIds
      ),
      currentProvider: configuredProvider,
      targetProvider,
      availableProviders: [...providers].sort((left, right) =>
        left === configuredProvider ? -1 : right === configuredProvider ? 1 : left.localeCompare(right)
      ),
      scannedSessionFiles: selectedThreadIds ? changes.length : rolloutPaths.length,
      changedSessionFiles: changes.filter((change) => change.rewriteNeeded).length,
      skippedLockedFiles,
      encryptedContentFiles: encryptedChanges.length,
      encryptedContentProviders: [...encryptedProviders].sort(),
      sqliteProviderRows: sqliteCounts.provider,
      sqliteUserEventRows: sqliteCounts.userEvent,
      sqliteCwdRows: sqliteCounts.cwd,
      globalStateKeys: globalState.changedKeys
    }
    return {
      preview,
      changes,
      databasePaths,
      userEventThreadIds,
      cwdByThreadId,
      globalState,
      selectedThreadIds
    }
  }

  private async createBackup(plan: RepairPlan): Promise<BackupState> {
    const root = join(this.options.codexHome, 'backups_state', 'account-switcher-provider-sync')
    const stamp = this.now().toISOString().replace(/[:.]/g, '-')
    let directory = join(root, stamp)
    let suffix = 0
    while (true) {
      try {
        await mkdir(directory, { recursive: false })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            await mkdir(root, { recursive: true })
            continue
          }
          throw error
        }
        suffix += 1
        directory = join(root, `${stamp}-${suffix}`)
      }
    }
    for (const name of [
      'config.toml',
      '.codex-global-state.json',
      '.codex-global-state.json.bak'
    ]) {
      await copyIfExists(join(this.options.codexHome, name), join(directory, name))
    }
    const databaseFiles: BackupEntry[] = []
    for (const path of plan.databasePaths) {
      for (const source of [path, `${path}-wal`, `${path}-shm`]) {
        const target = join(directory, 'db', relative(this.options.codexHome, source))
        if (await copyIfExists(source, target)) databaseFiles.push({ source, backup: target })
      }
    }
    await writeFile(
      join(directory, 'session-meta-backup.json'),
      `${JSON.stringify(
        plan.changes
          .filter((change) => change.rewriteNeeded)
          .map((change) => ({
            path: change.path,
            originalSessionMetaLines: change.originalSessionMetaLines
          })),
        null,
        2
      )}\n`,
      'utf8'
    )
    await writeFile(
      join(directory, 'metadata.json'),
      `${JSON.stringify(
        {
          version: 1,
          namespace: 'account-switcher-provider-sync',
          codexHome: this.options.codexHome,
          targetProvider: plan.preview.targetProvider,
          createdAt: this.now().toISOString(),
          changedSessionFiles: plan.preview.changedSessionFiles,
          databaseFiles: databaseFiles.map((entry) =>
            relative(this.options.codexHome, entry.source).replaceAll('\\', '/')
          ),
          managedBy: MANAGED_BY
        },
        null,
        2
      )}\n`,
      'utf8'
    )
    return { directory, databaseFiles }
  }

  private async rollback(plan: RepairPlan, backup: BackupState): Promise<void> {
    for (const change of plan.changes.filter((item) => item.rewriteNeeded)) {
      try {
        await replaceSessionMeta(change.path, change.originalSessionMetaLines[0])
        await utimes(change.path, change.originalAtime, change.originalMtime)
      } catch {
        // Continue restoring the remaining state.
      }
    }
    for (const path of plan.databasePaths) {
      for (const source of [path, `${path}-wal`, `${path}-shm`]) {
        await rm(source, { force: true })
      }
    }
    for (const entry of backup.databaseFiles) {
      try {
        await mkdir(dirname(entry.source), { recursive: true })
        await copyFile(entry.backup, entry.source)
      } catch {
        // Continue restoring the remaining state.
      }
    }
    try {
      if (plan.globalState.originalText === null) {
        await rm(plan.globalState.path, { force: true })
      } else {
        await writeFile(plan.globalState.path, plan.globalState.originalText, 'utf8')
      }
    } catch {
      // Database and rollout recovery should not be masked by this failure.
    }
  }

  private async pruneBackups(): Promise<void> {
    const root = join(this.options.codexHome, 'backups_state', 'account-switcher-provider-sync')
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const managed: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(root, entry.name)
      try {
        const metadata = JSON.parse(await readFile(join(path, 'metadata.json'), 'utf8')) as unknown
        if (record(metadata)?.managedBy === MANAGED_BY) managed.push(path)
      } catch {
        // Never prune directories that are not positively identified as ours.
      }
    }
    managed.sort((left, right) => basename(right).localeCompare(basename(left)))
    for (const path of managed.slice(this.backupRetention)) {
      await rm(path, { recursive: true, force: true })
    }
  }

  private failure(
    message: string,
    targetProvider: string,
    backupPath: string | null = null
  ): SessionRepairResult {
    return {
      ok: false,
      message,
      targetProvider,
      changedSessionFiles: 0,
      sqliteRowsUpdated: 0,
      globalStateKeysUpdated: 0,
      backupPath
    }
  }
}
