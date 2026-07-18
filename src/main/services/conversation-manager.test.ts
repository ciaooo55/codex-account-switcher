import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
})
