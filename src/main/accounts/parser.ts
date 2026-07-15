import { createHash } from 'node:crypto'
import { parse, type Node } from 'acorn'
import type {
  CredentialDialect,
  CredentialParseOptions,
  CredentialParseResult,
  NormalizedCredential
} from '../../shared/types'

type StaticScalar = string | number | boolean | null
type StaticValue = StaticScalar | StaticValue[] | StaticObject
interface StaticObject {
  [key: string]: StaticValue
}

type AstNode = Node & Record<string, unknown>

interface CredentialCandidate {
  record: Record<string, unknown>
  dialect: CredentialDialect
}

const ACCESS_TOKEN_KEYS = ['access_token', 'accessToken', 'OPENAI_ACCESS_TOKEN'] as const
const REFRESH_TOKEN_KEYS = ['refresh_token', 'refreshToken'] as const
const ID_TOKEN_KEYS = ['id_token', 'idToken'] as const
const MAX_PARSE_DEPTH = 64
const MAX_PARSE_NODES = 10_000

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asNode(value: unknown): AstNode | null {
  const record = asRecord(value)
  return record && typeof record.type === 'string' ? (record as AstNode) : null
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function valuesAt(record: Record<string, unknown> | null, keys: readonly string[]): unknown[] {
  if (!record) return []
  return keys.map((key) => record[key])
}

function tokenFrom(
  record: Record<string, unknown>,
  tokens: Record<string, unknown> | null,
  keys: readonly string[]
): string | null {
  return firstString(...valuesAt(record, keys), ...valuesAt(tokens, keys))
}

function decodeJwtPayload(token: string | null): Record<string, unknown> | null {
  if (!token) return null
  const segments = token.split('.')
  if (segments.length < 2 || !segments[1]) return null
  try {
    const decoded = Buffer.from(segments[1], 'base64url').toString('utf8')
    return asRecord(JSON.parse(decoded))
  } catch {
    return null
  }
}

function claimRecord(
  payload: Record<string, unknown> | null,
  namespacedKey: string,
  shortKey: string
): Record<string, unknown> | null {
  return asRecord(payload?.[namespacedKey]) ?? asRecord(payload?.[shortKey])
}

function expiryFrom(payload: Record<string, unknown> | null): string | null {
  const raw = payload?.exp
  const seconds = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(seconds)) return null
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function timestampFrom(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value)
      const timestamp = Number.isFinite(numeric)
        ? numeric > 10_000_000_000
          ? numeric
          : numeric * 1_000
        : Date.parse(value)
      if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString()
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      const timestamp = value > 10_000_000_000 ? value : value * 1_000
      return new Date(timestamp).toISOString()
    }
  }
  return null
}

function filenameEmail(sourcePath: string): string | null {
  const filename = sourcePath.split(/[\\/]/).pop() ?? sourcePath
  const stem = filename.replace(/\.(?:jsonl?|txt|[cm]?js)$/i, '')
  return stem.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null
}

function defaultOrganizationId(auth: Record<string, unknown> | null): string | null {
  const organizations = auth?.organizations
  if (!Array.isArray(organizations)) return null
  for (const organization of organizations) {
    const item = asRecord(organization)
    if (item && (item.is_default === true || item.isDefault === true)) {
      return firstString(item.id, item.organization_id, item.organizationId)
    }
  }
  return null
}

function credentialId(
  subject: string | null,
  email: string | null,
  accountId: string | null,
  fallbackToken: string
): string {
  const parts: string[] = []
  if (subject) {
    parts.push(`subject:${subject}`, `account:${accountId ?? ''}`)
  } else if (email) {
    parts.push(`email:${email.toLowerCase()}`, `account:${accountId ?? ''}`)
  } else {
    // A workspace alone is not a user identity, so retain token entropy when user claims are absent.
    parts.push(`account:${accountId ?? ''}`, `token:${fallbackToken}`)
  }
  return createHash('sha256').update(parts.join('\u0000'), 'utf8').digest('hex')
}

