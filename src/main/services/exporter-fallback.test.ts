import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedCredential } from '../../shared/types'

const linkMock = vi.hoisted(() => vi.fn())

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, link: linkMock }
})

import { CredentialExportService } from './exporter'

const tempDirs: string[] = []

afterEach(async () => {
  linkMock.mockReset()
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('CredentialExportService filesystem fallback', () => {
  it('uses exclusive copy when the destination filesystem rejects hard links', async () => {
    linkMock.mockRejectedValue(Object.assign(new Error('hard links unsupported'), { code: 'EPERM' }))
    const root = await mkdtemp(join(tmpdir(), 'codex-switcher-export-fallback-'))
    tempDirs.push(root)
    const credential: NormalizedCredential = {
      id: 'account-a',
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
      sourcePath: 'source.json',
      sourceFormat: 'json',
      sourceDialect: 'cpa'
    }
    const service = new CredentialExportService({
      vault: {
        list: async () => [credential],
        get: async () => credential
      }
    })

    const exported = await service.exportAccounts({
      accountIds: [credential.id],
      format: 'cpa',
      layout: 'separate',
      outputDirectory: join(root, 'output')
    })

    expect(linkMock).toHaveBeenCalledTimes(1)
    expect(exported.ok).toBe(true)
    expect(JSON.parse(await readFile(exported.files[0], 'utf8'))).toMatchObject({
      access_token: 'access-a'
    })
  })
})
