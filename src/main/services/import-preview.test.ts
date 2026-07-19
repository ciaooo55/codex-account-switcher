import { describe, expect, it, vi } from 'vitest'
import type { GrokCredential, ImportPreviewDecision, NormalizedCredential } from '../../shared/types'
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