function normalizeCredential(
  record: Record<string, unknown>,
  options: CredentialParseOptions,
  sourceDialect: CredentialDialect
): NormalizedCredential | null {
  const tokens = asRecord(record.tokens)
  const accessToken = tokenFrom(record, tokens, ACCESS_TOKEN_KEYS)
  if (!accessToken) return null

  const refreshToken = tokenFrom(record, tokens, REFRESH_TOKEN_KEYS)
  const idToken = tokenFrom(record, tokens, ID_TOKEN_KEYS)
  const accessPayload = decodeJwtPayload(accessToken)
  const idPayload = decodeJwtPayload(idToken)
  const accessAuth = claimRecord(accessPayload, 'https://api.openai.com/auth', 'auth')
  const idAuth = claimRecord(idPayload, 'https://api.openai.com/auth', 'auth')
  const accessProfile = claimRecord(
    accessPayload,
    'https://api.openai.com/profile',
    'profile'
  )

  const email = firstString(
    idPayload?.email,
    accessProfile?.email,
    record.email,
    emailFromName(record.name),
    filenameEmail(options.sourcePath)
  )
  const accountId = firstString(
    record.account_id,
    record.chatgpt_account_id,
    record.organization_id,
    record.organizationId,
    accessAuth?.chatgpt_account_id,
    accessAuth?.poid,
    idAuth?.chatgpt_account_id,
    defaultOrganizationId(idAuth),
    tokens?.account_id,
    tokens?.chatgpt_account_id
  )
  const subject = firstString(
    idPayload?.sub,
    accessPayload?.sub,
    record.chatgpt_user_id,
    record.subject,
    record.sub
  )
  const planType = firstString(
    record.plan_type,
    record.planType,
    accessAuth?.plan_type,
    accessAuth?.planType,
    idAuth?.plan_type,
    idAuth?.planType
  )
  const lastRefresh = firstString(
    record.last_refresh,
    record.lastRefresh,
    tokens?.last_refresh,
    tokens?.lastRefresh
  )

  return {
    id: credentialId(subject, email, accountId, accessToken),
    email,
    accountId,
    subject,
    accessToken,
    refreshToken,
    idToken,
    planType,
    lastRefresh,
    accessExpiresAt:
      expiryFrom(accessPayload) ??
      timestampFrom(record.expires_at, record.expiresAt, record.expired),
    idExpiresAt: expiryFrom(idPayload),
    canRefresh: refreshToken !== null,
    sourcePath: options.sourcePath,
    sourceFormat: options.format,
    sourceDialect
  }
}

function hasAnyKey(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => Object.hasOwn(record, key))
}

function looksLikeCredential(record: Record<string, unknown>): boolean {
  if (
    hasAnyKey(record, ACCESS_TOKEN_KEYS) ||
    hasAnyKey(record, REFRESH_TOKEN_KEYS) ||
    hasAnyKey(record, ID_TOKEN_KEYS)
  ) {
    return true
  }
  const tokens = asRecord(record.tokens)
  return Boolean(
    tokens &&
      (hasAnyKey(tokens, ACCESS_TOKEN_KEYS) ||
        hasAnyKey(tokens, REFRESH_TOKEN_KEYS) ||
        hasAnyKey(tokens, ID_TOKEN_KEYS))
  )
}

function emailFromName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? null
}

function sub2ApiCandidate(record: Record<string, unknown>): CredentialCandidate | null {
  const credentials = asRecord(record.credentials)
  if (!credentials || !looksLikeCredential(credentials)) return null
  const platform = firstString(record.platform)?.toLowerCase()
  const accountType = firstString(record.type)?.toLowerCase()
  if (platform !== 'openai' && !['oauth', 'setup_token', 'api_key', 'upstream'].includes(accountType ?? '')) {
    return null
  }
  const extra = asRecord(record.extra)
  return {
    dialect: 'sub2api',
    record: {
      ...extra,
      ...record,
      ...credentials,
      email: firstString(credentials.email, extra?.email, record.email, emailFromName(record.name)),
      last_refresh: firstString(
        credentials.last_refresh,
        credentials.lastRefresh,
        extra?.last_refresh,
        extra?.lastRefresh,
        record.last_refresh,
        record.lastRefresh
      ),
      expires_at:
        credentials.expires_at ?? credentials.expiresAt ?? record.expires_at ?? record.expiresAt
    }
  }
}

function recordDialect(record: Record<string, unknown>): CredentialDialect {
  if (asRecord(record.tokens)) return 'codex'
  if (firstString(record.type)?.toLowerCase() === 'codex') return 'cpa'
  if (hasAnyKey(record, ACCESS_TOKEN_KEYS)) return 'cpa'
  return 'generic'
}

