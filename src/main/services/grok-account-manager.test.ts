import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GrokCredential, GrokTestResult } from '../../shared/types'
import { GrokStatusStore } from '../storage/grok-status-store'
import { GrokAccountManager } from './grok-account-manager'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
function token(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'grok-manager-'))
  roots.push(root)
  const library = join(root, 'library')
  const source = join(root, 'source.json')
  const success = (id: string): GrokTestResult => ({
    accountId: id, status: 'valid', detail: 'ok', checkedAt: new Date().toISOString(),
    httpStatus: 200, refreshed: false, usage: null
  })
  const tester = { test: vi.fn(async (item: GrokCredential) => success(item.id)) }
  const manager = new GrokAccountManager({
    directory: () => library,
    concurrency: () => 2,
    statusStore: new GrokStatusStore(join(root, 'status.json')),
    tester
  })
  return { library, source, manager, tester }
}

describe('GrokAccountManager', () => {
  it('splits a multi-account Sub2API source into normalized one-account CPA files and skips duplicates', async () => {
    const { library, source, manager } = await setup()
    const accounts = ['one', 'two'].map((name) => ({
      platform: 'grok', type: 'oauth', credentials: {
        access_token: token({ iss: 'https://auth.x.ai', sub: name }),
        refresh_token: `refresh-${name}`, email: `${name}@example.com`, sub: name
      }
    }))
    await writeFile(source, JSON.stringify({ exported_at: new Date().toISOString(), proxies: [], accounts }))

    const first = await manager.importFiles([source])
    const second = await manager.importFiles([source])

    expect(first.imported).toBe(2)
    expect(second).toMatchObject({ imported: 0, skipped: 2 })
    const names = await readdir(library)
    expect(names).toHaveLength(2)
    expect(names.every((name) => /^grok-.*\.json$/.test(name))).toBe(true)
    const stored = JSON.parse(await readFile(join(library, names[0]), 'utf8'))
    expect(stored).toMatchObject({ type: 'xai', auth_kind: 'oauth' })
  })

  it('deletes managed files and only tests Grok accounts selected in this manager', async () => {
    const { library, source, manager, tester } = await setup()
    await writeFile(source, JSON.stringify({
      type: 'xai', access_token: token({ iss: 'https://auth.x.ai', sub: 'only-grok' }),
      refresh_token: 'refresh', email: 'only@example.com'
    }))
    const imported = await manager.importFiles([source])
    const id = imported.accounts[0].id

    await manager.testAccounts([id])
    expect(tester.test).toHaveBeenCalledTimes(1)
    const removed = await manager.deleteAccounts([id])
    expect(removed.deleted).toBe(1)
    expect(await readdir(library)).toEqual([])
    expect(await manager.listAccounts()).toEqual([])
  })
})
