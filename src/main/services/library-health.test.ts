import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountManager } from './account-manager'
import type { CpaCodexManager } from './cpa-codex-manager'
import type { GrokAccountManager } from './grok-account-manager'
import { AccountMetadataStore } from '../storage/account-metadata'
import { LibraryHealthService } from './library-health'
import type { GrokCredential } from '../../shared/types'

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('LibraryHealthService', () => {
  it('quarantines malformed files and removes orphan status and metadata records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-switcher-health-'))
    tempDirectories.push(root)
    const codexDirectory = join(root, 'aa', 'codex')
    const grokDirectory = join(root, 'aa', 'grok')
    const cpaDirectory = join(root, 'cpa')
    const quarantineDirectory = join(root, 'quarantine')
    await Promise.all([codexDirectory, grokDirectory, cpaDirectory].map((path) => mkdir(path, { recursive: true })))
    const malformedPath = join(codexDirectory, 'broken.json')
    await writeFile(malformedPath, '{ definitely not valid json', 'utf8')

    const accountManager = {
      listAccounts: vi.fn().mockResolvedValue([]),
      scanDirectory: vi.fn()
    } as unknown as AccountManager
    const grokManager = {
      listAccounts: vi.fn().mockResolvedValue([]),
      scanDirectory: vi.fn()
    } as unknown as GrokAccountManager
    const cpaCodexManager = {
      listAccounts: vi.fn().mockResolvedValue([]),
      scanDirectory: vi.fn()
    } as unknown as CpaCodexManager
    const cpaGrokManager = {
      listAccounts: vi.fn().mockResolvedValue([]),
      scanDirectory: vi.fn()
    } as unknown as GrokAccountManager
    const metadataStore = new AccountMetadataStore(join(root, 'metadata.json'))
    await metadataStore.update({ accountIds: ['deleted-account'], alias: '已删除账号' })
    let statuses: Record<string, unknown> = { 'deleted-account': { status: 'valid' } }
    const statusStore = {
      getAll: vi.fn(async () => ({ ...statuses })),
      removeMany: vi.fn(async (ids: string[]) => {
        for (const id of ids) delete statuses[id]
      })
    }
    const emptyStatusStore = { getAll: vi.fn(async () => ({})), removeMany: vi.fn() }
    const service = new LibraryHealthService({
      codexDirectory,
      grokDirectory,
      cpaDirectory: () => cpaDirectory,
      quarantineDirectory,
      accountManager,
      grokManager,
      cpaCodexManager,
      cpaGrokManager,
      metadataStore,
      statusStores: {
        codex: statusStore,
        grok: emptyStatusStore,
        cpaCodex: emptyStatusStore,
        cpaGrok: emptyStatusStore
      }
    })

    const report = await service.inspect()
    expect(report.scannedFiles).toBe(1)
    expect(report.issues.map((issue) => issue.kind)).toEqual(expect.arrayContaining([
      'malformed_file', 'orphan_status', 'orphan_metadata'
    ]))

    const result = await service.repair(report.snapshotId, report.issues.map((issue) => issue.id))
    expect(result.errors).toEqual([])
    expect(result.report.issues).toEqual([])
    expect(statuses).toEqual({})
    expect(await metadataStore.getAll()).toEqual({})
    await expect(readdir(codexDirectory)).resolves.toEqual([])
    expect((await readdir(join(quarantineDirectory, 'aa-codex')))[0]).toContain('broken.json')
  })

  it('moves a wrong-provider credential only after the destination manager has received it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-switcher-health-provider-'))
    tempDirectories.push(root)
    const codexDirectory = join(root, 'aa', 'codex')
    const grokDirectory = join(root, 'aa', 'grok')
    const cpaDirectory = join(root, 'cpa')
    await Promise.all([codexDirectory, grokDirectory, cpaDirectory].map((path) => mkdir(path, { recursive: true })))
    const sourcePath = join(codexDirectory, 'wrong-provider.json')
    const accessToken = `header.${Buffer.from(JSON.stringify({
      iss: 'https://auth.x.ai', sub: 'grok-user', team_id: 'team-a'
    })).toString('base64url')}.signature`
    await writeFile(sourcePath, JSON.stringify({
      type: 'xai', email: 'grok@example.com', access_token: accessToken
    }), 'utf8')
    const credential: GrokCredential = {
      id: 'grok-id', email: 'grok@example.com', subject: 'grok-user', teamId: 'team-a',
      accessToken, refreshToken: null, idToken: null, tokenType: 'Bearer', clientId: 'client',
      baseUrl: 'https://api.x.ai/v1', tokenEndpoint: 'https://auth.x.ai/oauth2/token', scope: null,
      planType: null, lastRefresh: null, expiresAt: null, sourcePath, sourceFormat: 'json',
      sourceDialect: 'cpa', billingSnapshot: null, usageSnapshot: null
    }
    const accountManager = {
      listAccounts: vi.fn().mockResolvedValue([]),
      prepareFiles: vi.fn().mockResolvedValue({ credentials: [], errors: [], recognized: 0, sourceCount: 1 }),
      importPrepared: vi.fn()
    } as unknown as AccountManager
    const grokManager = {
      listAccounts: vi.fn().mockResolvedValue([]),
      prepareFiles: vi.fn().mockResolvedValue({ credentials: [credential], errors: [], recognized: 1, sourceCount: 1 }),
      importPrepared: vi.fn(async () => {
        expect((await stat(sourcePath)).isFile()).toBe(true)
        return { imported: 1, skipped: 0, errors: [], accounts: [] }
      })
    } as unknown as GrokAccountManager
    const cpaCodexManager = { listAccounts: vi.fn().mockResolvedValue([]) } as unknown as CpaCodexManager
    const cpaGrokManager = { listAccounts: vi.fn().mockResolvedValue([]) } as unknown as GrokAccountManager
    const emptyStatusStore = { getAll: vi.fn(async () => ({})), removeMany: vi.fn() }
    const service = new LibraryHealthService({
      codexDirectory,
      grokDirectory,
      cpaDirectory: () => cpaDirectory,
      quarantineDirectory: join(root, 'quarantine'),
      accountManager,
      grokManager,
      cpaCodexManager,
      cpaGrokManager,
      metadataStore: new AccountMetadataStore(join(root, 'metadata.json')),
      statusStores: {
        codex: emptyStatusStore,
        grok: emptyStatusStore,
        cpaCodex: emptyStatusStore,
        cpaGrok: emptyStatusStore
      }
    })

    const report = await service.inspect()
    const issue = report.issues.find((item) => item.kind === 'noncanonical_file')
    expect(issue).toMatchObject({ scope: 'aa-codex', repairable: true })
    const result = await service.repair(report.snapshotId, [issue!.id])

    expect(grokManager.importPrepared).toHaveBeenCalledWith(expect.objectContaining({ credentials: [credential] }))
    await expect(stat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(result.errors).toEqual([])
  })
})