function credentialRecords(value: unknown, depth = 0): CredentialCandidate[] {
  if (depth > MAX_PARSE_DEPTH) throw new RangeError('Credential data exceeds maximum depth')
  if (Array.isArray(value)) {
    return value.flatMap((item) => credentialRecords(item, depth + 1))
  }
  const record = asRecord(value)
  if (!record) return []
  const sub2api = sub2ApiCandidate(record)
  if (sub2api) return [sub2api]
  if (looksLikeCredential(record)) return [{ record, dialect: recordDialect(record) }]
  return Object.values(record).flatMap((item) => credentialRecords(item, depth + 1))
}

function validateValueLimits(values: readonly unknown[]): void {
  const stack = values.map((value) => ({ value, depth: 0 }))
  let nodes = 0

  while (stack.length > 0) {
    const current = stack.pop()!
    if (current.depth > MAX_PARSE_DEPTH) {
      throw new RangeError('Credential data exceeds maximum depth')
    }
    nodes += 1
    if (nodes > MAX_PARSE_NODES) {
      throw new RangeError('Credential data exceeds maximum node count')
    }

    if (Array.isArray(current.value)) {
      for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 })
      continue
    }
    const record = asRecord(current.value)
    if (!record) continue
    for (const item of Object.values(record)) {
      stack.push({ value: item, depth: current.depth + 1 })
    }
  }
}

function tryJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function tryJsonLines(text: string): unknown[] | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return undefined

  const values: unknown[] = []
  for (const line of lines) {
    try {
      values.push(JSON.parse(line))
    } catch {
      return undefined
    }
  }
  return values
}

function jsonFragments(text: string): unknown[] {
  const values: unknown[] = []
  let start = -1
  let depth = 0
  let quote = ''
  let escaped = false

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"') {
      quote = character
      continue
    }
    if (character === '{' || character === '[') {
      if (depth === 0) start = index
      depth += 1
      continue
    }
    if ((character === '}' || character === ']') && depth > 0) {
      depth -= 1
      if (depth === 0 && start >= 0) {
        const parsed = tryJson(text.slice(start, index + 1))
        if (parsed !== undefined) values.push(parsed)
        start = -1
      }
    }
  }
  return values
}

function pastedValues(text: string): unknown[] {
  const direct = tryJson(text)
  if (direct !== undefined) return [direct]
  const values: unknown[] = []
  const fenced = /```(?:jsonl?|javascript|js|txt)?\s*([\s\S]*?)```/gi
  for (const match of text.matchAll(fenced)) {
    const block = match[1]?.trim() ?? ''
    if (!block) continue
    const json = tryJson(block)
    if (json !== undefined) values.push(json)
    else {
      values.push(...(tryJsonLines(block) ?? []))
      values.push(...(tryKeyValueBlocks(block) ?? []))
      values.push(...(tryStaticJavaScript(block) ?? []))
    }
  }
  if (values.length > 0) return values
  const fragments = jsonFragments(text)
  if (fragments.length > 0) return fragments
  return tryJsonLines(text) ?? tryKeyValueBlocks(text) ?? tryStaticJavaScript(text) ?? []
}

function parseKeyValueValue(raw: string): StaticScalar {
  const value = raw.trim()
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  if (value === 'null') return null
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value)
  return value
}

function setStaticPath(record: StaticObject, rawPath: string, value: StaticScalar): boolean {
  const path = rawPath.split('.').map((part) => part.trim())
  if (path.some((part) => !part || part === '__proto__' || part === 'prototype')) return false

  let target = record
  for (const part of path.slice(0, -1)) {
    const current = target[part]
    if (current === undefined) {
      const next: StaticObject = Object.create(null) as StaticObject
      target[part] = next
      target = next
    } else if (asRecord(current)) {
      target = current as StaticObject
    } else {
      return false
    }
  }
  target[path[path.length - 1]] = value
  return true
}

