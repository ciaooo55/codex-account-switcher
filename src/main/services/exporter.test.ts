import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import type { NormalizedCredential } from '../../shared/types'
import {
  CredentialExportService,
  serializeCpaCredential,
  serializeSub2ApiBundle
} from './exporter'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function credential(overrides: Partial<NormalizedCredential> = {}): NormalizedCredential {
  return {
    id: 'account-a',
    email: 'person@example.com',
    accountId: 'workspace-a',
    subject: 'user-a',
    accessToken: 'access-secret-a',
    refreshToken: 'refresh-secret-a',
    idToken: 'id-secret-a',
    authKind: 'oauth',
    planType: 'plus',
    lastRefresh: '2026-07-15T00:00:00Z',
    accessExpiresAt: '2026-10-14T12:00:00Z',
    idExpiresAt: '2026-10-14T12:00:00Z',
    canRefresh: true,
    sourcePath: 'source.json',
    sourceFormat: 'json',
    sourceDialect: 'cpa',
    ...overrides
  }
}

describe('credential serializers', () => {
  it('writes the native flat CPA Codex shape', () => {
    expect(serializeCpaCredential(credential())).toEqual({
      type: 'codex',
      email: 'person@example.com',
      access_token: 'access-secret-a',
      refresh_token: 'refresh-secret-a',
      id_token: 'id-secret-a',
      account_id: 'workspace-a',
      chatgpt_account_id: 'workspace-a',
      plan_type: 'plus',
      chatgpt_plan_type: 'plus',
      last_refresh: '2026-07-15T00:00:00Z',
      expired: '2026-10-14T12:00:00Z'
    })
  })

  it('writes a native Sub2API v1 bundle containing multiple OpenAI OAuth accounts', () => {
    const bundle = serializeSub2ApiBundle(
      [credential(), credential({ id: 'account-b', email: 'second@example.com', subject: 'user-b' })],
      new Date('2026-07-16T00:00:00Z')
    )

    expect(bundle).toMatchObject({
      type: 'sub2api-data',
      version: 1,
      exported_at: '2026-07-16T00:00:00.000Z',
      proxies: []
    })
    expect(bundle.accounts).toHaveLength(2)
    expect(bundle.accounts[0]).toMatchObject({
      name: 'person@example.com',
      platform: 'openai',
      type: 'oauth',
      credentials: {
        access_token: 'access-secret-a',
        refresh_token: 'refresh-secret-a',
        id_token: 'id-secret-a',
        chatgpt_account_id: 'workspace-a',
        chatgpt_user_id: 'user-a',
        email: 'person@example.com',
        plan_type: 'plus',
        chatgpt_plan_type: 'plus'
      },
      extra: {
        email: 'person@example.com',
        last_refresh: '2026-07-15T00:00:00Z'
      },
      concurrency: 10,
      priority: 1,
      rate_multiplier: 1,
      auto_pause_on_expired: true
    })
  })
})

describe('CredentialExportService', () => {
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'codex-switcher-export-'))
    tempDirs.push(root)
    const outputDirectory = join(root, 'output')
    const records = [
      credential(),
      credential({
        id: 'account-b',
        email: 'second@example.com',
        subject: 'user-b',
        accessToken: 'access-secret-b',
        refreshToken: null,
        canRefresh: false
      })
    ]
    const service = new CredentialExportService({
      vault: {
        list: async () => records,
        get: async (id: string) => records.find((item) => item.id === id) ?? null
      },
      now: () => new Date('2026-07-16T01:02:03Z')
    })
    return { root, outputDirectory, service }
  }

  it('exports one CPA JSON per account without overwriting existing names', async () => {
    const fixture = await setup()
    await writeFile(join(fixture.root, 'placeholder'), '')

    const first = await fixture.service.exportAccounts({
      accountIds: ['account-a', 'account-b'],
      format: 'cpa',
      layout: 'separate',
      outputDirectory: fixture.outputDirectory
    })
    const second = await fixture.service.exportAccounts({
      accountIds: ['account-a'],
      format: 'cpa',
      layout: 'separate',
      outputDirectory: fixture.outputDirectory
    })

    expect(first.ok).toBe(true)
    expect(first.exported).toBe(2)
    expect(second.ok).toBe(true)
    expect(await readdir(fixture.outputDirectory)).toEqual([
      'codex-person@example.com-2.json',
      'codex-person@example.com.json',
      'codex-second@example.com.json'
    ])
    expect(JSON.parse(await readFile(first.files[0], 'utf8'))).toMatchObject({
      type: 'codex',
      email: 'person@example.com'
    })
    expect(JSON.stringify(first)).not.toContain('access-secret')
  })

  it('exports a CPA ZIP whose entries are standard flat account JSON files', async () => {
    const fixture = await setup()
    const result = await fixture.service.exportAccounts({
      accountIds: ['account-a', 'account-b'],
      format: 'cpa',
      layout: 'bundle',
      outputDirectory: fixture.outputDirectory
    })

    expect(result.ok).toBe(true)
    expect(result.files).toHaveLength(1)
    const entries = unzipSync(new Uint8Array(await readFile(result.files[0])))
    expect(Object.keys(entries).sort()).toEqual([
      'codex-person@example.com.json',
      'codex-second@example.com.json'
    ])
    expect(JSON.parse(strFromU8(entries['codex-person@example.com.json']))).toMatchObject({
      type: 'codex',
      account_id: 'workspace-a'
    })
  })

  it('exports one merged Sub2API file and rejects unknown account ids', async () => {
    const fixture = await setup()
    const result = await fixture.service.exportAccounts({
      accountIds: ['account-a', 'account-b'],
      format: 'sub2api',
      layout: 'bundle',
      outputDirectory: fixture.outputDirectory
    })
    const payload = JSON.parse(await readFile(result.files[0], 'utf8'))

    expect(payload.type).toBe('sub2api-data')
    expect(payload.accounts).toHaveLength(2)
    await expect(
      fixture.service.exportAccounts({
        accountIds: ['missing'],
        format: 'cpa',
        layout: 'separate',
        outputDirectory: fixture.outputDirectory
      })
    ).rejects.toThrow('账号不存在')
  })
})
