import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ConversationCleanupPreview,
  ConversationDetail,
  ConversationFacets,
  ConversationKind,
  ConversationLifecycleStatus,
  ConversationListQuery,
  ConversationListResult,
  ConversationMessage,
  ConversationSubagentKind,
  ConversationSummary,
  DeleteConversationsResult
} from '../../shared/types'
import { atomicWriteFile } from '../storage/atomic-file'
import { DirectoryRecordIndex } from '../storage/directory-record-index'

const SESSION_DIRECTORIES = ['sessions', 'archived_sessions'] as const
const MAX_MESSAGE_CHARS = 12_000
const MAX_DETAIL_CHARS = 600_000
const MAX_DETAIL_MESSAGES = 400
const MAX_JSONL_LINE_BYTES = 1024 * 1024
const MAX_SUMMARY_SCAN_BYTES = 4 * 1024 * 1024
const MAX_DETAIL_SCAN_BYTES = 32 * 1024 * 1024
const MAX_CONTENT_SEARCH_SCAN_BYTES = 12 * 1024 * 1024
const DATABASE_FILE_PATTERN = /^(?:state|logs|goals|memories|thread_history)_\d+\.sqlite$/i
const DELETE_CONCURRENCY = 4
const CONTENT_SEARCH_CONCURRENCY = 2
const SAFE_CLEANUP_GRACE_MINUTES = 60
const SAFE_CLEANUP_GRACE_MS = SAFE_CLEANUP_GRACE_MINUTES * 60 * 1000

interface ConversationSourceMetadata {
  kind: ConversationKind
  subagentKind: ConversationSubagentKind
  parentId: string | null
  depth: number | null
  agentNickname: string | null
  agentRole: string | null
}

interface ConversationGraphEdge {
  parentId: string
  status: ConversationLifecycleStatus
}

interface ConversationGraphSnapshot {
  signature: string
  edges: Map<string, ConversationGraphEdge>
  openParentIds: Set<string>
  parentIds: Set<string>
}

interface JsonlScanResult {
  limitReached: boolean
  skippedOversizedLines: number
}

async function scanJsonl(
  path: string,
  fileSize: number,
  maxBytes: number,
  visit: (line: string) => boolean | void
): Promise<JsonlScanResult> {
  let pending = Buffer.alloc(0)
  let skippingOversizedLine = false
  let skippedOversizedLines = 0
  let bytesRead = 0
  let stopped = false

  const consume = (chunk: Buffer): boolean => {
    let data = pending.byteLength > 0 ? Buffer.concat([pending, chunk]) : chunk
    pending = Buffer.alloc(0)
    while (data.byteLength > 0) {
      if (skippingOversizedLine) {
        const newline = data.indexOf(0x0a)
        if (newline < 0) return true
        skippingOversizedLine = false
        data = data.subarray(newline + 1)
        continue
      }

      const newline = data.indexOf(0x0a)
      if (newline < 0) {
        if (data.byteLength > MAX_JSONL_LINE_BYTES) {
          skippingOversizedLine = true
          skippedOversizedLines += 1
        } else {
          pending = Buffer.from(data)
        }
        return true
      }

      let line = data.subarray(0, newline)
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1)
      if (line.byteLength <= MAX_JSONL_LINE_BYTES && visit(line.toString('utf8')) === false) {
        return false
      }
      if (line.byteLength > MAX_JSONL_LINE_BYTES) skippedOversizedLines += 1
      data = data.subarray(newline + 1)
    }
    return true
  }

  for await (const rawChunk of createReadStream(path)) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    const available = Math.min(chunk.byteLength, maxBytes - bytesRead)
    if (available <= 0) break
    bytesRead += available
    if (!consume(chunk.subarray(0, available))) {
      stopped = true
      break
    }
    if (available < chunk.byteLength || bytesRead >= maxBytes) break
  }

  if (!stopped && !skippingOversizedLine && pending.byteLength > 0) {
    visit(pending.toString('utf8'))
  }
  return {
    limitReached: !stopped && bytesRead < fileSize,
    skippedOversizedLines
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeSubagentKind(value: string): Exclude<ConversationSubagentKind, null> {
  const normalized = value.trim().toLowerCase().replaceAll('-', '_')
  if (normalized === 'thread_spawn' || normalized === 'threadspawn') return 'thread_spawn'
  if (normalized === 'review') return 'review'
  if (normalized === 'compact') return 'compact'
  if (normalized === 'memory_consolidation') return 'memory_consolidation'
  return 'other'
}

function sourceMetadata(payload: Record<string, unknown>): ConversationSourceMetadata {
  const result: ConversationSourceMetadata = {
    kind: 'unknown',
    subagentKind: null,
    parentId: nonEmptyString(payload.parent_thread_id),
    depth: null,
    agentNickname: nonEmptyString(payload.agent_nickname),
    agentRole: nonEmptyString(payload.agent_role) ?? nonEmptyString(payload.agent_type)
  }
  const source = payload.source
  if (typeof source === 'string') {
    const normalized = source.trim().toLowerCase()
    if (['cli', 'vscode', 'exec', 'mcp', 'appserver', 'app-server'].includes(normalized)) {
      result.kind = 'main'
    } else if (normalized.startsWith('internal')) {
      result.kind = 'internal'
    } else if (normalized.startsWith('subagent')) {
      result.kind = 'subagent'
      result.subagentKind = normalizeSubagentKind(normalized.replace(/^subagent[_:-]?/, ''))
    } else if (normalized) {
      result.kind = 'main'
    }
    return result
  }

  const sourceObject = record(source)
  if (!sourceObject) {
    const threadSource = nonEmptyString(payload.thread_source)?.toLowerCase()
    if (threadSource === 'user') result.kind = 'main'
    else if (threadSource === 'subagent') result.kind = 'subagent'
    else if (threadSource === 'memory_consolidation') result.kind = 'internal'
    else if (result.parentId) {
      result.kind = 'subagent'
      result.subagentKind = 'thread_spawn'
    } else {
      result.kind = 'main'
    }
    return result
  }

  if ('internal' in sourceObject) {
    result.kind = 'internal'
    return result
  }
  if (!('subagent' in sourceObject)) return result

  result.kind = 'subagent'
  const subagent = sourceObject.subagent
  if (typeof subagent === 'string') {
    result.subagentKind = normalizeSubagentKind(subagent)
    return result
  }
  const subagentObject = record(subagent)
  if (!subagentObject) {
    result.subagentKind = 'other'
    return result
  }
  const rawKind = Object.keys(subagentObject)[0] ?? 'other'
  result.subagentKind = normalizeSubagentKind(rawKind)
  if (result.subagentKind !== 'thread_spawn') return result

  const spawn = record(subagentObject[rawKind])
  if (!spawn) return result
  result.parentId = nonEmptyString(spawn.parent_thread_id) ?? result.parentId
  result.depth = finiteNumber(spawn.depth)
  result.agentNickname = nonEmptyString(spawn.agent_nickname) ?? result.agentNickname
  result.agentRole = nonEmptyString(spawn.agent_role) ?? nonEmptyString(spawn.agent_type) ?? result.agentRole
  return result
}

function textValue(value: unknown, depth = 0): string {
  if (depth > 3) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((item) => textValue(item, depth + 1)).filter(Boolean).join('\n')
  }
  const source = record(value)
  if (!source) return ''
  for (const key of ['text', 'message', 'content', 'input_text', 'output_text']) {
    const text = textValue(source[key], depth + 1)
    if (text) return text
  }
  return ''
}

