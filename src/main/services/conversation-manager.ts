import { createReadStream } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import type {
  ConversationDetail,
  ConversationListResult,
  ConversationMessage,
  ConversationSummary
} from '../../shared/types'
import { DirectoryRecordIndex } from '../storage/directory-record-index'

const SESSION_DIRECTORIES = ['sessions', 'archived_sessions'] as const
const MAX_MESSAGE_CHARS = 12_000
const MAX_DETAIL_CHARS = 600_000
const MAX_DETAIL_MESSAGES = 400
const MAX_JSONL_LINE_BYTES = 1024 * 1024
const MAX_SUMMARY_SCAN_BYTES = 4 * 1024 * 1024
const MAX_DETAIL_SCAN_BYTES = 32 * 1024 * 1024

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

  invalidate(): void {
    this.index.invalidate()
  }
}