function tryKeyValueBlocks(text: string): StaticObject[] | undefined {
  const records: StaticObject[] = []
  let current: StaticObject = Object.create(null) as StaticObject
  let currentSize = 0

  const flush = (): void => {
    if (currentSize > 0) records.push(current)
    current = Object.create(null) as StaticObject
    currentSize = 0
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      flush()
      continue
    }
    if (line.startsWith('#') || line.startsWith(';')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) return undefined
    const rawKey = line.slice(0, separator).trim().replace(/^export\s+/, '')
    if (!setStaticPath(current, rawKey, parseKeyValueValue(line.slice(separator + 1)))) {
      return undefined
    }
    currentSize += 1
  }
  flush()
  return records.length > 0 ? records : undefined
}

function propertyKey(node: AstNode): string | null {
  if (node.type === 'Identifier' && typeof node.name === 'string') return node.name
  if (node.type !== 'Literal') return null
  return typeof node.value === 'string' || typeof node.value === 'number'
    ? String(node.value)
    : null
}

function staticValue(node: AstNode, depth = 0): StaticValue | undefined {
  if (depth > MAX_PARSE_DEPTH) throw new RangeError('Static JavaScript exceeds maximum depth')
  if (node.type === 'Literal') {
    const value = node.value
    return value === null || ['string', 'number', 'boolean'].includes(typeof value)
      ? (value as StaticScalar)
      : undefined
  }

  if (node.type === 'ArrayExpression') {
    const elements = Array.isArray(node.elements) ? node.elements : []
    const result: StaticValue[] = []
    for (const element of elements) {
      const child = asNode(element)
      if (!child) return undefined
      const value = staticValue(child, depth + 1)
      if (value === undefined) return undefined
      result.push(value)
    }
    return result
  }

  if (node.type === 'ObjectExpression') {
    const properties = Array.isArray(node.properties) ? node.properties : []
    const result: StaticObject = Object.create(null) as StaticObject
    for (const rawProperty of properties) {
      const property = asNode(rawProperty)
      if (
        !property ||
        property.type !== 'Property' ||
        property.kind !== 'init' ||
        property.method === true ||
        property.computed === true
      ) {
        return undefined
      }
      const keyNode = asNode(property.key)
      const valueNode = asNode(property.value)
      const key = keyNode ? propertyKey(keyNode) : null
      if (!key || !valueNode) return undefined
      const value = staticValue(valueNode, depth + 1)
      if (value === undefined) return undefined
      result[key] = value
    }
    return result
  }

  return undefined
}

function moduleExportAssignment(node: AstNode): AstNode | null {
  if (node.type !== 'ExpressionStatement') return null
  const expression = asNode(node.expression)
  if (!expression || expression.type !== 'AssignmentExpression' || expression.operator !== '=') {
    return null
  }
  const left = asNode(expression.left)
  const right = asNode(expression.right)
  if (!left || left.type !== 'MemberExpression' || left.computed === true || !right) return null
  const object = asNode(left.object)
  const property = asNode(left.property)
  return object?.type === 'Identifier' &&
    object.name === 'module' &&
    property?.type === 'Identifier' &&
    property.name === 'exports'
    ? right
    : null
}

function variableValues(node: AstNode): StaticValue[] {
  if (node.type !== 'VariableDeclaration' || !Array.isArray(node.declarations)) return []
  const values: StaticValue[] = []
  for (const rawDeclaration of node.declarations) {
    const declaration = asNode(rawDeclaration)
    const initializer = declaration ? asNode(declaration.init) : null
    if (!initializer) continue
    const value = staticValue(initializer)
    if (value !== undefined) values.push(value)
  }
  return values
}

function parseJavaScriptProgram(text: string): AstNode | null {
  try {
    return parse(text, { ecmaVersion: 'latest', sourceType: 'module' }) as unknown as AstNode
  } catch {
    try {
      return parse(text, { ecmaVersion: 'latest', sourceType: 'script' }) as unknown as AstNode
    } catch {
      return null
    }
  }
}

function validateAstLimits(program: AstNode): void {
  const stack: Array<{ node: AstNode; depth: number }> = [{ node: program, depth: 0 }]
  const visited = new WeakSet<object>()
  let nodes = 0

  while (stack.length > 0) {
    const current = stack.pop()!
    if (visited.has(current.node)) continue
    visited.add(current.node)
    if (current.depth > MAX_PARSE_DEPTH) {
      throw new RangeError('Static JavaScript exceeds maximum depth')
    }
    nodes += 1
    if (nodes > MAX_PARSE_NODES) {
      throw new RangeError('Static JavaScript exceeds maximum node count')
    }

    for (const value of Object.values(current.node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          const child = asNode(item)
          if (child) stack.push({ node: child, depth: current.depth + 1 })
        }
      } else {
        const child = asNode(value)
        if (child) stack.push({ node: child, depth: current.depth + 1 })
      }
    }
  }
}

