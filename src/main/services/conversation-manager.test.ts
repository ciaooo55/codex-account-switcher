import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationManager } from './conversation-manager'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function createHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codex-conversations-'))
  roots.push(root)
  const home = join(root, '.codex')
  await mkdir(join(home, 'sessions', '2026'), { recursive: true })
  await mkdir(join(home, 'archived_sessions'), { recursive: true })
  return home
}

function lines(id: string, title: string, provider = 'openai'): string {
  return [
    JSON.stringify({
      timestamp: '2026-07-15T00:00:00Z',
      type: 'session_meta',
      payload: { id, cwd: `C:/work/${id}`, model_provider: provider }
    }),
    JSON.stringify({
      timestamp: '2026-07-15T00:00:01Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: title }
    }),
    JSON.stringify({
      timestamp: '2026-07-15T00:00:02Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: `answer for ${id}` }
    })
  ].join('\n') + '\n'
}

describe('ConversationManager', () => {
  it('indexes summaries, searches without returning bodies and loads one detail on demand', async () => {
    const home = await createHome()
    await writeFile(join(home, 'sessions', '2026', 'rollout-one.jsonl'), lines('thread-one', '修复账号切换', 'custom'))
    await writeFile(join(home, 'archived_sessions', 'rollout-two.jsonl'), lines('thread-two', 'quota history'))
    const manager = new ConversationManager(home)

    const all = await manager.list('', 0, 100)
    const searched = await manager.list('修复', 0, 100)
    const detail = await manager.detail('thread-one')

    expect(all).toMatchObject({ total: 2, hasMore: false })
    expect(all.items.find((item) => item.id === 'thread-two')?.archived).toBe(true)
    expect(searched.items.map((item) => item.id)).toEqual(['thread-one'])
    expect(detail.messages.map((message) => [message.role, message.text])).toEqual([
      ['user', '修复账号切换'],
      ['assistant', 'answer for thread-one']
    ])
  })

  it('paginates hundreds of conversations and skips large non-message payloads', async () => {
    const home = await createHome()
    const directory = join(home, 'sessions', '2026')
    await Promise.all(Array.from({ length: 205 }, (_, index) =>
      writeFile(join(directory, `rollout-${index}.jsonl`), lines(`thread-${index}`, `conversation ${index}`))
    ))
    await writeFile(
      join(directory, 'rollout-large.jsonl'),
      `${lines('thread-large', 'large conversation')}${JSON.stringify({ type: 'tool_output', payload: 'x'.repeat(2_000_000) })}\n`
    )
    const manager = new ConversationManager(home)

    const first = await manager.list('', 0, 200)
    const second = await manager.list('', 200, 200)
    const detail = await manager.detail('thread-large')

    expect(first).toMatchObject({ total: 206, hasMore: true })
    expect(second.items).toHaveLength(6)
    expect(detail.messages).toHaveLength(2)
    expect(detail.truncated).toBe(false)
  })

  it('moves selected rollouts to trash and removes Codex index records', async () => {
    const home = await createHome()
    const activePath = join(home, 'sessions', '2026', 'rollout-one.jsonl')
    const archivedPath = join(home, 'archived_sessions', 'rollout-one-copy.jsonl')
    await writeFile(activePath, lines('thread-one', 'delete this conversation'))
    await writeFile(archivedPath, lines('thread-one', 'delete archived copy'))
    await writeFile(join(home, 'sessions', '2026', 'rollout-two.jsonl'), lines('thread-two', 'keep this conversation'))
    await writeFile(
      join(home, 'session_index.jsonl'),
      `${JSON.stringify({ id: 'thread-one', thread_name: 'delete me' })}\n${JSON.stringify({ id: 'thread-two', thread_name: 'keep me' })}\n`
    )
    await writeFile(
      join(home, '.codex-global-state.json'),
      `${JSON.stringify({
        'projectless-thread-ids': ['thread-one', 'thread-two'],
        'thread-project-assignments': { 'thread-one': 'project-a', 'thread-two': 'project-b' },
        'electron-persisted-atom-state': {
          'thread-browser-tabs-v1:thread-one': ['tab-a'],
          'thread-descriptions-v1': { 'thread-one': 'delete me', 'thread-two': 'keep me' }
        }
      })}\n`
    )

    const statePath = join(home, 'state_5.sqlite')
    const stateDb = new DatabaseSync(statePath)
    stateDb.exec(`
      CREATE TABLE threads (id TEXT PRIMARY KEY);
      CREATE TABLE thread_dynamic_tools (thread_id TEXT);
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
      CREATE TABLE agent_job_items (assigned_thread_id TEXT, status TEXT, updated_at INTEGER, last_error TEXT);
      INSERT INTO threads VALUES ('thread-one'), ('thread-two');
      INSERT INTO thread_dynamic_tools VALUES ('thread-one'), ('thread-two');
      INSERT INTO thread_spawn_edges VALUES ('thread-one', 'thread-two');
      INSERT INTO agent_job_items VALUES ('thread-one', 'running', 0, NULL);
    `)
    stateDb.close()

    const logsDb = new DatabaseSync(join(home, 'logs_2.sqlite'))
    logsDb.exec(`CREATE TABLE logs (thread_id TEXT); INSERT INTO logs VALUES ('thread-one'), ('thread-two');`)
    logsDb.close()

    await mkdir(join(home, 'sqlite'), { recursive: true })
    const catalogDb = new DatabaseSync(join(home, 'sqlite', 'codex-dev.db'))
    catalogDb.exec(`CREATE TABLE local_thread_catalog (thread_id TEXT); INSERT INTO local_thread_catalog VALUES ('thread-one'), ('thread-two');`)
    catalogDb.close()

    const manager = new ConversationManager(home)
    const trashed: string[] = []
    const result = await manager.delete(['thread-one'], async (path) => {
      trashed.push(path)
      await rm(path, { force: true })
    })

    expect(result).toMatchObject({ deleted: 1, failed: 0, deletedIds: ['thread-one'] })
    expect(result.indexEntriesChanged).toBeGreaterThan(0)
    expect(trashed.sort()).toEqual([activePath, archivedPath].sort())
    await expect(stat(activePath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(archivedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await manager.list('', 0, 100, true)).items.map((item) => item.id)).toEqual(['thread-two'])

    const sessionIndex = await readFile(join(home, 'session_index.jsonl'), 'utf8')
    expect(sessionIndex).not.toContain('thread-one')
    expect(sessionIndex).toContain('thread-two')
    const globalState = JSON.parse(await readFile(join(home, '.codex-global-state.json'), 'utf8'))
    expect(globalState['projectless-thread-ids']).toEqual(['thread-two'])
    expect(globalState['electron-persisted-atom-state']['codex-writing-block-deleted-thread-v1:thread-one']).toBe(true)

    const checkedState = new DatabaseSync(statePath, { readOnly: true })
    expect(checkedState.prepare('SELECT id FROM threads ORDER BY id').all()).toEqual([{ id: 'thread-two' }])
    expect(checkedState.prepare('SELECT thread_id FROM thread_dynamic_tools ORDER BY thread_id').all()).toEqual([{ thread_id: 'thread-two' }])
    expect(checkedState.prepare('SELECT COUNT(*) AS count FROM thread_spawn_edges').get()).toEqual({ count: 0 })
    expect(checkedState.prepare('SELECT assigned_thread_id, status FROM agent_job_items').get()).toEqual({ assigned_thread_id: null, status: 'pending' })
    checkedState.close()

    const checkedLogs = new DatabaseSync(join(home, 'logs_2.sqlite'), { readOnly: true })
    expect(checkedLogs.prepare('SELECT thread_id FROM logs ORDER BY thread_id').all()).toEqual([{ thread_id: 'thread-two' }])
    checkedLogs.close()
    const checkedCatalog = new DatabaseSync(join(home, 'sqlite', 'codex-dev.db'), { readOnly: true })
    expect(checkedCatalog.prepare('SELECT thread_id FROM local_thread_catalog ORDER BY thread_id').all()).toEqual([{ thread_id: 'thread-two' }])
    checkedCatalog.close()
  })

  it('keeps indexes when a rollout cannot be moved to trash', async () => {
    const home = await createHome()
    const path = join(home, 'sessions', '2026', 'rollout-one.jsonl')
    await writeFile(path, lines('thread-one', 'cannot delete'))
    const statePath = join(home, 'state_5.sqlite')
    const db = new DatabaseSync(statePath)
    db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY); INSERT INTO threads VALUES ('thread-one');`)
    db.close()
    const manager = new ConversationManager(home)

    const result = await manager.delete(['thread-one'], async () => {
      throw new Error('recycle bin unavailable')
    })

    expect(result).toMatchObject({ deleted: 0, failed: 1, deletedIds: [] })
    expect(result.errors[0]).toContain('recycle bin unavailable')
    expect((await stat(path)).isFile()).toBe(true)
    const checked = new DatabaseSync(statePath, { readOnly: true })
    expect(checked.prepare('SELECT COUNT(*) AS count FROM threads').get()).toEqual({ count: 1 })
    checked.close()
  })
})
