import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NormalizedCredential } from '../../shared/types'
import { ManagedCredentialLibrary } from './managed-library'

function credential(overrides: Partial<NormalizedCredential> = {}): NormalizedCredential {
  return {
    id: 'a'.repeat(64),
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
    sourcePath: 'external.txt',
    sourceFormat: 'txt',
    sourceDialect: 'generic',
    ...overrides
  }
}

describe('ManagedCredentialLibrary', () => {
  it('stores one normalized JSON file per deduplicated account', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'managed-library-'))
    const library = new ManagedCredentialLibrary(directory)

    const stored = await library.replace([
      credential(),
      credential({ accessToken: 'newer-access', lastRefresh: '2030-01-01T00:00:00.000Z' })
    ])

    expect(stored).toHaveLength(1)
    expect(await readdir(directory)).toEqual(['person@example.com_plus.json'])
    expect(JSON.parse(await readFile(stored[0].sourcePath, 'utf8'))).toMatchObject({
      type: 'codex',
      email: 'person@example.com',
      auth_mode: 'chatgpt',
      plan_type: 'plus',
      chatgpt_plan_type: 'plus',
      account_id: 'workspace-a',
      chatgpt_account_id: 'workspace-a',
      subject: 'user-a',
      chatgpt_user_id: 'user-a',
      access_token: 'newer-access'
    })
  })

  it('removes stale source-format files and names missing plans as unknown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'managed-library-clean-'))
    await writeFile(join(directory, 'old-import.txt'), 'legacy')
    await writeFile(join(directory, 'notes.keep'), 'preserve')
    const library = new ManagedCredentialLibrary(directory)

    const stored = await library.replace([credential({ planType: null })])

    expect((await readdir(directory)).sort()).toEqual([
      'notes.keep',
      'person@example.com_unknown.json'
    ])
    expect(stored[0]).toMatchObject({ sourceFormat: 'json', sourceDialect: 'cpa' })
  })

  it('deletes the matching account file when the account is removed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'managed-library-delete-'))
    const library = new ManagedCredentialLibrary(directory)
    await library.replace([credential()])
    await library.replace([])
    expect(await readdir(directory)).toEqual([])
  })

  it('keeps personal access token semantics in the normalized managed file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'managed-library-pat-'))
    const library = new ManagedCredentialLibrary(directory)
    const stored = await library.replace([credential({
      accessToken: 'at-personal-token',
      authKind: 'personal_access_token',
      refreshToken: null,
      idToken: null,
      canRefresh: false,
      planType: 'team'
    })])

    expect(JSON.parse(await readFile(stored[0].sourcePath, 'utf8'))).toEqual({
      type: 'codex',
      email: 'person@example.com',
      auth_mode: 'personalAccessToken',
      openai_auth_mode: 'personal_access_token',
      personal_access_token: 'at-personal-token',
      access_token: 'at-personal-token',
      account_id: 'workspace-a',
      chatgpt_account_id: 'workspace-a',
      subject: 'user-a',
      chatgpt_user_id: 'user-a',
      plan_type: 'team',
      chatgpt_plan_type: 'team'
    })
  })
})
