import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TestResult } from '../../shared/types'
import { StatusStore } from './status-store'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function result(accountId: string): TestResult {
  return {
    accountId,
    status: 'valid',
    detail: '正常可用',
    checkedAt: '2026-07-16T00:00:00.000Z',
    httpStatus: 200,
    stage: 'deep-test',
    refreshed: false,
    usage: null
  }
}

describe('StatusStore', () => {
  it('retains every result written concurrently by batch-test workers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-switcher-status-'))
    tempDirs.push(dir)
    const store = new StatusStore(join(dir, 'status.json'))
    const results = Array.from({ length: 24 }, (_, index) => result(`account-${index}`))

    await Promise.all(results.map((item) => store.set(item)))

    expect(Object.keys(await store.getAll()).sort()).toEqual(
      results.map((item) => item.accountId).sort()
    )
  })

  it('orders removals with pending writes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-switcher-status-'))
    tempDirs.push(dir)
    const store = new StatusStore(join(dir, 'status.json'))

    await Promise.all([store.set(result('account-a')), store.set(result('account-b'))])
    await Promise.all([store.removeMany(['account-a']), store.set(result('account-c'))])

    expect(Object.keys(await store.getAll()).sort()).toEqual(['account-b', 'account-c'])
  })

  it('ignores malformed individual status entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-switcher-status-'))
    tempDirs.push(dir)
    const path = join(dir, 'status.json')
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        entries: {
          'account-a': result('account-a'),
          broken: { accountId: 'broken', status: 'valid', usage: {} }
        }
      }),
      'utf8'
    )

    expect(Object.keys(await new StatusStore(path).getAll())).toEqual(['account-a'])
  })
})
