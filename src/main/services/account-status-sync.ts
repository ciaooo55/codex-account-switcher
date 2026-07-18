import { createHash } from 'node:crypto'
import type {
  GrokCredential,
  GrokTestResult,
  NormalizedCredential,
  TestResult
} from '../../shared/types'

interface StatusStoreLike<TResult extends SyncTestResult> {
  getAll(): Promise<Record<string, TResult>>
  setMany(results: readonly TResult[]): Promise<void>
}

interface SyncTestResult {
  accountId: string
  status: string
  detail: string
  checkedAt: string
  usage: unknown | null
}

interface CredentialIdentity {
  id: string
  email: string | null
  subject: string | null
  scopeId: string | null
  accessToken: string
}

function clean(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase()
  return normalized || null
}

function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function identityKeys(identity: CredentialIdentity): { strong: string[]; weak: string[] } {
  const email = clean(identity.email)
  const subject = clean(identity.subject)
  const scope = clean(identity.scopeId)
  const strong = [
    `id:${identity.id}`,
    `token:${tokenFingerprint(identity.accessToken)}`
  ]
  if (subject && scope) strong.push(`subject-scope:${subject}\u0000${scope}`)
  if (email && scope) strong.push(`email-scope:${email}\u0000${scope}`)
  const weak: string[] = []
  if (email) weak.push(`email:${email}`)
  if (subject) weak.push(`subject:${subject}`)
  return { strong, weak }
}

interface IdentityIndex {
  keys: Map<string, Set<string>>
  values: Map<string, CredentialIdentity>
}

function buildIndex(values: readonly CredentialIdentity[]): IdentityIndex {
  const keys = new Map<string, Set<string>>()
  const identities = new Map<string, CredentialIdentity>()
  for (const value of values) {
    identities.set(value.id, value)
    const identity = identityKeys(value)
    for (const key of [...identity.strong, ...identity.weak]) {
      const ids = keys.get(key) ?? new Set<string>()
      ids.add(value.id)
      keys.set(key, ids)
    }
  }
  return { keys, values: identities }
}

function compatibleWeakIdentity(source: CredentialIdentity, target: CredentialIdentity): boolean {
  const sourceEmail = clean(source.email)
  const targetEmail = clean(target.email)
  const sourceSubject = clean(source.subject)
  const targetSubject = clean(target.subject)
  const sourceScope = clean(source.scopeId)
  const targetScope = clean(target.scopeId)
  if (sourceScope && targetScope && sourceScope !== targetScope) return false
  if (sourceEmail && targetEmail && sourceEmail !== targetEmail) return false
  if (sourceSubject && targetSubject && sourceSubject !== targetSubject) return false
  return Boolean(
    (sourceEmail && targetEmail && sourceEmail === targetEmail) ||
    (sourceSubject && targetSubject && sourceSubject === targetSubject)
  )
}

