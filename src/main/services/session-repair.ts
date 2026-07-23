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
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionRepairPreview, SessionRepairResult } from '../../shared/types'

const DEFAULT_PROVIDER = 'openai'
const SESSION_DIRECTORIES = ['sessions', 'archived_sessions'] as const
const MANAGED_BY = 'Codex Account Switcher provider sync'
const REPAIR_LOCK_STALE_MS = 30 * 60 * 1000

type FaultStage = 'after-rollouts' | 'after-sqlite' | 'after-global-state'

interface SessionRepairOptions {
  codexHome: string
  backupRetention?: number
  now?: () => Date
  faultInjector?: (stage: FaultStage) => void
  onProgress?: (progress: { done: number; total: number; message: string }) => void
}

interface RolloutChange {
  path: string
  originalSessionMetaLines: string[]
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
  const err = error as NodeJS.ErrnoException & { message?: string }
  const code = err?.code
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY' || code === 'EAGAIN') return true
  const message = String(err?.message ?? error ?? '').toLowerCase()
  return (
    message.includes('resource busy') ||
    message.includes('locked') ||
    message.includes('sharing violation') ||
    message.includes('being used by another process') ||
    message.includes('sqlite_busy') ||
    message.includes('database is locked')
  )
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
    let provider = 0
    let providers: string[] = []
    if (columns.has('model_provider')) {
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
      providers = db
        .prepare(
          "SELECT DISTINCT COALESCE(model_provider, '') AS provider FROM threads WHERE COALESCE(model_provider, '') <> ''"
        )
        .all()
        .map((row) => String((row as Record<string, unknown>).provider ?? ''))
        .filter(Boolean)
    }
    let userEvent = 0
    const visibilityPredicates: string[] = []
    if (columns.has('has_user_event') && columns.has('first_user_message')) {
      visibilityPredicates.push("COALESCE(first_user_message, '') <> '' AND COALESCE(has_user_event, 0) <> 1")
    }
    if (columns.has('thread_source') && columns.has('first_user_message')) {
      visibilityPredicates.push("COALESCE(first_user_message, '') <> '' AND COALESCE(thread_source, '') = ''")
    }
    if (visibilityPredicates.length > 0) {
      const predicate = visibilityPredicates.map((item) => `(${item})`).join(' OR ')
      if (selectedThreadIds) {
        const query = db.prepare(`SELECT COUNT(*) AS count FROM threads WHERE id = ? AND (${predicate})`)
        for (const id of selectedThreadIds) {
          userEvent += sqliteNumber((query.get(id) as Record<string, unknown> | undefined)?.count)
        }
      } else {
        userEvent += sqliteNumber(
          (db.prepare(`SELECT COUNT(*) AS count FROM threads WHERE ${predicate}`).get() as Record<string, unknown> | undefined)?.count
        )
      }
    }
    if (columns.has('has_user_event')) {
      const withoutVisibleMessage = columns.has('first_user_message')
        ? " AND COALESCE(first_user_message, '') = ''"
        : ''
      const query = db.prepare(
        `SELECT COUNT(*) AS count FROM threads WHERE id = ? AND COALESCE(has_user_event, 0) <> 1${withoutVisibleMessage}`
      )
      for (const id of userEventThreadIds) {
        userEvent += sqliteNumber((query.get(id) as Record<string, unknown> | undefined)?.count)
      }
    }
    if (columns.has('thread_source')) {
      const withoutVisibleMessage = columns.has('first_user_message')
        ? " AND COALESCE(first_user_message, '') = ''"
        : ''
      const query = db.prepare(
        `SELECT COUNT(*) AS count FROM threads WHERE id = ? AND COALESCE(thread_source, '') = ''${withoutVisibleMessage}`
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
    db.exec('BEGIN IMMEDIATE')
    try {
      let provider = 0
      if (columns.has('model_provider')) {
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
      }
      let userEvent = 0
      const visibilityAssignments: string[] = []
      const visibilityPredicates: string[] = []
      if (columns.has('has_user_event') && columns.has('first_user_message')) {
        visibilityAssignments.push("has_user_event = CASE WHEN COALESCE(first_user_message, '') <> '' THEN 1 ELSE has_user_event END")
        visibilityPredicates.push("COALESCE(first_user_message, '') <> '' AND COALESCE(has_user_event, 0) <> 1")
      }
      if (columns.has('thread_source') && columns.has('first_user_message')) {
        visibilityAssignments.push("thread_source = CASE WHEN COALESCE(first_user_message, '') <> '' AND COALESCE(thread_source, '') = '' THEN 'user' ELSE thread_source END")
        visibilityPredicates.push("COALESCE(first_user_message, '') <> '' AND COALESCE(thread_source, '') = ''")
      }
      if (visibilityAssignments.length > 0) {
        const predicate = visibilityPredicates.map((item) => `(${item})`).join(' OR ')
        if (selectedThreadIds) {
          const update = db.prepare(
            `UPDATE threads SET ${visibilityAssignments.join(', ')} WHERE id = ? AND (${predicate})`
          )
          for (const id of selectedThreadIds) userEvent += Number(update.run(id).changes)
        } else {
          userEvent += Number(
            db.prepare(`UPDATE threads SET ${visibilityAssignments.join(', ')} WHERE ${predicate}`).run().changes
          )
        }
      }
      if (columns.has('has_user_event')) {
        const update = db.prepare(
          'UPDATE threads SET has_user_event = 1 WHERE id = ? AND COALESCE(has_user_event, 0) <> 1'
        )
        for (const id of userEventThreadIds) userEvent += Number(update.run(id).changes)
      }
      if (columns.has('thread_source')) {
        const update = db.prepare(
          "UPDATE threads SET thread_source = 'user' WHERE id = ? AND COALESCE(thread_source, '') = ''"
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
  const originalSessionMetaLines: string[] = []
  const rewriteAllSessionMeta = Boolean(selectedThreadIds)
  const providers: string[] = []
  let rewriteNeeded = false
  let threadId: string | null = null
  let cwd: string | null = null
  let hasUserEvent = false
  let hasEncryptedContent = false
  let searchTail = ''

  const change = (contentHash: string): RolloutChange => ({
    path,
    originalSessionMetaLines,
    contentHash,
    originalAtime: metadata.atime,
    originalMtime: metadata.mtime,
    rewriteNeeded,
    threadId,
    cwd,
    hasUserEvent,
    providers,
    hasEncryptedContent
  })

  const inspectLine = (line: string): void => {
    if (!rewriteAllSessionMeta && originalSessionMetaLines.length > 0) return
    if (!line.trim()) return
    const parsed = sessionMeta(line)
    if (!parsed) return
    originalSessionMetaLines.push(line)
    const { payload } = parsed
    if (!threadId && typeof payload.id === 'string') threadId = payload.id
    if (!cwd && typeof payload.cwd === 'string') cwd = normalizeWorkspacePath(payload.cwd)
    const provider = typeof payload.model_provider === 'string' ? payload.model_provider : '(missing)'
    providers.push(provider)
    if (provider !== targetProvider) rewriteNeeded = true
  }

  for await (const rawChunk of createReadStream(path)) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    hash.update(chunk)
    const searchable = searchTail + chunk.toString('utf8')
    hasUserEvent ||= searchable.includes('"user_message"') || searchable.includes('"user_input"')
    hasEncryptedContent ||= searchable.includes('encrypted_content')
    searchTail = searchable.slice(-64)

    pending = Buffer.concat([pending, chunk])
    let newline = pending.indexOf(0x0a)
    while (newline >= 0) {
      const segment = pending.subarray(0, newline + 1).toString('utf8')
      pending = pending.subarray(newline + 1)
      inspectLine(splitLineEnding(segment)[0])
      if (!rewriteAllSessionMeta && originalSessionMetaLines.length > 0) {
        const fingerprint = createHash('sha256')
          .update(path)
          .update(String(metadata.size))
          .update(String(metadata.mtimeMs))
          .update(originalSessionMetaLines[0])
          .digest('hex')
        return change(fingerprint)
      }
      newline = pending.indexOf(0x0a)
    }
    if (pending.byteLength > 16 * 1024 * 1024) {
      throw new Error('会话元数据行超过安全限制')
    }
  }
  if (pending.byteLength > 0) inspectLine(pending.toString('utf8'))
  if (originalSessionMetaLines.length === 0) return null
  if (selectedThreadIds && (!threadId || !selectedThreadIds.has(threadId))) return null
  return change(hash.digest('hex'))
}

async function writeChunk(stream: ReturnType<typeof createWriteStream>, chunk: Buffer): Promise<void> {
  if (stream.write(chunk)) return
  await once(stream, 'drain')
}

async function replaceSessionMeta(
  path: string,
  targetProvider: string,
  rewriteAllSessionMeta: boolean
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const previous = `${path}.${randomUUID()}.previous`
  const output = createWriteStream(temporary)
  const outputFinished = finished(output)
  let pending = Buffer.alloc(0)
  let rewritten = false
  const writeLine = async (segment: Buffer, includeEnding = true): Promise<void> => {
    if (!rewriteAllSessionMeta && rewritten) {
      await writeChunk(output, segment)
      return
    }
    const text = segment.toString('utf8')
    const [line, ending] = includeEnding ? splitLineEnding(text) : [text, '']
    const parsed = sessionMeta(line)
    if (!parsed) {
      await writeChunk(output, segment)
      return
    }
    const currentProvider = typeof parsed.payload.model_provider === 'string'
      ? parsed.payload.model_provider
      : '(missing)'
    if (currentProvider === targetProvider) {
      await writeChunk(output, segment)
      return
    }
    parsed.payload.model_provider = targetProvider
    await writeChunk(output, Buffer.from(JSON.stringify(parsed.root) + ending, 'utf8'))
    rewritten = true
  }
  try {
    for await (const rawChunk of createReadStream(path)) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
      pending = Buffer.concat([pending, chunk])
      let newline = pending.indexOf(0x0a)
      while (newline >= 0) {
        const segment = pending.subarray(0, newline + 1)
        pending = pending.subarray(newline + 1)
        await writeLine(segment)
        newline = pending.indexOf(0x0a)
      }
    }
    if (pending.byteLength > 0) await writeLine(pending, false)
    if (!rewritten) throw new Error('会话元数据已发生变化')
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

async function acquireRepairLock(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(path)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let ageMs = 0
      try {
        ageMs = Date.now() - (await stat(path)).mtimeMs
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw statError
      }
      if (ageMs < REPAIR_LOCK_STALE_MS) return false
      await rm(path, { recursive: true, force: true })
    }
  }
  return false
}

async function restoreSessionMeta(path: string, originalLines: readonly string[]): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  const previous = `${path}.${randomUUID()}.previous`
  const output = createWriteStream(temporary)
  const outputFinished = finished(output)
  let pending = Buffer.alloc(0)
  let restored = 0
  const rewriteAllSessionMeta = originalLines.length > 1
  const writeLine = async (segment: Buffer, includeEnding = true): Promise<void> => {
    if (!rewriteAllSessionMeta && restored > 0) {
      await writeChunk(output, segment)
      return
    }
    const text = segment.toString('utf8')
    const [line, ending] = includeEnding ? splitLineEnding(text) : [text, '']
    if (!sessionMeta(line)) {
      await writeChunk(output, segment)
      return
    }
    const original = originalLines[restored]
    if (original === undefined) throw new Error('会话元数据已发生变化')
    restored += 1
    await writeChunk(output, Buffer.from(original + ending, 'utf8'))
  }
  try {
    for await (const rawChunk of createReadStream(path)) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
      pending = Buffer.concat([pending, chunk])
      let newline = pending.indexOf(0x0a)
      while (newline >= 0) {
        const segment = pending.subarray(0, newline + 1)
        pending = pending.subarray(newline + 1)
        await writeLine(segment)
        newline = pending.indexOf(0x0a)
      }
    }
    if (pending.byteLength > 0) await writeLine(pending, false)
    if (restored !== originalLines.length) throw new Error('会话元数据已发生变化')
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
  for (const path of [join(home, 'sqlite', 'state_5.sqlite'), join(home, 'state_5.sqlite')]) {
    try {
      if ((await stat(path)).isFile()) result.push(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return [...new Set(result)].sort()
}

function isUnusableSqliteError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error ?? '').toLowerCase()
  return (
    message.includes('file is not a database') ||
    message.includes('database disk image is malformed') ||
    message.includes('malformed database schema') ||
    message.includes('no such table: threads')
  )
}

async function repairRolloutPaths(
  home: string,
  databasePaths: readonly string[],
  selectedThreadIds: ReadonlySet<string> | null
): Promise<string[]> {
  const referenced = new Set<string>()
  let foundRolloutIndex = false
  for (const databasePath of databasePaths) {
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(databasePath, { readOnly: true })
      const columns = tableColumns(db, 'threads')
      if (!columns.has('id') || !columns.has('rollout_path')) continue
      foundRolloutIndex = true
      const rows = db
        .prepare("SELECT id, rollout_path FROM threads WHERE rollout_path IS NOT NULL AND rollout_path <> ''")
        .all()
      for (const row of rows) {
        const item = row as Record<string, unknown>
        const id = String(item.id ?? '')
        if (selectedThreadIds && !selectedThreadIds.has(id)) continue
        const raw = String(item.rollout_path ?? '').trim()
        if (!raw) continue
        const path = isAbsolute(raw) ? resolve(raw) : resolve(home, raw)
        const fromHome = relative(resolve(home), path)
        if (fromHome === '' || fromHome.startsWith('..') || isAbsolute(fromHome)) continue
        referenced.add(path)
      }
    } catch (error) {
      if (!isUnusableSqliteError(error) && !isLockedError(error)) throw error
    } finally {
      db?.close()
    }
  }
  if (foundRolloutIndex) return [...referenced].sort()
  return (
    await Promise.all(
      SESSION_DIRECTORIES.map((directory) => collectRolloutPaths(join(home, directory)))
    )
  ).flat()
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
  for (const change of changes) {
    hash.update(change.path)
    hash.update(change.contentHash)
    hash.update(String(change.rewriteNeeded))
  }
  for (const path of databasePaths) {
    hash.update(path)
  }
  hash.update(globalPath)
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
    this.reportProgress(1, 6, '正在分析历史对话和 SQLite 状态')
    const lockPath = join(this.options.codexHome, 'tmp', 'account-switcher-provider-sync.lock')
    try {
      await mkdir(dirname(lockPath), { recursive: true })
      if (!await acquireRepairLock(lockPath)) {
        return this.failure('已有历史会话修复任务正在运行', explicitTarget)
      }
    } catch (error) {
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
        this.reportProgress(6, 6, '历史会话已与当前供应商一致')
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
      this.reportProgress(2, 6, '已完成分析，正在创建可回滚备份')
      backup = await this.createBackup(plan)
      this.reportProgress(3, 6, `备份完成，正在修复 ${plan.preview.changedSessionFiles} 个会话文件`)
      const repairPlan = plan
      const rewriteTargets = repairPlan.changes.filter((item) => item.rewriteNeeded)
      const rewriteResults = await mapConcurrent(
        rewriteTargets,
        2,
        async (change): Promise<'ok' | 'locked'> => {
          try {
            await replaceSessionMeta(change.path, explicitTarget, Boolean(repairPlan.selectedThreadIds))
            await utimes(change.path, change.originalAtime, change.originalMtime)
            return 'ok'
          } catch (error) {
            if (isLockedError(error)) return 'locked'
            throw error
          }
        }
      )
      const applyLocked = rewriteTargets
        .filter((_, index) => rewriteResults[index] === 'locked')
        .map((change) => change.path)
      const rewrittenFiles = rewriteResults.filter((status) => status === 'ok').length
      this.options.faultInjector?.('after-rollouts')
      this.reportProgress(4, 6, '会话文件已处理，正在同步 SQLite 状态')

      const updated: SqliteCounts = { provider: 0, userEvent: 0, cwd: 0 }
      const skippedDatabasePaths: string[] = []
      for (const path of plan.databasePaths) {
        try {
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
        } catch (error) {
          if (isLockedError(error) || isUnusableSqliteError(error)) {
            skippedDatabasePaths.push(path)
            continue
          }
          throw error
        }
      }
      this.options.faultInjector?.('after-sqlite')
      this.reportProgress(5, 6, 'SQLite 状态已处理，正在同步全局状态并复检')

      let globalStateUpdated = 0
      if (plan.globalState.changedKeys > 0 && plan.globalState.nextText !== null) {
        try {
          if (plan.globalState.originalText === null) {
            await mkdir(dirname(plan.globalState.path), { recursive: true })
            await writeFile(plan.globalState.path, plan.globalState.nextText, 'utf8')
          } else {
            await atomicReplace(plan.globalState.path, plan.globalState.nextText)
          }
          await writeFile(`${plan.globalState.path}.bak`, plan.globalState.nextText, 'utf8')
          globalStateUpdated = plan.globalState.changedKeys
        } catch (error) {
          if (!isLockedError(error)) throw error
        }
      }
      this.options.faultInjector?.('after-global-state')
      const verification = await this.buildPlan(explicitTarget, threadIds)
      const lockedSet = new Set([
        ...plan.preview.skippedLockedFiles,
        ...applyLocked,
        ...verification.preview.skippedLockedFiles
      ])
      const remainingUnlocked = verification.changes.filter(
        (change) => change.rewriteNeeded && !lockedSet.has(change.path)
      )
      const remainingSqliteRows =
        verification.preview.sqliteProviderRows +
        verification.preview.sqliteUserEventRows +
        verification.preview.sqliteCwdRows
      if (remainingUnlocked.length > 0 || (remainingSqliteRows > 0 && skippedDatabasePaths.length === 0)) {
        throw new Error(
          `修复后复检未通过：仍有 ${remainingUnlocked.length} 个可写会话文件和 ${remainingSqliteRows} 条 SQLite 状态待修复`
        )
      }
      await this.pruneBackups()
      this.reportProgress(6, 6, '修复完成，复检通过')
      const skipped = lockedSet.size
      const partial =
        skipped > 0 ||
        skippedDatabasePaths.length > 0 ||
        rewrittenFiles < plan.preview.changedSessionFiles ||
        (plan.globalState.changedKeys > 0 && globalStateUpdated === 0)
      const message = partial
        ? `历史会话部分修复完成：文件 ${rewrittenFiles}/${plan.preview.changedSessionFiles}，状态 ${updated.provider + updated.userEvent + updated.cwd}，全局配置 ${globalStateUpdated}${skipped > 0 ? `；${skipped} 个被 Codex 占用的当前会话文件已跳过` : ''}${skippedDatabasePaths.length > 0 ? `；${skippedDatabasePaths.length} 个 SQLite 状态库不可用或被占用` : ''}`
        : `历史会话修复完成并复检通过：文件 ${rewrittenFiles}，状态 ${updated.provider + updated.userEvent + updated.cwd}，全局配置 ${globalStateUpdated}`
      return {
        ok: true,
        message,
        targetProvider: explicitTarget,
        changedSessionFiles: rewrittenFiles,
        sqliteRowsUpdated: updated.provider + updated.userEvent + updated.cwd,
        globalStateKeysUpdated: globalStateUpdated,
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
    const selectedThreadIds = threadIds && threadIds.length > 0
      ? new Set(threadIds.filter((id) => Boolean(id.trim())))
      : null
    const databasePaths = await existingDatabasePaths(this.options.codexHome)
    const rolloutPaths = await repairRolloutPaths(
      this.options.codexHome,
      databasePaths,
      selectedThreadIds
    )
    const inspections = await mapConcurrent<string, RolloutInspection>(rolloutPaths, 4, async (path) => {
      try {
        return {
          change: await rolloutChange(path, targetProvider, selectedThreadIds),
          lockedPath: null
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { change: null, lockedPath: null }
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
    const sqliteCounts: SqliteCounts = { provider: 0, userEvent: 0, cwd: 0 }
    const providers = new Set<string>([DEFAULT_PROVIDER, configuredProvider])
    for (const change of changes) {
      for (const provider of change.providers) {
        if (validProvider(provider)) providers.add(provider)
      }
    }
    for (const path of databasePaths) {
      let inspected: ReturnType<typeof inspectDatabase>
      try {
        inspected = inspectDatabase(
          path,
          targetProvider,
          userEventThreadIds,
          cwdByThreadId,
          selectedThreadIds
        )
      } catch (error) {
        if (isUnusableSqliteError(error) || isLockedError(error)) continue
        throw error
      }
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
      scannedSessionFiles: rolloutPaths.length,
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
        await restoreSessionMeta(change.path, change.originalSessionMetaLines)
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

  private reportProgress(done: number, total: number, message: string): void {
    this.options.onProgress?.({ done, total, message })
  }
}