function tryStaticJavaScript(text: string): StaticValue[] | undefined {
  const program = parseJavaScriptProgram(text)
  if (!program || !Array.isArray(program.body)) return undefined
  validateAstLimits(program)

  const values: StaticValue[] = []
  for (const rawStatement of program.body) {
    const statement = asNode(rawStatement)
    if (!statement) continue

    if (statement.type === 'ExportDefaultDeclaration') {
      const declaration = asNode(statement.declaration)
      if (declaration) {
        const value = staticValue(declaration)
        if (value !== undefined) values.push(value)
      }
      continue
    }

    if (statement.type === 'ExportNamedDeclaration') {
      const declaration = asNode(statement.declaration)
      if (declaration) values.push(...variableValues(declaration))
      continue
    }

    values.push(...variableValues(statement))
    const exported = moduleExportAssignment(statement)
    if (exported) {
      const value = staticValue(exported)
      if (value !== undefined) values.push(value)
    }
  }
  return values.length > 0 ? values : undefined
}

function extractedValues(text: string, options: CredentialParseOptions): unknown[] {
  if (options.format === 'paste' || options.format === 'md') return pastedValues(text)
  const json = tryJson(text)
  if (json !== undefined) return [json]

  if (options.format === 'js') return tryStaticJavaScript(text) ?? []

  const jsonLines = tryJsonLines(text)
  if (jsonLines !== undefined) return jsonLines

  if (options.format === 'txt') return tryKeyValueBlocks(text) ?? []
  return []
}

export function parseCredentialText(
  text: string,
  options: CredentialParseOptions
): CredentialParseResult {
  const errorResult = (): CredentialParseResult => ({
    credentials: [],
    errors: [`No usable credentials found in ${options.sourcePath || '<unknown file>'}`]
  })

  try {
    const values = extractedValues(text, options)
    validateValueLimits(values)
    const credentials = values
      .flatMap((value) => credentialRecords(value))
      .map((candidate) => normalizeCredential(candidate.record, options, candidate.dialect))
      .filter((credential): credential is NormalizedCredential => credential !== null)

    return credentials.length > 0 ? { credentials, errors: [] } : errorResult()
  } catch {
    return errorResult()
  }
}

function dedupeKey(credential: NormalizedCredential): string {
  return credentialId(
    credential.subject,
    credential.email,
    credential.accountId,
    credential.accessToken
  )
}

function tokenCompleteness(credential: NormalizedCredential): number {
  return [credential.accessToken, credential.refreshToken, credential.idToken].filter(Boolean).length
}

function refreshTime(credential: NormalizedCredential): number {
  if (!credential.lastRefresh) return Number.NEGATIVE_INFINITY
  const time = Date.parse(credential.lastRefresh)
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time
}

function preferredCredential(
  current: NormalizedCredential,
  candidate: NormalizedCredential
): NormalizedCredential {
  const completenessDifference = tokenCompleteness(candidate) - tokenCompleteness(current)
  if (completenessDifference > 0) return candidate
  if (completenessDifference < 0) return current
  const refreshDifference = refreshTime(candidate) - refreshTime(current)
  if (refreshDifference > 0) return candidate
  if (refreshDifference < 0) return current
  const dialectPriority: Record<CredentialDialect, number> = {
    sub2api: 4,
    codex: 3,
    cpa: 2,
    generic: 1
  }
  const dialectDifference =
    dialectPriority[candidate.sourceDialect] - dialectPriority[current.sourceDialect]
  if (dialectDifference > 0) return candidate
  if (dialectDifference < 0) return current
  return candidate
}

export function dedupeCredentials(
  credentials: readonly NormalizedCredential[]
): NormalizedCredential[] {
  const unique = new Map<string, NormalizedCredential>()
  for (const credential of credentials) {
    const key = dedupeKey(credential)
    const current = unique.get(key)
    unique.set(key, current ? preferredCredential(current, credential) : credential)
  }
  return [...unique.values()]
}
