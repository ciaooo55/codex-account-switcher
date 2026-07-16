import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedCredential, TestResult } from '../../shared/types'
import { StatusStore } from '../storage/status-store'
import { CpaCodexManager } from './cpa-codex-manager'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function token(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

function result(id: string, status: TestResult['status']): TestResult {
  return {
    accountId: id,
    status,
    detail: status,
    checkedAt: new Date().toISOString(),
    httpStatus: 200,
    stage: 'usage',
    refreshed: false,
    usage: {
      planType: 'plus',
      checkedAt: new Date().toISOString(),
      windows: [{
        id: 'weekly', label: 'Codex 周额度', usedPercent: status === 'quota_exhausted_weekly' ? 100 : 20,
        remainingPercent: status === 'quota_exhausted_weekly' ? 0 : 80, resetAt: null,
        resetInSeconds: null, windowSeconds: 604_800
      }]
    }
  }
}

async function setup(statuses: TestResult['status'][] = ['valid']) {
  const root = await mkdtemp(join(tmpdir(), 'cpa-codex-manager-'))
  roots.push(root)
  const library = join(root, 'library')
  const source = join(root, 'source.json')
  const tester = { test: vi.fn(async (credential: NormalizedCredential) => result(credential.id, statuses.shift() ?? 'valid')) }
  const manager = new CpaCodexManager({
    directory: () => library,
    concurrency: () => 2,
    statusStore: new StatusStore(join(root, 'status.json')),
    tester
  })
  return { library, source, tester, manager }
}

describe('CpaCodexManager', () => {
  it('splits a multi-account file into canonical CPA Codex files without modifying the source', async () => {
    const { library, source, manager } = await setup()
    const sourceText = JSON.stringify(['one', 'two'].map((name) => ({
      type: 'codex',
      access_token: token({ sub: name, email: `${name}@example.com` }),
      refresh_token: `refresh-${name}`,
      email: `${name}@example.com`,
      plan_type: name === 'one' ? 'plus' : 'team'
    })))
    await writeFile(source, sourceText)

    const imported = await manager.importFiles([source])

    expect(imported.imported).toBe(2)
    expect(await readFile(source, 'utf8')).toBe(sourceText)
    expect((await readdir(library)).filter((name) => /^codex-.*\.json$/.test(name))).toHaveLength(2)
    expect(imported.accounts.map((item) => item.planType).sort()).toEqual(['plus', 'team'])
  })

  it('automatically disables weekly exhausted files and restores them when quota returns', async () => {
    const { library, source, manager } = await setup(['quota_exhausted_weekly', 'valid'])
    await writeFile(source, JSON.stringify({
      type: 'codex', access_token: token({ sub: 'quota', email: 'quota@example.com' }),
      refresh_token: 'refresh', email: 'quota@example.com', plan_type: 'plus'
    }))
    const imported = await manager.importFiles([source])
    const id = imported.accounts[0].id

    await manager.testAccounts([id])
    expect((await readdir(library)).some((name) => name.endsWith('.json.0'))).toBe(true)
    expect((await manager.listAccounts())[0]).toMatchObject({ disabled: true, status: 'quota_exhausted_weekly' })

    await manager.testAccounts([id])
    expect((await readdir(library)).some((name) => name.endsWith('.json.0'))).toBe(false)
    expect((await manager.listAccounts())[0]).toMatchObject({ disabled: false, status: 'valid' })
  })

  it('keeps five-hour exhausted files enabled and supports explicit batch toggles', async () => {
    const { library, source, manager } = await setup(['quota_exhausted_5h'])
    await writeFile(source, JSON.stringify({
      type: 'codex', access_token: token({ sub: 'five-hour', email: 'five@example.com' }),
      refresh_token: 'refresh', email: 'five@example.com'
    }))
    const imported = await manager.importFiles([source])
    const id = imported.accounts[0].id

    await manager.testAccounts([id])
    expect((await manager.listAccounts())[0]).toMatchObject({ disabled: false, status: 'quota_exhausted_5h' })
    expect((await manager.setEnabled([id], false)).changed).toBe(1)
    expect((await manager.listAccounts())[0].disabled).toBe(true)
    expect((await manager.setEnabled([id], true)).changed).toBe(1)
    expect((await readdir(library)).every((name) => !name.endsWith('.json.0'))).toBe(true)
  })

  it('reconciles enabled and disabled canonical duplicates into one requested file', async () => {
    const { library, source, manager } = await setup()
    await writeFile(source, JSON.stringify({
      type: 'codex', access_token: token({ sub: 'duplicate-state', email: 'duplicate-state@example.com' }),
      refresh_token: 'refresh', email: 'duplicate-state@example.com'
    }))
    const imported = await manager.importFiles([source])
    const id = imported.accounts[0].id
    const [enabled] = await readdir(library)
    await writeFile(join(library, `${enabled}.0`), await readFile(join(library, enabled), 'utf8'))

    expect((await readdir(library)).filter((name) => name.startsWith('codex-'))).toHaveLength(2)
    const toggled = await manager.setEnabled([id], false)

    expect(toggled.changed).toBeGreaterThan(0)
    expect(await readdir(library)).toEqual([`${enabled}.0`])
    expect((await manager.listAccounts())[0].disabled).toBe(true)
  })
})
