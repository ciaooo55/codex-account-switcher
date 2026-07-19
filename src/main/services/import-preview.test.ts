import { describe, expect, it, vi } from 'vitest'
import type {
  GrokCredential,
  GrokTestResult,
  ImportPreviewDecision,
  NormalizedCredential,
  TestResult
} from '../../shared/types'
import type { AccountManager } from './account-manager'
import type { GrokAccountManager } from './grok-account-manager'
import { ImportPreviewService } from './import-preview'

function codex(overrides: Partial<NormalizedCredential> = {}): NormalizedCredential {
  return {
    id: 'codex-id',
    email: 'person@example.com',
    accountId: 'workspace-a',
    subject: 'user-a',
    accessToken: 'codex-access-secret',
    refreshToken: 'codex-refresh-secret',
    idToken: 'codex-id-secret',
    authKind: 'oauth',
    planType: 'plus',
    lastRefresh: null,
    accessExpiresAt: null,
    idExpiresAt: null,
    canRefresh: true,
    sourcePath: 'incoming.json',
    sourceFormat: 'json',
    sourceDialect: 'cpa',
    ...overrides
  }
}

function grok(overrides: Partial<GrokCredential> = {}): GrokCredential {
  return {
    id: 'grok-id',
    email: 'grok@example.com',
    subject: 'grok-user',
    teamId: 'grok-team',
    accessToken: 'grok-access-secret',
    refreshToken: 'grok-refresh-secret',
    idToken: 'grok-id-secret',
    tokenType: 'Bearer',
    clientId: 'grok-client',
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

describe('ImportPreviewService', () => {
  it('classifies new, duplicate, update and conflict entries without exposing credentials', async () => {
    const existing = codex({ accessToken: 'existing-access', refreshToken: 'existing-refresh', idToken: 'existing-id' })
    const codexManager = {
      listCredentials: vi.fn().mockResolvedValue([existing]),
      listAccounts: vi.fn().mockResolvedValue([]),
      importPrepared: vi.fn().mockResolvedValue({ imported: 1, skipped: 0, errors: [], accounts: [] })
    } as unknown as AccountManager
    const grokManager = {
      listCredentials: vi.fn().mockResolvedValue([]),
      listAccounts: vi.fn().mockResolvedValue([]),
      importPrepared: vi.fn().mockResolvedValue({ imported: 1, skipped: 0, errors: [], accounts: [] })
    } as unknown as GrokAccountManager
    const service = new ImportPreviewService(codexManager, grokManager)
    const duplicate = { ...existing, sourcePath: 'duplicate.json' }
    const update = codex({ id: 'codex-update', accessToken: 'updated-access' })
    const conflict = codex({ id: 'codex-conflict', subject: 'user-b', accountId: 'workspace-b', accessToken: 'conflict-access' })
    const newGrok = grok()

    const preview = await service.create(
      { credentials: [duplicate, update, conflict], errors: [], recognized: 3, sourceCount: 1 },
      { credentials: [newGrok], errors: [], recognized: 1, sourceCount: 1 }
    )

    expect(preview.items.map((item) => item.disposition)).toEqual(['duplicate', 'update', 'conflict', 'new'])
    const serialized = JSON.stringify(preview)
    for (const secret of [
      'existing-access', 'existing-refresh', 'existing-id', 'updated-access',
      'conflict-access', 'grok-access-secret', 'grok-refresh-secret', 'grok-id-secret'
    ]) expect(serialized).not.toContain(secret)

    const decisions: Record<string, ImportPreviewDecision> = Object.fromEntries(preview.items.map((item) => [
      item.key,
      item.disposition === 'update' ? 'replace' : item.disposition === 'new' ? 'add' : 'skip'
    ]))
    const result = await service.commit({ sessionId: preview.sessionId, decisions })

    expect(result).toMatchObject({ added: 1, updated: 1, ignored: 2, codexImported: 1, grokImported: 1 })
    expect(codexManager.importPrepared).toHaveBeenCalledWith(expect.objectContaining({ credentials: [update] }))
    expect(grokManager.importPrepared).toHaveBeenCalledWith(expect.objectContaining({ credentials: [newGrok] }))
    await expect(service.commit({ sessionId: preview.sessionId, decisions })).rejects.toThrow('已过期')
  })

  it('requires an explicit skip before committing unrecognized sources', async () => {
    const codexManager = {
      listCredentials: vi.fn().mockResolvedValue([]),
      listAccounts: vi.fn().mockResolvedValue([]),
      importPrepared: vi.fn()
    } as unknown as AccountManager
    const grokManager = {
      listCredentials: vi.fn().mockResolvedValue([]),
      listAccounts: vi.fn().mockResolvedValue([]),
      importPrepared: vi.fn()
    } as unknown as GrokAccountManager
    const service = new ImportPreviewService(codexManager, grokManager)
    const preview = await service.create(
      {
        credentials: [],
        errors: ['bad.txt: 未识别'],
        recognized: 0,
        sourceCount: 1,
        unrecognized: [{ sourcePath: 'bad.txt', sourceFormat: 'txt', detail: '未识别' }]
      },
      { credentials: [], errors: [], recognized: 0, sourceCount: 1, unrecognized: [] }
    )

    expect(preview.unrecognized).toHaveLength(1)
    await expect(service.commit({ sessionId: preview.sessionId, decisions: {} })).rejects.toThrow('无法识别')
    expect(codexManager.importPrepared).not.toHaveBeenCalled()

    const result = await service.commit({
      sessionId: preview.sessionId,
      decisions: {},
      skipUnrecognized: true
    })
    expect(result).toMatchObject({ imported: 0, ignored: 1, skipped: 1 })
  })

  it('tests preview credentials incrementally without writing them before commit', async () => {
    const incomingCodex = codex()
    const refreshedCodex = codex({
      accessToken: 'rotated-codex-access-secret',
      refreshToken: 'rotated-codex-refresh-secret',
      planType: 'team'
    })
    const incomingGrok = grok()
    const codexResult: TestResult = {
      accountId: incomingCodex.id,
      status: 'valid',
      detail: 'Codex 凭证有效',
      checkedAt: '2026-07-16T01:00:00.000Z',
      httpStatus: 200,
      stage: 'deep-test',
      refreshed: true,
      usage: {
        planType: 'team',
        checkedAt: '2026-07-16T01:00:00.000Z',
        windows: [{
          id: 'weekly', label: 'Codex 周额度', usedPercent: 20, remainingPercent: 80,
          resetAt: '2026-07-23T01:00:00.000Z', resetInSeconds: null, windowSeconds: 604_800
        }]
      }
    }
    const grokResult: GrokTestResult = {
      accountId: incomingGrok.id,
      status: 'quota_exhausted_weekly',
      detail: 'Grok 周额度已耗尽',
      checkedAt: '2026-07-16T01:00:01.000Z',
      httpStatus: 429,
      refreshed: false,
      usage: null
    }
    const codexManager = {
      listCredentials: vi.fn().mockResolvedValue([]),
      listAccounts: vi.fn().mockResolvedValue([]),
      importPrepared: vi.fn().mockResolvedValue({ imported: 1, skipped: 0, errors: [], accounts: [] }),
      persistImportedTestResults: vi.fn().mockResolvedValue(undefined)
    } as unknown as AccountManager
    const grokManager = {
      listCredentials: vi.fn().mockResolvedValue([]),
      listAccounts: vi.fn().mockResolvedValue([]),
      importPrepared: vi.fn().mockResolvedValue({ imported: 1, skipped: 0, errors: [], accounts: [] }),
      persistImportedTestResults: vi.fn().mockResolvedValue(undefined)
    } as unknown as GrokAccountManager
    const onProgress = vi.fn()
    const service = new ImportPreviewService(codexManager, grokManager, {
      concurrency: vi.fn().mockResolvedValue(2),
      testCodex: vi.fn().mockResolvedValue({ credential: refreshedCodex, result: codexResult }),
      testGrok: vi.fn().mockResolvedValue({ credential: incomingGrok, result: grokResult })
    })
    const preview = await service.create(
      { credentials: [incomingCodex], errors: [], recognized: 1, sourceCount: 2 },
      { credentials: [incomingGrok], errors: [], recognized: 1, sourceCount: 2 }
    )

    const tested = await service.test({ sessionId: preview.sessionId }, { onProgress })

    expect(tested).toMatchObject({ tested: 2, cancelled: false })
    expect(tested.preview.items.map((item) => item.test?.status)).toEqual(['valid', 'quota_exhausted_weekly'])
    expect(onProgress.mock.calls.filter(([value]) => value.updatedItem).map(([value]) => value.updatedItem.key)).toHaveLength(2)
    expect(codexManager.importPrepared).not.toHaveBeenCalled()
    expect(grokManager.importPrepared).not.toHaveBeenCalled()
    const serialized = JSON.stringify(tested)
    for (const secret of [
      incomingCodex.accessToken,
      incomingCodex.refreshToken,
      incomingGrok.accessToken,
      incomingGrok.refreshToken,
      refreshedCodex.accessToken,
      refreshedCodex.refreshToken
    ]) expect(serialized).not.toContain(secret)

    const decisions = Object.fromEntries(tested.preview.items.map((item) => [item.key, 'add' as const]))
    await service.commit({ sessionId: preview.sessionId, decisions })

    expect(codexManager.importPrepared).toHaveBeenCalledWith(expect.objectContaining({ credentials: [refreshedCodex] }))
    expect(grokManager.importPrepared).toHaveBeenCalledWith(expect.objectContaining({ credentials: [incomingGrok] }))
    expect(codexManager.persistImportedTestResults).toHaveBeenCalledWith([codexResult])
    expect(grokManager.persistImportedTestResults).toHaveBeenCalledWith([grokResult])
  })

  it('reparses an unrecognized pasted source only after an explicit manual mode is selected', async () => {
    const refreshed = codex({
      id: 'refined-id',
      email: 'refined@example.com',
      accessToken: 'refined-access-secret',
      refreshToken: 'refined-refresh-secret',
      idToken: 'refined-id-secret',
      sourcePath: 'pasted-refresh-token.txt',
      sourceFormat: 'paste'
    })
    const codexManager = {
      listCredentials: vi.fn().mockResolvedValue([]),
      listAccounts: vi.fn().mockResolvedValue([]),
      prepareRefreshTokens: vi.fn().mockResolvedValue({
        credentials: [refreshed],
        errors: [],
        recognized: 1,
        sourceCount: 1,
        unrecognized: []
      }),
      importPrepared: vi.fn()
    } as unknown as AccountManager
    const grokManager = {
      listCredentials: vi.fn().mockResolvedValue([]),
      listAccounts: vi.fn().mockResolvedValue([]),
      importPrepared: vi.fn()
    } as unknown as GrokAccountManager
    const service = new ImportPreviewService(codexManager, grokManager)
    const rawInput = 'plus rt.1.preview-refresh-token-value'
    const preview = await service.create(
      {
        credentials: [],
        errors: ['没有识别到凭据'],
        recognized: 0,
        sourceCount: 1,
        unrecognized: [{
          sourcePath: 'pasted-credential.json',
          sourceFormat: 'paste',
          detail: '未识别'
        }]
      },
      { credentials: [], errors: [], recognized: 0, sourceCount: 1, unrecognized: [] },
      rawInput
    )

    const refined = await service.refine({
      sessionId: preview.sessionId,
      sourceKey: preview.unrecognized[0].key,
      mode: 'codex_rt'
    })

    expect(codexManager.prepareRefreshTokens).toHaveBeenCalledWith(rawInput, 'codex')
    expect(refined).toMatchObject({ recognized: 1, unrecognized: [] })
    expect(refined.items).toHaveLength(1)
    expect(refined.items[0]).toMatchObject({
      provider: 'codex',
      email: 'refined@example.com',
      sourcePath: 'pasted-credential.json',
      sourceFormat: 'paste'
    })
    expect(codexManager.importPrepared).not.toHaveBeenCalled()
    const serialized = JSON.stringify(refined)
    for (const secret of [rawInput, 'refined-access-secret', 'refined-refresh-secret', 'refined-id-secret']) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('keeps a source unresolved when the selected parser still finds no credential', async () => {
    const codexManager = {
      listCredentials: vi.fn().mockResolvedValue([]),
      listAccounts: vi.fn().mockResolvedValue([]),
      prepareFiles: vi.fn().mockResolvedValue({
        credentials: [],
        errors: ['still-unknown.txt: 仍未识别'],
        recognized: 0,
        sourceCount: 1,
        unrecognized: [{
          sourcePath: 'still-unknown.txt',
          sourceFormat: 'txt',
          detail: '所选 Codex 方式仍未识别到凭据'
        }]
      }),
      importPrepared: vi.fn()
    } as unknown as AccountManager
    const grokManager = {
      listCredentials: vi.fn().mockResolvedValue([]),
      listAccounts: vi.fn().mockResolvedValue([]),
      importPrepared: vi.fn()
    } as unknown as GrokAccountManager
    const service = new ImportPreviewService(codexManager, grokManager)
    const preview = await service.create(
      {
        credentials: [],
        errors: [],
        recognized: 0,
        sourceCount: 1,
        unrecognized: [{ sourcePath: 'still-unknown.txt', sourceFormat: 'txt', detail: '未识别' }]
      },
      { credentials: [], errors: [], recognized: 0, sourceCount: 1, unrecognized: [] }
    )

    const refined = await service.refine({
      sessionId: preview.sessionId,
      sourceKey: preview.unrecognized[0].key,
      mode: 'codex'
    })

    expect(codexManager.prepareFiles).toHaveBeenCalledWith(['still-unknown.txt'])
    expect(refined.items).toEqual([])
    expect(refined.unrecognized).toHaveLength(1)
    expect(refined.unrecognized[0].detail).toBe('所选 Codex 方式仍未识别到凭据')
    await expect(service.commit({ sessionId: preview.sessionId, decisions: {} })).rejects.toThrow('无法识别')
  })
})
