import type {
  AccountMetadata,
  AccountMetadataFields,
  AccountMetadataUpdateRequest
} from '../../shared/types'
import { atomicWriteFile, readUtf8File } from './atomic-file'

interface AccountMetadataFile {
  version: 1
  entries: Record<string, AccountMetadata>
}

const MAX_ALIAS_LENGTH = 120
const MAX_GROUP_LENGTH = 80
const MAX_TAG_LENGTH = 48
const MAX_TAGS = 24
const MAX_NOTE_LENGTH = 2_000

function optionalText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().slice(0, maximum)
  return normalized || null
}

function normalizedTags(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const unique = new Map<string, string>()
  for (const value of values) {
    const tag = optionalText(value, MAX_TAG_LENGTH)
    if (!tag) continue
    const key = tag.toLocaleLowerCase('zh-CN')
    if (!unique.has(key)) unique.set(key, tag)
    if (unique.size >= MAX_TAGS) break
  }
  return [...unique.values()]
}

function normalizeEntry(id: string, value: unknown): AccountMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entry = value as Partial<AccountMetadata>
  return {
    accountId: id,
    alias: optionalText(entry.alias, MAX_ALIAS_LENGTH),
    group: optionalText(entry.group, MAX_GROUP_LENGTH),
    tags: normalizedTags(entry.tags),
    note: optionalText(entry.note, MAX_NOTE_LENGTH),
    updatedAt: typeof entry.updatedAt === 'string' && Number.isFinite(Date.parse(entry.updatedAt))
      ? entry.updatedAt
      : new Date(0).toISOString()
  }
}

function hasContent(entry: AccountMetadata): boolean {
  return Boolean(entry.alias || entry.group || entry.tags.length || entry.note)
}

export class AccountMetadataStore {
  private cache: Record<string, AccountMetadata> | null = null
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async getAll(): Promise<Record<string, AccountMetadata>> {
    await this.writeQueue
    return { ...(await this.load()) }
  }

  peek(id: string): AccountMetadataFields {
    const entry = this.cache?.[id]
    return entry
      ? { alias: entry.alias, group: entry.group, tags: [...entry.tags], note: entry.note }
      : { alias: null, group: null, tags: [], note: null }
  }

  decorate<T extends { id: string }>(account: T): T & AccountMetadataFields {
    return { ...account, ...this.peek(account.id) }
  }

  async update(request: AccountMetadataUpdateRequest): Promise<Record<string, AccountMetadata>> {
    const ids = [...new Set(request.accountIds)]
    if (ids.length === 0) return this.getAll()
    const operation = this.writeQueue.then(async () => {
      const entries = await this.load()
      const incomingTags = normalizedTags(request.tags)
      for (const id of ids) {
        const current = entries[id] ?? {
          accountId: id,
          alias: null,
          group: null,
          tags: [],
          note: null,
          updatedAt: new Date(0).toISOString()
        }
        let tags = current.tags
        if ('tags' in request) {
          if (request.tagMode === 'add') tags = normalizedTags([...current.tags, ...incomingTags])
          else if (request.tagMode === 'remove') {
            const removed = new Set(incomingTags.map((tag) => tag.toLocaleLowerCase('zh-CN')))
            tags = current.tags.filter((tag) => !removed.has(tag.toLocaleLowerCase('zh-CN')))
          } else tags = incomingTags
        }
        const next: AccountMetadata = {
          accountId: id,
          alias: 'alias' in request ? optionalText(request.alias, MAX_ALIAS_LENGTH) : current.alias,
          group: 'group' in request ? optionalText(request.group, MAX_GROUP_LENGTH) : current.group,
          tags,
          note: 'note' in request ? optionalText(request.note, MAX_NOTE_LENGTH) : current.note,
          updatedAt: new Date().toISOString()
        }
        if (hasContent(next)) entries[id] = next
        else delete entries[id]
      }
      await this.save(entries)
    })
    this.writeQueue = operation.catch(() => undefined)
    await operation
    return this.getAll()
  }

  async removeMany(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    const operation = this.writeQueue.then(async () => {
      const entries = await this.load()
      for (const id of ids) delete entries[id]
      await this.save(entries)
    })
    this.writeQueue = operation.catch(() => undefined)
    await operation
  }

  private async load(): Promise<Record<string, AccountMetadata>> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(await readUtf8File(this.path)) as Partial<AccountMetadataFile>
      const entries: Record<string, AccountMetadata> = {}
      if (parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
        for (const [id, value] of Object.entries(parsed.entries)) {
          const entry = normalizeEntry(id, value)
          if (entry && hasContent(entry)) entries[id] = entry
        }
      }
      this.cache = entries
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.cache = {}
    }
    return this.cache
  }

  private async save(entries: Record<string, AccountMetadata>): Promise<void> {
    this.cache = entries
    await atomicWriteFile(this.path, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`)
  }
}
