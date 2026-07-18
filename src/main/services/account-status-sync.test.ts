import { describe, expect, it } from 'vitest'
import type {
  GrokCredential,
  GrokTestResult,
  NormalizedCredential,
  TestResult,
  UsageSummary
} from '../../shared/types'
import {
  findMatchingCodexCredential,
  reconcileCodexStatuses,
  reconcileGrokStatuses
} from './account-status-sync'

class MemoryStore<TResult extends TestResult | GrokTestResult> {
  constructor(private values: Record<string, TResult> = {}) {}

  async getAll(): Promise<Record<string, TResult>> {
    return structuredClone(this.values)
  }

  async setMany(results: readonly TResult[]): Promise<void> {
    for (const result of results) this.values[result.accountId] = structuredClone(result)
  }
}

function codexCredential(overrides: Partial<NormalizedCredential> = {}): NormalizedCredential {
  return {
    id: 'local-id',
    email: 'person@example.com',
    accountId: 'workspace-a',
    subject: 'user-a',
    accessToken: 'access-a',
    refreshToken: 'refresh-a',
    idToken: 'id-a',
    authKind: 'oauth',
    planType: 'plus',
    lastRefresh: null,
    accessExpiresAt: null,
    idExpiresAt: null,
    canRefresh: true,
    sourcePath: 'local.json',
    sourceFormat: 'json',
    sourceDialect: 'codex',
    ...overrides
  }
}

function grokCredential(overrides: Partial<GrokCredential> = {}): GrokCredential {
  return {
    id: 'local-grok-id',
    email: 'grok@example.com',
    subject: 'grok-user',
    teamId: 'team-a',
    accessToken: 'grok-access-a',
    refreshToken: 'grok-refresh-a',
    idToken: null,
    tokenType: 'Bearer',
    clientId: 'grok-cli',
    baseUrl: 'https://api.x.ai/v1',
    tokenEndpoint: 'https://auth.x.ai/oauth2/token',
    scope: null,
    planType: 'supergrok',
    lastRefresh: null,
    expiresAt: null,
    sourcePath: 'grok.json',
    sourceFormat: 'json',
    sourceDialect: 'cpa',
    billingSnapshot: null,
    usageSnapshot: null,
    ...overrides
  }
}

function usage(remainingPercent: number): UsageSummary {
  return {
    planType: 'plus',
    checkedAt: '2026-07-19T01:00:00Z',
    windows: [{
      id: 'weekly',
      label: 'Codex 周额度',
      usedPercent: 100 - remainingPercent,
      remainingPercent,
      resetAt: '2026-07-23T00:00:00Z',
      resetInSeconds: null,
      windowSeconds: 604_800
    }]
  }
}

function codexResult(accountId: string, checkedAt: string, remainingPercent: number): TestResult {
  return {
    accountId,
    status: remainingPercent === 0 ? 'quota_exhausted_weekly' : 'valid',
    detail: remainingPercent === 0 ? '周额度耗尽' : '正常可用',
    checkedAt,
    httpStatus: 200,
    stage: 'usage',
    refreshed: false,
    usage: usage(remainingPercent)
  }
}

function grokResult(accountId: string, checkedAt: string, remainingPercent: number): GrokTestResult {
  const result = codexResult(accountId, checkedAt, remainingPercent)
  return {
    accountId,
    status: result.status === 'valid' ? 'valid' : 'quota_exhausted_weekly',
    detail: result.detail,
    checkedAt,
    httpStatus: result.httpStatus,
    refreshed: false,
    usage: result.usage
  }
}

describe('account status reconciliation', () => {
  it('copies the newest Codex status and quota to both libraries using a token fingerprint', async () => {
    const local = codexCredential()
    const cpa = codexCredential({ id: 'cpa-id', sourcePath: 'cpa.json' })
    const localStore = new MemoryStore<TestResult>({
      [local.id]: codexResult(local.id, '2026-07-19T00:00:00Z', 80)
    })
    const cpaStore = new MemoryStore<TestResult>({
      [cpa.id]: codexResult(cpa.id, '2026-07-19T01:00:00Z', 0)
    })

    await reconcileCodexStatuses([local], [cpa], localStore, cpaStore)

    expect((await localStore.getAll())[local.id]).toMatchObject({
      accountId: local.id,
      status: 'quota_exhausted_weekly',
      usage: { windows: [{ remainingPercent: 0 }] }
    })
    expect((await cpaStore.getAll())[cpa.id].accountId).toBe(cpa.id)
  })

  it('synchronizes changed quota content even when timestamps and status are identical', async () => {
    const local = codexCredential()
    const cpa = codexCredential({ id: 'cpa-id' })
    const checkedAt = '2026-07-19T01:00:00Z'
    const localStore = new MemoryStore<TestResult>({
      [local.id]: codexResult(local.id, checkedAt, 60)
    })
    const cpaStore = new MemoryStore<TestResult>({
      [cpa.id]: codexResult(cpa.id, checkedAt, 30)
    })

    await reconcileCodexStatuses([local], [cpa], localStore, cpaStore)

    expect((await cpaStore.getAll())[cpa.id].usage?.windows[0].remainingPercent).toBe(60)
  })

  it('does not merge equal emails from different Codex workspaces', async () => {
    const local = codexCredential({ accessToken: 'local-token', accountId: 'workspace-a' })
    const cpa = codexCredential({ id: 'cpa-id', accessToken: 'cpa-token', accountId: 'workspace-b' })
    const localStore = new MemoryStore<TestResult>({
      [local.id]: codexResult(local.id, '2026-07-19T01:00:00Z', 50)
    })
    const cpaStore = new MemoryStore<TestResult>()

    await reconcileCodexStatuses([local], [cpa], localStore, cpaStore)

    expect(await cpaStore.getAll()).toEqual({})
  })

  it('matches an active Codex auth file by subject and workspace after its access token changes', () => {
    const stored = codexCredential({ accessToken: 'old-token' })
    const active = codexCredential({ id: 'active-id', accessToken: 'new-token', sourcePath: 'auth.json' })

    expect(findMatchingCodexCredential(active, [stored])?.id).toBe(stored.id)
  })

  it('synchronizes Grok status by exact token but rejects conflicting teams for weak matches', async () => {
    const local = grokCredential()
    const cpa = grokCredential({ id: 'cpa-grok-id', sourcePath: 'cpa-grok.json' })
    const localStore = new MemoryStore<GrokTestResult>()
    const cpaStore = new MemoryStore<GrokTestResult>({
      [cpa.id]: grokResult(cpa.id, '2026-07-19T01:00:00Z', 45)
    })

    await reconcileGrokStatuses([local], [cpa], localStore, cpaStore)
    expect((await localStore.getAll())[local.id].usage?.windows[0].remainingPercent).toBe(45)

    const otherTeam = grokCredential({
      id: 'other-team-id',
      accessToken: 'other-token',
      teamId: 'team-b'
    })
    const isolatedStore = new MemoryStore<GrokTestResult>()
    await reconcileGrokStatuses([local], [otherTeam], localStore, isolatedStore)
    expect(await isolatedStore.getAll()).toEqual({})
  })
})