function matchingIds(
  source: CredentialIdentity,
  targetIndex: IdentityIndex
): string[] {
  const keys = identityKeys(source)
  const strong = new Set<string>()
  for (const key of keys.strong) {
    for (const id of targetIndex.keys.get(key) ?? []) strong.add(id)
  }
  if (strong.size > 0) return [...strong]

  const weak = new Set<string>()
  for (const key of keys.weak) {
    const matches = targetIndex.keys.get(key)
    if (matches?.size !== 1) continue
    const id = [...matches][0]
    const target = targetIndex.values.get(id)
    if (target && compatibleWeakIdentity(source, target)) weak.add(id)
  }
  return weak.size === 1 ? [...weak] : []
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function richerResult<TResult extends SyncTestResult>(
  left: TResult | undefined,
  right: TResult | undefined
): TResult | undefined {
  if (!left) return right
  if (!right) return left
  const timeDifference = timestamp(left.checkedAt) - timestamp(right.checkedAt)
  if (timeDifference !== 0) return timeDifference > 0 ? left : right
  if (Boolean(left.usage) !== Boolean(right.usage)) return left.usage ? left : right
  return left
}

function needsUpdate<TResult extends SyncTestResult>(current: TResult | undefined, next: TResult): boolean {
  if (!current) return true
  return current.checkedAt !== next.checkedAt ||
    current.status !== next.status ||
    current.detail !== next.detail ||
    JSON.stringify(current.usage) !== JSON.stringify(next.usage)
}

function asCodexIdentity(credential: NormalizedCredential): CredentialIdentity {
  return {
    id: credential.id,
    email: credential.email,
    subject: credential.subject,
    scopeId: credential.accountId,
    accessToken: credential.accessToken
  }
}

function asGrokIdentity(credential: GrokCredential): CredentialIdentity {
  return {
    id: credential.id,
    email: credential.email,
    subject: credential.subject,
    scopeId: credential.teamId,
    accessToken: credential.accessToken
  }
}

async function reconcile<TResult extends SyncTestResult>(
  leftCredentials: readonly CredentialIdentity[],
  rightCredentials: readonly CredentialIdentity[],
  leftStore: StatusStoreLike<TResult>,
  rightStore: StatusStoreLike<TResult>
): Promise<{ leftUpdated: number; rightUpdated: number }> {
  const [leftStatuses, rightStatuses] = await Promise.all([leftStore.getAll(), rightStore.getAll()])
  const rightIndex = buildIndex(rightCredentials)
  const leftUpdates = new Map<string, TResult>()
  const rightUpdates = new Map<string, TResult>()

  for (const left of leftCredentials) {
    const rightIds = matchingIds(left, rightIndex)
    if (rightIds.length === 0) continue
    let latest: TResult | undefined = leftStatuses[left.id]
    for (const rightId of rightIds) latest = richerResult(latest, rightStatuses[rightId])
    if (!latest) continue

    const leftResult = { ...latest, accountId: left.id }
    if (needsUpdate(leftStatuses[left.id], leftResult)) leftUpdates.set(left.id, leftResult)
    for (const rightId of rightIds) {
      const rightResult = { ...latest, accountId: rightId }
      const pending = richerResult(rightUpdates.get(rightId), rightResult) ?? rightResult
      if (needsUpdate(rightStatuses[rightId], pending)) rightUpdates.set(rightId, pending)
    }
  }

  await Promise.all([
    leftStore.setMany([...leftUpdates.values()]),
    rightStore.setMany([...rightUpdates.values()])
  ])
  return { leftUpdated: leftUpdates.size, rightUpdated: rightUpdates.size }
}

export function reconcileCodexStatuses(
  libraryCredentials: readonly NormalizedCredential[],
  cpaCredentials: readonly NormalizedCredential[],
  libraryStore: StatusStoreLike<TestResult>,
  cpaStore: StatusStoreLike<TestResult>
): Promise<{ leftUpdated: number; rightUpdated: number }> {
  return reconcile(
    libraryCredentials.map(asCodexIdentity),
    cpaCredentials.map(asCodexIdentity),
    libraryStore,
    cpaStore
  )
}

export function reconcileGrokStatuses(
  libraryCredentials: readonly GrokCredential[],
  cpaCredentials: readonly GrokCredential[],
  libraryStore: StatusStoreLike<GrokTestResult>,
  cpaStore: StatusStoreLike<GrokTestResult>
): Promise<{ leftUpdated: number; rightUpdated: number }> {
  return reconcile(
    libraryCredentials.map(asGrokIdentity),
    cpaCredentials.map(asGrokIdentity),
    libraryStore,
    cpaStore
  )
}

export function sameCodexCredential(
  left: NormalizedCredential,
  right: NormalizedCredential
): boolean {
  const rightIndex = buildIndex([asCodexIdentity(right)])
  return matchingIds(asCodexIdentity(left), rightIndex).length > 0
}

export function findMatchingCodexCredential(
  source: NormalizedCredential,
  candidates: readonly NormalizedCredential[]
): NormalizedCredential | null {
  const ids = new Set(matchingIds(asCodexIdentity(source), buildIndex(candidates.map(asCodexIdentity))))
  return candidates.find((candidate) => ids.has(candidate.id)) ?? null
}
