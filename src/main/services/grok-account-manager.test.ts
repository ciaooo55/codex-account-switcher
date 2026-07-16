import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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

  it('never deletes or rewrites source files while scanning the account directory', async () => {
    const { library, manager } = await setup()
    await mkdir(library, { recursive: true })
    await writeFile(join(library, 'source-bundle.txt'), JSON.stringify({
      accounts: [
        {
          platform: 'grok',
          credentials: {
            access_token: token({ iss: 'https://auth.x.ai', sub: 'scan-one' }),
            refresh_token: 'refresh-one',
            email: 'scan-one@example.com'
          }
        },
        {
          platform: 'grok',
          credentials: {
            access_token: token({ iss: 'https://auth.x.ai', sub: 'scan-two' }),
            refresh_token: 'refresh-two',
            email: 'scan-two@example.com'
          }
        }
      ]
    }))
    await writeFile(join(library, 'grok-user-source.json'), JSON.stringify({
      type: 'xai',
      access_token: token({ iss: 'https://auth.x.ai', sub: 'scan-three' }),
      refresh_token: 'refresh-three',
      email: 'scan-three@example.com'
    }))
    const originalNames = ['source-bundle.txt', 'grok-user-source.json']
    const originals = new Map(await Promise.all(originalNames.map(async (name) => [
      name,
      await readFile(join(library, name), 'utf8')
    ] as const)))

    const result = await manager.scanDirectory()

    expect(result.accounts).toHaveLength(3)
    for (const [name, content] of originals) {
      expect(await readFile(join(library, name), 'utf8')).toBe(content)
    }
    const namesAfterSecondScan = await manager.scanDirectory().then(() => readdir(library))
    expect(namesAfterSecondScan).toEqual(expect.arrayContaining(originalNames))
    expect(namesAfterSecondScan.filter((name) => name.startsWith('grok-') && name !== 'grok-user-source.json')).toHaveLength(3)
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

  it('deletes every canonical duplicate only after an explicit delete and preserves prefixed source files', async () => {
    const { library, source, manager } = await setup()
    await writeFile(source, JSON.stringify({
      type: 'xai', access_token: token({ iss: 'https://auth.x.ai', sub: 'duplicate' }),
      refresh_token: 'refresh', email: 'duplicate@example.com'
    }))
    const imported = await manager.importFiles([source])
    const id = imported.accounts[0].id
    const [managed] = (await readdir(library)).filter((name) => name.endsWith('.json'))
    const stored = await readFile(join(library, managed), 'utf8')
    const duplicateName = managed.replace('-unknown-', '-pro-')
    await writeFile(join(library, duplicateName), stored.replace('"plan_type": null', '"plan_type": "pro"'))
    const prefixedSource = join(library, 'grok-user-backup.json')
    const prefixedContent = await readFile(source, 'utf8')
    await writeFile(prefixedSource, prefixedContent)

    const removed = await manager.deleteAccounts([id])

    expect(removed.deleted).toBe(1)
    expect(await readFile(prefixedSource, 'utf8')).toBe(prefixedContent)
    expect((await readdir(library)).filter((name) => name !== 'grok-user-backup.json')).toEqual([])
  })

  it('uses json.0 for weekly exhaustion and restores json after a valid retest', async () => {
    const { library, source, manager, tester } = await setup()
    await writeFile(source, JSON.stringify({
      type: 'xai', access_token: token({ iss: 'https://auth.x.ai', sub: 'quota-grok' }),
      refresh_token: 'refresh', email: 'quota-grok@example.com'
    }))
    const imported = await manager.importFiles([source])
    const id = imported.accounts[0].id
    tester.test
      .mockResolvedValueOnce({
        accountId: id, status: 'quota_exhausted_weekly', detail: 'weekly exhausted',
        checkedAt: new Date().toISOString(), httpStatus: 429, refreshed: false, usage: null
      })
      .mockResolvedValueOnce({
        accountId: id, status: 'valid', detail: 'valid', checkedAt: new Date().toISOString(),
        httpStatus: 200, refreshed: false, usage: null
      })

    await manager.testAccounts([id])
    expect((await readdir(library)).some((name) => name.endsWith('.json.0'))).toBe(true)
    expect((await manager.listAccounts())[0].disabled).toBe(true)

    await manager.testAccounts([id])
    expect((await readdir(library)).some((name) => name.endsWith('.json.0'))).toBe(false)
    expect((await manager.listAccounts())[0].disabled).toBe(false)
  })

  it('reconciles enabled and disabled canonical duplicates into one requested file', async () => {
    const { library, source, manager } = await setup()
    await writeFile(source, JSON.stringify({
      type: 'xai', access_token: token({ iss: 'https://auth.x.ai', sub: 'duplicate-state' }),
      refresh_token: 'refresh', email: 'duplicate-state@example.com'
    }))
    const imported = await manager.importFiles([source])
    const id = imported.accounts[0].id
    const [enabled] = await readdir(library)
    await writeFile(join(library, `${enabled}.0`), await readFile(join(library, enabled), 'utf8'))

    const toggled = await manager.setEnabled([id], false)

    expect(toggled.changed).toBeGreaterThan(0)
    expect(await readdir(library)).toEqual([`${enabled}.0`])
    expect((await manager.listAccounts())[0].disabled).toBe(true)
  })
})