function cleanText(value: string, limit = MAX_MESSAGE_CHARS): string {
  const cleaned = value.replace(/\u0000/g, '').trim()
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned
}

function messageFromLine(line: string): Omit<ConversationMessage, 'id'> | null {
  if (!line.includes('user_message') && !line.includes('agent_message') && !line.includes('"type":"message"')) {
    return null
  }
  try {
    const root = record(JSON.parse(line))
    const payload = record(root?.payload)
    if (!root || !payload) return null
    const timestamp = typeof root.timestamp === 'string' ? root.timestamp : null
    if (root.type === 'event_msg' && payload.type === 'user_message') {
      const text = cleanText(textValue(payload.message) || textValue(payload.text_elements))
      return text ? { role: 'user', text, timestamp } : null
    }
    if (root.type === 'event_msg' && payload.type === 'agent_message') {
      const text = cleanText(textValue(payload.message))
      return text ? { role: 'assistant', text, timestamp } : null
    }
    if (root.type === 'response_item' && payload.type === 'message') {
      const role = payload.role === 'user' ? 'user' : payload.role === 'assistant' ? 'assistant' : null
      const text = cleanText(textValue(payload.content))
      return role && text ? { role, text, timestamp } : null
    }
  } catch {
    // Malformed or partially written lines are skipped.
  }
  return null
}

async function collectConversationPaths(codexHome: string): Promise<string[]> {
  const paths: string[] = []
  const visit = async (directory: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && /^rollout-.*\.jsonl$/i.test(entry.name)) paths.push(path)
    }
  }
  await Promise.all(SESSION_DIRECTORIES.map((directory) => visit(join(codexHome, directory))))
  return paths.sort()
}

async function conversationSummary(codexHome: string, path: string): Promise<ConversationSummary[]> {
  const metadata = await stat(path)
  let id = basename(path, '.jsonl').replace(/^rollout-/i, '')
  let title = ''
  let cwd: string | null = null
  let provider = 'unknown'
  let createdAt: string | null = null
  let source: ConversationSourceMetadata = {
    kind: 'unknown',
    subagentKind: null,
    parentId: null,
    depth: null,
    agentNickname: null,
    agentRole: null
  }
  let metadataFound = false
  await scanJsonl(path, metadata.size, MAX_SUMMARY_SCAN_BYTES, (line) => {
    if (!metadataFound) {
      try {
        const root = record(JSON.parse(line))
        const payload = record(root?.payload)
        if (root?.type === 'session_meta' && payload) {
          metadataFound = true
          if (typeof payload.id === 'string' && payload.id.trim()) id = payload.id
          if (typeof payload.cwd === 'string' && payload.cwd.trim()) cwd = payload.cwd
          if (typeof payload.model_provider === 'string' && payload.model_provider.trim()) {
            provider = payload.model_provider
          }
          source = sourceMetadata(payload)
          if (typeof root.timestamp === 'string') createdAt = root.timestamp
        }
      } catch {
        // Continue until a valid metadata line or first user message is found.
      }
    }
    const message = messageFromLine(line)
    if (message?.role === 'user') title = cleanText(message.text.replace(/\s+/g, ' '), 120)
    return !(title && metadataFound)
  })
  return [{
    id,
    title: title || '未命名对话',
    cwd,
    provider,
    createdAt: createdAt ?? (metadata.birthtimeMs > 0 ? metadata.birthtime : metadata.mtime).toISOString(),
    updatedAt: metadata.mtime.toISOString(),
    archived: relative(codexHome, path).split(/[\\/]/)[0].toLowerCase() === 'archived_sessions',
    sourcePath: path,
    sizeBytes: metadata.size,
    kind: source.kind,
    subagentKind: source.subagentKind,
    parentId: source.parentId,
    parentTitle: null,
    childCount: 0,
    depth: source.depth,
    agentNickname: source.agentNickname,
    agentRole: source.agentRole,
    lifecycleStatus: 'unknown',
    safeToClean: false,
    matchExcerpt: null
  }]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function isInside(root: string, path: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(path))
  return pathFromRoot === '' || (
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  )
}

