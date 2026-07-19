import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AccountMetadataStore } from './account-metadata'

const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createStore(): Promise<{ path: string; store: AccountMetadataStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-switcher-metadata-'))
  tempDirectories.push(directory)
  const path = join(directory, 'account-metadata.json')
  return { path, store: new AccountMetadataStore(path) }
}

describe('AccountMetadataStore', () => {
  it('persists aliases, groups, tags and notes independently from credentials', async () => {
    const fixture = await createStore()

    await fixture.store.update({
      accountIds: ['account-a'],
      alias: '  主力 Team  ',
      group: '日常',
      tags: ['稳定', 'stable', '稳定'],
      tagMode: 'replace',
      note: '只保存在本机'
    })

    expect(fixture.store.decorate({ id: 'account-a', email: 'person@example.com' })).toMatchObject({
      alias: '主力 Team',
      group: '日常',
      tags: ['稳定', 'stable'],
      note: '只保存在本机'
    })
    const reloaded = new AccountMetadataStore(fixture.path)
    expect((await reloaded.getAll())['account-a']).toMatchObject({ alias: '主力 Team', group: '日常' })
    expect(await readFile(fixture.path, 'utf8')).not.toContain('person@example.com')
  })

  it('supports additive and subtractive batch tags and removes empty entries', async () => {
    const fixture = await createStore()
    await fixture.store.update({ accountIds: ['a', 'b'], tags: ['待复查'], tagMode: 'add', group: '临时' })
    await fixture.store.update({ accountIds: ['a'], tags: ['高优先级'], tagMode: 'add' })
    await fixture.store.update({ accountIds: ['a', 'b'], tags: ['待复查'], tagMode: 'remove' })

    expect(fixture.store.peek('a').tags).toEqual(['高优先级'])
    expect(fixture.store.peek('b').tags).toEqual([])
    await fixture.store.update({ accountIds: ['b'], group: '', tags: [], tagMode: 'replace' })
    expect((await fixture.store.getAll())['b']).toBeUndefined()
  })
})
