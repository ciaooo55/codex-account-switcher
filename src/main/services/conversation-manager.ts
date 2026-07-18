import { createReadStream } from 'node:fs'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ConversationDetail,
  ConversationListResult,
  ConversationMessage,
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
const DATABASE_FILE_PATTERN = /^(?:state|logs|goals|memories|thread_history)_\d+\.sqlite$/i
const DELETE_CONCURRENCY = 4

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
    sizeBytes: metadata.size
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

export class ConversationManager {
  private readonly index: DirectoryRecordIndex<ConversationSummary>

  constructor(private readonly codexHome: string) {
    this.index = new DirectoryRecordIndex({
      directory: async () => {
        await mkdir(this.codexHome, { recursive: true })
        return this.codexHome
      },
      collectPaths: collectConversationPaths,
      loadPath: (path) => conversationSummary(this.codexHome, path),
      concurrency: 6
    })
  }

  async list(
    query = '',
    offset = 0,
    limit = 100,
    force = false
  ): Promise<ConversationListResult> {
    const keyword = query.trim().toLowerCase()
    const all = (await this.index.list(force))
      .filter((item) => !keyword || [item.title, item.id, item.cwd, item.provider]
        .some((value) => value?.toLowerCase().includes(keyword)))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    const safeOffset = Math.max(0, offset)
    const safeLimit = Math.max(1, Math.min(200, limit))
    return {
      items: all.slice(safeOffset, safeOffset + safeLimit),
      total: all.length,
      offset: safeOffset,
      hasMore: safeOffset + safeLimit < all.length
    }
  }

  async detail(id: string): Promise<ConversationDetail> {
    const conversations = await this.index.list()
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
    const conversation = (await this.index.list()).find((item) => item.id === id)
    return conversation?.sourcePath ?? null
  }

  async delete(
    ids: readonly string[],
    trashItem: (path: string) => Promise<void>
  ): Promise<DeleteConversationsResult> {
    const requestedIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
    const requestedIdSet = new Set(requestedIds)
    const conversations = await this.index.list(true)
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
  }
}