function managedConversationPath(codexHome: string, path: string): string {
  const normalized = resolve(path)
  const insideManagedDirectory = SESSION_DIRECTORIES.some((directory) =>
    isInside(join(codexHome, directory), normalized)
  )
  if (!insideManagedDirectory || !/^rollout-.*\.jsonl(?:\.zst)?$/i.test(basename(normalized))) {
    throw new Error('对话文件不在 Codex 会话目录内')
  }
  return normalized
}

async function pathExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (isMissingError(error)) return false
    throw error
  }
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

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${quotedIdentifier(table)})`)
      .all()
      .map((row) => String((row as Record<string, unknown>).name ?? ''))
  )
}

function chunks<T>(values: readonly T[], size = 200): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size))
  }
  return result
}

function runForIds(
  db: DatabaseSync,
  sql: (placeholders: string) => string,
  ids: readonly string[],
  leadingParameters: readonly (string | number)[] = []
): number {
  let changed = 0
  for (const batch of chunks(ids)) {
    const placeholders = batch.map(() => '?').join(', ')
    changed += Number(db.prepare(sql(placeholders)).run(...leadingParameters, ...batch).changes)
  }
  return changed
}

function cleanDatabase(path: string, ids: readonly string[]): number {
  const db = new DatabaseSync(path)
  let transactionOpen = false
  try {
    db.exec('PRAGMA busy_timeout = 3000')
    db.exec('PRAGMA foreign_keys = ON')
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String((row as Record<string, unknown>).name ?? ''))
      .filter(Boolean)
      .map((table) => ({ table, columns: tableColumns(db, table) }))

    db.exec('BEGIN IMMEDIATE')
    transactionOpen = true
    let changed = 0

    for (const { table, columns } of tables) {
      if (!columns.has('assigned_thread_id')) continue
      const name = quotedIdentifier(table)
      if (columns.has('status')) {
        const assignments = ["status = 'pending'"]
        const parameters: (string | number)[] = []
        if (columns.has('updated_at')) {
          assignments.push('updated_at = ?')
          parameters.push(Math.floor(Date.now() / 1000))
        }
        if (columns.has('last_error')) {
          assignments.push('last_error = ?')
          parameters.push('assigned thread was deleted')
        }
        runForIds(
          db,
          (placeholders) => `UPDATE ${name} SET ${assignments.join(', ')} WHERE status = 'running' AND assigned_thread_id IN (${placeholders})`,
          ids,
          parameters
        )
      }
      changed += runForIds(
        db,
        (placeholders) => `UPDATE ${name} SET assigned_thread_id = NULL WHERE assigned_thread_id IN (${placeholders})`,
        ids
      )
    }

    for (const { table, columns } of tables) {
      if (!columns.has('thread_id')) continue
      const name = quotedIdentifier(table)
      changed += runForIds(
        db,
        (placeholders) => `DELETE FROM ${name} WHERE thread_id IN (${placeholders})`,
        ids
      )
    }

    for (const { table, columns } of tables) {
      const clauses: string[] = []
      if (columns.has('parent_thread_id')) clauses.push('parent_thread_id')
      if (columns.has('child_thread_id')) clauses.push('child_thread_id')
      if (clauses.length === 0) continue
      const name = quotedIdentifier(table)
      for (const batch of chunks(ids)) {
        const placeholders = batch.map(() => '?').join(', ')
        const where = clauses.map((column) => `${column} IN (${placeholders})`).join(' OR ')
        const parameters = clauses.flatMap(() => batch)
        changed += Number(db.prepare(`DELETE FROM ${name} WHERE ${where}`).run(...parameters).changes)
      }
    }

    for (const { table, columns } of tables) {
      if (table.toLowerCase() !== 'threads' || !columns.has('id')) continue
      const name = quotedIdentifier(table)
      changed += runForIds(
        db,
        (placeholders) => `DELETE FROM ${name} WHERE id IN (${placeholders})`,
        ids
      )
    }

    db.exec('COMMIT')
    transactionOpen = false
    return changed
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the original database error.
      }
    }
    throw error
  } finally {
    db.close()
  }
}

async function databasePaths(codexHome: string): Promise<string[]> {
  const paths: string[] = []
  try {
    for (const entry of await readdir(codexHome, { withFileTypes: true })) {
      if (entry.isFile() && DATABASE_FILE_PATTERN.test(entry.name)) paths.push(join(codexHome, entry.name))
    }
  } catch (error) {
    if (!isMissingError(error)) throw error
  }

  const sqliteDirectory = join(codexHome, 'sqlite')
  try {
    for (const entry of await readdir(sqliteDirectory, { withFileTypes: true })) {
      if (entry.isFile() && ['.db', '.sqlite'].includes(extname(entry.name).toLowerCase())) {
        paths.push(join(sqliteDirectory, entry.name))
      }
    }
  } catch (error) {
    if (!isMissingError(error)) throw error
  }
  return [...new Map(paths.map((path) => [resolve(path).toLowerCase(), resolve(path)])).values()].sort()
}

async function graphDatabase(codexHome: string): Promise<{ path: string; signature: string } | null> {
  let candidates: string[] = []
  try {
    candidates = (await readdir(codexHome, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/i.test(entry.name))
      .map((entry) => join(codexHome, entry.name))
      .sort((left, right) => {
        const leftVersion = Number(basename(left).match(/\d+/)?.[0] ?? 0)
        const rightVersion = Number(basename(right).match(/\d+/)?.[0] ?? 0)
        return rightVersion - leftVersion
      })
  } catch (error) {
    if (!isMissingError(error)) throw error
  }
  for (const path of candidates) {
    try {
      const metadata = await stat(path)
      let walSignature = ''
      try {
        const wal = await stat(`${path}-wal`)
        walSignature = `:${wal.size}:${wal.mtimeMs}`
      } catch (error) {
        if (!isMissingError(error)) throw error
      }
      return { path, signature: `${resolve(path).toLowerCase()}:${metadata.size}:${metadata.mtimeMs}${walSignature}` }
    } catch (error) {
      if (!isMissingError(error)) throw error
    }
  }
  return null
}

function readConversationGraph(path: string, signature: string): ConversationGraphSnapshot {
  const edges = new Map<string, ConversationGraphEdge>()
  const openParentIds = new Set<string>()
  const parentIds = new Set<string>()
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout = 1500')
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thread_spawn_edges'"
    ).get()
    if (!table) return { signature, edges, openParentIds, parentIds }
    const columns = tableColumns(db, 'thread_spawn_edges')
    if (!columns.has('parent_thread_id') || !columns.has('child_thread_id')) {
      return { signature, edges, openParentIds, parentIds }
    }
    const hasStatus = columns.has('status')
    const rows = db.prepare(
      `SELECT parent_thread_id, child_thread_id${hasStatus ? ', status' : ''} FROM thread_spawn_edges`
    ).all()
    for (const row of rows) {
      const source = row as Record<string, unknown>
      const childId = nonEmptyString(source.child_thread_id)
      const parentId = nonEmptyString(source.parent_thread_id)
      if (!childId || !parentId) continue
      const rawStatus = nonEmptyString(source.status)?.toLowerCase()
      const status: ConversationLifecycleStatus = rawStatus === 'open'
        ? 'open'
        : rawStatus === 'closed'
          ? 'closed'
          : 'unknown'
      edges.set(childId, { parentId, status })
      parentIds.add(parentId)
      if (status === 'open') openParentIds.add(parentId)
    }
    return { signature, edges, openParentIds, parentIds }
  } finally {
    db.close()
  }
}

function conversationKindLabel(value: ConversationKind): string {
  if (value === 'main') return '主对话'
  if (value === 'subagent') return '子代理'
  if (value === 'internal') return '内部任务'
  return '未知来源'
}

function subagentKindLabel(value: Exclude<ConversationSubagentKind, null>): string {
  if (value === 'thread_spawn') return '派生代理'
  if (value === 'review') return '代码审查'
  if (value === 'compact') return '上下文压缩'
  if (value === 'memory_consolidation') return '记忆整理'
  return '其他代理'
}

function lifecycleLabel(value: ConversationLifecycleStatus): string {
  if (value === 'open') return '可恢复'
  if (value === 'closed') return '已关闭'
  return '状态未知'
}

function facet(
  values: Iterable<string>,
  label: (value: string) => string = (value) => value
): { value: string; label: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts]
    .map(([value, count]) => ({ value, label: label(value), count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'zh-CN'))
}

function conversationFacets(conversations: readonly ConversationSummary[]): ConversationFacets {
  return {
    kinds: facet(conversations.map((item) => item.kind), (value) => conversationKindLabel(value as ConversationKind)),
    subagentKinds: facet(
      conversations.flatMap((item) => item.subagentKind ? [item.subagentKind] : []),
      (value) => subagentKindLabel(value as Exclude<ConversationSubagentKind, null>)
    ),
    lifecycleStatuses: facet(
      conversations.filter((item) => item.kind === 'subagent').map((item) => item.lifecycleStatus),
      (value) => lifecycleLabel(value as ConversationLifecycleStatus)
    ),
    archives: facet(conversations.map((item) => item.archived ? 'archived' : 'active'), (value) =>
      value === 'archived' ? '已归档' : '当前会话'
    ),
    providers: facet(conversations.map((item) => item.provider)),
    workspaces: facet(conversations.map((item) => item.cwd ?? ''))
      .filter((item) => item.value)
      .slice(0, 100)
  }
}

function safeCleanupClassification(
  conversation: ConversationSummary,
  graph: ConversationGraphSnapshot,
  now = Date.now()
): 'eligible' | 'open' | 'recent' | 'unknown' {
  if (conversation.kind !== 'subagent' || conversation.subagentKind !== 'thread_spawn') return 'unknown'
  if (!conversation.parentId || conversation.lifecycleStatus === 'unknown') return 'unknown'
  if (conversation.lifecycleStatus === 'open' || graph.openParentIds.has(conversation.id)) return 'open'
  if (graph.parentIds.has(conversation.id)) return 'unknown'
  const updatedAt = new Date(conversation.updatedAt).getTime()
  if (!Number.isFinite(updatedAt)) return 'unknown'
  if (now - updatedAt < SAFE_CLEANUP_GRACE_MS) return 'recent'
  return 'eligible'
}

function safeCleanupPreview(
  conversations: readonly ConversationSummary[],
  graph: ConversationGraphSnapshot
): ConversationCleanupPreview {
  const candidates = new Map<string, ConversationSummary[]>()
  const closedSubagentIds = new Set<string>()
  const skippedOpenIds = new Set<string>()
  const skippedRecentIds = new Set<string>()
  const skippedUnknownIds = new Set<string>()
  for (const conversation of conversations) {
    if (conversation.kind === 'subagent' && conversation.lifecycleStatus === 'closed') {
      closedSubagentIds.add(conversation.id)
    }
    const classification = safeCleanupClassification(conversation, graph)
    if (classification === 'eligible') {
      const records = candidates.get(conversation.id) ?? []
      records.push(conversation)
      candidates.set(conversation.id, records)
    } else if (classification === 'open') skippedOpenIds.add(conversation.id)
    else if (classification === 'recent') skippedRecentIds.add(conversation.id)
    else if (conversation.kind === 'subagent') skippedUnknownIds.add(conversation.id)
  }
  for (const id of [...candidates.keys()]) {
    if (skippedOpenIds.has(id) || skippedRecentIds.has(id) || skippedUnknownIds.has(id)) candidates.delete(id)
  }
  return {
    count: candidates.size,
    sizeBytes: [...candidates.values()].flat().reduce((total, item) => total + item.sizeBytes, 0),
    candidateIds: [...candidates.keys()],
    closedSubagents: closedSubagentIds.size,
    skippedOpen: skippedOpenIds.size,
    skippedRecent: skippedRecentIds.size,
    skippedUnknown: skippedUnknownIds.size,
    graceMinutes: SAFE_CLEANUP_GRACE_MINUTES
  }
}

async function removeSessionIndexEntries(codexHome: string, ids: Set<string>): Promise<number> {
  const path = join(codexHome, 'session_index.jsonl')
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingError(error)) return 0
    throw error
  }

  let removed = 0
  const remaining: string[] = []
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue
    let shouldRemove = false
    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      shouldRemove = typeof entry.id === 'string' && ids.has(entry.id)
    } catch {
      // Keep malformed legacy entries unchanged.
    }
    if (shouldRemove) removed += 1
    else remaining.push(line)
  }
  if (removed > 0) {
    await atomicWriteFile(path, remaining.length > 0 ? `${remaining.join('\n')}\n` : '')
  }
  return removed
}

function removeIdsFromValue(
  value: unknown,
  ids: Set<string>,
  localIds: Set<string>
): { value: unknown; changed: number } {
  if (Array.isArray(value)) {
    let changed = 0
    const next: unknown[] = []
    for (const item of value) {
      if (typeof item === 'string' && (ids.has(item) || localIds.has(item))) {
        changed += 1
        continue
      }
      const cleaned = removeIdsFromValue(item, ids, localIds)
      changed += cleaned.changed
      next.push(cleaned.value)
    }
    return { value: next, changed }
  }
  const source = record(value)
  if (!source) return { value, changed: 0 }
  let changed = 0
  const next: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    if (ids.has(key) || localIds.has(key)) {
      changed += 1
      continue
    }
    const cleaned = removeIdsFromValue(item, ids, localIds)
    changed += cleaned.changed
    next[key] = cleaned.value
  }
  return { value: next, changed }
}

async function cleanGlobalState(codexHome: string, ids: Set<string>): Promise<number> {
  const path = join(codexHome, '.codex-global-state.json')
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingError(error)) return 0
    throw error
  }
  const state = record(JSON.parse(contents))
  if (!state) return 0
  const localIds = new Set([...ids].map((id) => `local:${id}`))
  let changed = 0
  for (const key of [
    'projectless-thread-ids',
    'queued-follow-ups',
    'thread-project-assignments',
    'thread-projectless-output-directories',
    'thread-workspace-root-hints'
  ]) {
    const cleaned = removeIdsFromValue(state[key], ids, localIds)
    if (cleaned.changed > 0) state[key] = cleaned.value
    changed += cleaned.changed
  }

  const atoms = record(state['electron-persisted-atom-state'])
  if (atoms) {
    for (const key of [
      'composer-prompt-drafts-v1',
      'electron:conversational-onboarding-conversation-ids',
      'heartbeat-thread-permissions-by-id',
      'thread-descriptions-v1',
      'unread-thread-ids-by-host-v1'
    ]) {
      const cleaned = removeIdsFromValue(atoms[key], ids, localIds)
      if (cleaned.changed > 0) atoms[key] = cleaned.value
      changed += cleaned.changed
    }
    for (const id of ids) {
      for (const key of [
        `thread-browser-tabs-v1:${id}`,
        `thread-client-id-v1:${encodeURIComponent(`local:${id}`)}`
      ]) {
        if (key in atoms) {
          delete atoms[key]
          changed += 1
        }
      }
      const deletedMarker = `codex-writing-block-deleted-thread-v1:${id}`
      if (atoms[deletedMarker] !== true) {
        atoms[deletedMarker] = true
        changed += 1
      }
    }
  }

  if (changed > 0) await atomicWriteFile(path, `${JSON.stringify(state, null, 2)}\n`)
  return changed
}

async function cleanConversationIndexes(
  codexHome: string,
  ids: readonly string[]
): Promise<{ changed: number; errors: string[] }> {
  const idSet = new Set(ids)
  let changed = 0
  const errors: string[] = []
  try {
    changed += await removeSessionIndexEntries(codexHome, idSet)
  } catch (error) {
    errors.push(`session_index.jsonl：${errorMessage(error)}`)
  }
  try {
    changed += await cleanGlobalState(codexHome, idSet)
  } catch (error) {
    errors.push(`全局状态：${errorMessage(error)}`)
  }
  let paths: string[] = []
  try {
    paths = await databasePaths(codexHome)
  } catch (error) {
    errors.push(`数据库目录：${errorMessage(error)}`)
  }
  for (const path of paths) {
    try {
      changed += cleanDatabase(path, ids)
    } catch (error) {
      errors.push(`${basename(path)}：${errorMessage(error)}`)
    }
  }
  return { changed, errors }
}

function normalizedListQuery(
  input: ConversationListQuery | string,
  offset?: number,
  limit?: number,
  force?: boolean
): ConversationListQuery {
  if (typeof input !== 'string') return input
  return { query: input, offset, limit, force }
}

function metadataMatches(conversation: ConversationSummary, keyword: string): boolean {
  return [
    conversation.title,
    conversation.id,
    conversation.cwd,
    conversation.provider,
    conversation.parentId,
    conversation.parentTitle,
    conversation.agentNickname,
    conversation.agentRole,
    conversation.subagentKind
  ].some((value) => value?.toLowerCase().includes(keyword))
}

function excerptForMatch(text: string, keyword: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  const index = normalized.toLowerCase().indexOf(keyword)
  if (index < 0) return ''
  const start = Math.max(0, index - 70)
  const end = Math.min(normalized.length, index + keyword.length + 90)
  return `${start > 0 ? '…' : ''}${normalized.slice(start, end)}${end < normalized.length ? '…' : ''}`
}

async function contentMatch(
  conversation: ConversationSummary,
  keyword: string,
  isCurrent: () => boolean
): Promise<string | null> {
  if (!isCurrent()) return null
  let excerpt: string | null = null
  await scanJsonl(
    conversation.sourcePath,
    conversation.sizeBytes,
    MAX_CONTENT_SEARCH_SCAN_BYTES,
    (line) => {
      if (!isCurrent()) return false
      const message = messageFromLine(line)
      if (!message || !message.text.toLowerCase().includes(keyword)) return true
      excerpt = excerptForMatch(message.text, keyword)
      return false
    }
  )
  return excerpt
}

function hierarchySort(conversations: ConversationSummary[]): ConversationSummary[] {
  const groupUpdatedAt = new Map<string, string>()
  for (const conversation of conversations) {
    const groupId = conversation.parentId ?? conversation.id
    const current = groupUpdatedAt.get(groupId)
    if (!current || conversation.updatedAt > current) groupUpdatedAt.set(groupId, conversation.updatedAt)
  }
  return conversations.sort((left, right) => {
    const leftGroup = left.parentId ?? left.id
    const rightGroup = right.parentId ?? right.id
    if (leftGroup !== rightGroup) {
      const updated = (groupUpdatedAt.get(rightGroup) ?? '').localeCompare(groupUpdatedAt.get(leftGroup) ?? '')
      if (updated !== 0) return updated
      return leftGroup.localeCompare(rightGroup)
    }
    if (left.id === leftGroup && right.id !== rightGroup) return -1
    if (right.id === rightGroup && left.id !== leftGroup) return 1
    return right.updatedAt.localeCompare(left.updatedAt)
  })
}

export class ConversationManager {
  private readonly index: DirectoryRecordIndex<ConversationSummary>
  private graphCache: ConversationGraphSnapshot | null = null
  private contentSearchVersion = 0

  constructor(private readonly codexHome: string, cacheFile?: string) {
    this.index = new DirectoryRecordIndex({
      directory: async () => {
        await mkdir(this.codexHome, { recursive: true })
        return this.codexHome
      },
      collectPaths: collectConversationPaths,
      loadPath: (path) => conversationSummary(this.codexHome, path),
      concurrency: 6,
      cacheFile: cacheFile ? () => cacheFile : undefined,
      cacheVersion: 2
    })
  }

  private async graph(force = false): Promise<ConversationGraphSnapshot> {
    const database = await graphDatabase(this.codexHome)
    if (!database) {
      const empty = {
        signature: 'missing',
        edges: new Map<string, ConversationGraphEdge>(),
        openParentIds: new Set<string>(),
        parentIds: new Set<string>()
      }
      this.graphCache = empty
      return empty
    }
    if (!force && this.graphCache?.signature === database.signature) return this.graphCache
    try {
      this.graphCache = readConversationGraph(database.path, database.signature)
    } catch {
      this.graphCache = {
        signature: `${database.signature}:unavailable`,
        edges: new Map<string, ConversationGraphEdge>(),
        openParentIds: new Set<string>(),
        parentIds: new Set<string>()
      }
    }
    return this.graphCache
  }

  private async all(force = false): Promise<{ conversations: ConversationSummary[]; graph: ConversationGraphSnapshot }> {
    const [indexed, graph] = await Promise.all([this.index.list(force), this.graph(force)])
    const withEdges = indexed.map((item) => {
      const edge = graph.edges.get(item.id)
      const parentId = item.parentId ?? edge?.parentId ?? null
      const kind = item.kind === 'unknown' && edge ? 'subagent' : item.kind
      const subagentKind = item.subagentKind ?? (edge ? 'thread_spawn' : null)
      return {
        ...item,
        kind,
        subagentKind,
        parentId,
        lifecycleStatus: edge?.status ?? item.lifecycleStatus,
        matchExcerpt: null
      }
    })
    const titles = new Map(withEdges.map((item) => [item.id, item.title]))
    const childCounts = new Map<string, number>()
    for (const item of withEdges) {
      if (item.parentId) childCounts.set(item.parentId, (childCounts.get(item.parentId) ?? 0) + 1)
    }
    const conversations = withEdges.map((item) => {
      const enriched: ConversationSummary = {
        ...item,
        parentTitle: item.parentId ? titles.get(item.parentId) ?? null : null,
        childCount: childCounts.get(item.id) ?? 0,
        safeToClean: false
      }
      enriched.safeToClean = safeCleanupClassification(enriched, graph) === 'eligible'
      return enriched
    })
    return { conversations, graph }
  }

  async list(
    input: ConversationListQuery | string = {},
    legacyOffset?: number,
    legacyLimit?: number,
    legacyForce?: boolean
  ): Promise<ConversationListResult> {
    const options = normalizedListQuery(input, legacyOffset, legacyLimit, legacyForce)
    const searchVersion = ++this.contentSearchVersion
    const keyword = options.query?.trim().toLowerCase() ?? ''
    const { conversations, graph } = await this.all(options.force)
    const facets = conversationFacets(conversations)
    let filtered = conversations.filter((item) => {
      if (options.kind && options.kind !== 'all' && item.kind !== options.kind) return false
      if (options.subagentKind && options.subagentKind !== 'all' && item.subagentKind !== options.subagentKind) return false
      if (options.lifecycleStatus && options.lifecycleStatus !== 'all' && item.lifecycleStatus !== options.lifecycleStatus) return false
      if (options.archive === 'active' && item.archived) return false
      if (options.archive === 'archived' && !item.archived) return false
      if (options.provider && item.provider !== options.provider) return false
      if (options.workspace && item.cwd !== options.workspace) return false
      if (options.updatedWithinDays && options.updatedWithinDays > 0) {
        const cutoff = Date.now() - options.updatedWithinDays * 24 * 60 * 60 * 1000
        if (new Date(item.updatedAt).getTime() < cutoff) return false
      }
      return true
    })

    if (keyword && options.searchScope === 'content') {
      const matched = await mapConcurrent(filtered, CONTENT_SEARCH_CONCURRENCY, async (item) => {
        if (searchVersion !== this.contentSearchVersion) return null
        if (metadataMatches(item, keyword)) return item
        const excerpt = await contentMatch(item, keyword, () => searchVersion === this.contentSearchVersion)
        return excerpt ? { ...item, matchExcerpt: excerpt } : null
      })
      filtered = matched.filter((item): item is ConversationSummary => Boolean(item))
    } else if (keyword) {
      filtered = filtered.filter((item) => metadataMatches(item, keyword))
    }

    filtered = options.sort === 'hierarchy'
      ? hierarchySort(filtered)
      : filtered.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    const safeOffset = Math.max(0, options.offset ?? 0)
    const safeLimit = Math.max(1, Math.min(200, options.limit ?? 100))
    const cleanup = safeCleanupPreview(conversations, graph)
    return {
      items: filtered.slice(safeOffset, safeOffset + safeLimit),
      total: filtered.length,
      allTotal: conversations.length,
      offset: safeOffset,
      hasMore: safeOffset + safeLimit < filtered.length,
      facets,
      safeCleanupCount: cleanup.count,
      safeCleanupBytes: cleanup.sizeBytes
    }
  }

  async detail(id: string): Promise<ConversationDetail> {
    const { conversations } = await this.all()
    const conversation = conversations
      .filter((item) => item.id === id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
    if (!conversation) throw new Error('对话不存在或已经被移动')

    const messages: ConversationMessage[] = []
    let totalMessages = 0
    let totalChars = 0
    let truncated = false
    let previousKey = ''
    const scan = await scanJsonl(
      conversation.sourcePath,
      conversation.sizeBytes,
      MAX_DETAIL_SCAN_BYTES,
      (line) => {
        const message = messageFromLine(line)
        if (!message) return true
        const duplicateKey = `${message.role}:${message.text}`
        if (duplicateKey === previousKey) return true
        previousKey = duplicateKey
        totalMessages += 1
        if (messages.length >= MAX_DETAIL_MESSAGES || totalChars + message.text.length > MAX_DETAIL_CHARS) {
          truncated = true
          return false
        }
        totalChars += message.text.length
        messages.push({ ...message, id: `${id}:${totalMessages}` })
        return true
      }
    )
    truncated ||= scan.limitReached
    return { conversation, messages, totalMessages, truncated }
  }

  async reveal(id: string): Promise<string | null> {
    const conversation = (await this.all()).conversations.find((item) => item.id === id)
    return conversation?.sourcePath ?? null
  }

  async previewSafeCleanup(): Promise<ConversationCleanupPreview> {
    const { conversations, graph } = await this.all(true)
    return safeCleanupPreview(conversations, graph)
  }

  async cleanupSafe(
    trashItem: (path: string) => Promise<void>
  ): Promise<DeleteConversationsResult> {
    const preview = await this.previewSafeCleanup()
    if (preview.candidateIds.length === 0) {
      return {
        deleted: 0,
        failed: 0,
        deletedIds: [],
        indexEntriesChanged: 0,
        errors: [],
        message: '没有符合保守清理条件的已关闭子代理对话。'
      }
    }
    return this.delete(preview.candidateIds, trashItem)
  }

  async delete(
    ids: readonly string[],
    trashItem: (path: string) => Promise<void>
  ): Promise<DeleteConversationsResult> {
    const requestedIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
    const requestedIdSet = new Set(requestedIds)
    const conversations = (await this.all(true)).conversations
    const grouped = new Map<string, ConversationSummary[]>()
    for (const conversation of conversations) {
      if (!requestedIdSet.has(conversation.id)) continue
      const records = grouped.get(conversation.id) ?? []
      records.push(conversation)
      grouped.set(conversation.id, records)
    }

    const deletionResults = await mapConcurrent(
      requestedIds,
      DELETE_CONCURRENCY,
      async (id): Promise<{ id: string; ok: boolean; errors: string[] }> => {
        const records = grouped.get(id)
        if (!records?.length) return { id, ok: false, errors: [`${id}：对话不存在或已经被移动`] }
        const paths = new Set<string>()
        try {
          for (const conversation of records) {
            const sourcePath = managedConversationPath(this.codexHome, conversation.sourcePath)
            paths.add(sourcePath)
            const compressedPath = managedConversationPath(this.codexHome, `${sourcePath}.zst`)
            if (await pathExists(compressedPath)) paths.add(compressedPath)
          }
        } catch (error) {
          return { id, ok: false, errors: [`${id}：${errorMessage(error)}`] }
        }

        const errors: string[] = []
        for (const path of paths) {
          try {
            if (!(await pathExists(path))) continue
            await trashItem(path)
          } catch (error) {
            if (!isMissingError(error)) errors.push(`${id} / ${basename(path)}：${errorMessage(error)}`)
          }
        }

        const remaining: string[] = []
        for (const path of paths) {
          try {
            if (await pathExists(path)) remaining.push(path)
          } catch (error) {
            errors.push(`${id} / ${basename(path)}：${errorMessage(error)}`)
            remaining.push(path)
          }
        }
        if (remaining.length > 0) {
          if (errors.length === 0) errors.push(`${id}：部分对话文件未能移入回收站`)
          return { id, ok: false, errors }
        }
        return { id, ok: true, errors: [] }
      }
    )

    const deletedIds = deletionResults.filter((result) => result.ok).map((result) => result.id)
    const deletionErrors = deletionResults.flatMap((result) => result.errors)
    const indexCleanup = deletedIds.length > 0
      ? await cleanConversationIndexes(this.codexHome, deletedIds)
      : { changed: 0, errors: [] }
    this.index.invalidate()

    const failed = requestedIds.length - deletedIds.length
    const allErrors = [...deletionErrors, ...indexCleanup.errors]
    const displayedErrors = allErrors.slice(0, 100)
    if (allErrors.length > displayedErrors.length) {
      displayedErrors.push(`另有 ${allErrors.length - displayedErrors.length} 项错误未展开`)
    }
    const parts = [`已将 ${deletedIds.length} 个对话移入 Windows 回收站`]
    if (failed > 0) parts.push(`${failed} 个未能删除`)
    if (indexCleanup.errors.length > 0) parts.push(`${indexCleanup.errors.length} 个本地索引未能清理`)
    else if (deletedIds.length > 0) parts.push(`已清理 ${indexCleanup.changed} 条本地索引`)
    return {
      deleted: deletedIds.length,
      failed,
      deletedIds,
      indexEntriesChanged: indexCleanup.changed,
      errors: displayedErrors,
      message: `${parts.join('；')}。`
    }
  }

  invalidate(): void {
    this.index.invalidate()
    this.graphCache = null
    this.contentSearchVersion += 1
  }
}
