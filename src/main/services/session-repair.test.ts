import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRepairService } from './session-repair'

const temporaryHomes: string[] = []

async function createHome(provider = 'custom'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codex-session-repair-'))
  const home = join(root, '.codex')
  temporaryHomes.push(root)
  await mkdir(join(home, 'sessions', '2026'), { recursive: true })
  await mkdir(join(home, 'archived_sessions'), { recursive: true })
  await writeFile(home + '/config.toml', `model_provider = "${provider}"\n`, 'utf8')
  return home
}

async function writeRollout(
  home: string,
  name: string,
  provider: string,
  id = 'thread-1',
  cwd = '\\\\?\\C:\\workspace'
): Promise<string> {
  const path = join(home, 'sessions', '2026', name)
  await writeFile(
    path,
    [
      JSON.stringify({
        timestamp: '2026-07-15T00:00:00Z',
        type: 'session_meta',
        payload: { id, cwd, model_provider: provider }
      }),
      JSON.stringify({
        timestamp: '2026-07-15T00:00:01Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'keep this exact content' }
      })
    ].join('\n') + '\n',
    'utf8'
  )
  return path
}

function createStateDb(home: string, provider = 'openai', rolloutPath?: string): string {
  const path = join(home, 'state_5.sqlite')
  const db = new DatabaseSync(path)
  db.exec(
    'CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, has_user_event INTEGER, first_user_message TEXT, thread_source TEXT, cwd TEXT)'
  )
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    'thread-1',
    rolloutPath ? relative(home, rolloutPath).replaceAll('\\', '/') : null,
    provider,
    0,
    'keep this exact content',
    '',
    'C:/old'
  )
  db.close()
  return path
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporaryHomes.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('SessionRepairService', () => {
  it('previews and synchronizes rollout metadata, SQLite visibility and workspace paths', async () => {
    const home = await createHome('custom')
    const rollout = await writeRollout(home, 'rollout-one.jsonl', 'openai')
    const originalMtime = (await stat(rollout)).mtimeMs
    const dbPath = createStateDb(home, 'openai', rollout)
    await writeFile(
      join(home, '.codex-global-state.json'),
      JSON.stringify({
        'electron-saved-workspace-roots': ['\\\\?\\C:\\workspace', 'C:/workspace'],
        'project-order': ['\\\\?\\C:\\workspace'],
        'active-workspace-roots': '\\\\?\\C:\\workspace'
      }),
      'utf8'
    )
    const service = new SessionRepairService({
      codexHome: home,
      backupRetention: 3
    })

    const preview = await service.preview('custom')

    expect(preview).toMatchObject({
      targetProvider: 'custom',
      scannedSessionFiles: 1,
      changedSessionFiles: 1,
      sqliteProviderRows: 1,
      sqliteUserEventRows: 1,
      sqliteCwdRows: 1
    })
    const result = await service.apply(preview.snapshotId, 'custom')
    expect(result.ok).toBe(true)
    expect(result.backupPath).toBeTruthy()

    const lines = (await readFile(rollout, 'utf8')).trim().split('\n')
    expect(JSON.parse(lines[0]).payload.model_provider).toBe('custom')
    expect(JSON.parse(lines[1]).payload.message).toBe('keep this exact content')
    expect((await stat(rollout)).mtimeMs).toBeCloseTo(originalMtime, -2)

    const db = new DatabaseSync(dbPath)
    expect(db.prepare('SELECT model_provider, has_user_event, thread_source, cwd FROM threads').get()).toEqual({
      model_provider: 'custom',
      has_user_event: 1,
      thread_source: 'user',
      cwd: 'C:/workspace'
    })
    db.close()
    const state = JSON.parse(await readFile(join(home, '.codex-global-state.json'), 'utf8'))
    expect(state['electron-saved-workspace-roots']).toEqual(['C:/workspace'])
    expect(state['active-workspace-roots']).toBe('C:/workspace')
  })

  it('scans archived sessions and warns about cross-provider encrypted content', async () => {
    const home = await createHome('custom')
    const archived = join(home, 'archived_sessions', 'rollout-archived.jsonl')
    await writeFile(
      archived,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'old', model_provider: 'openai' } })}\n${JSON.stringify({ encrypted_content: 'opaque' })}\n`,
      'utf8'
    )
    const service = new SessionRepairService({ codexHome: home })

    const preview = await service.preview('custom')

    expect(preview.changedSessionFiles).toBe(1)
    expect(preview.encryptedContentFiles).toBe(1)
    expect(preview.encryptedContentProviders).toEqual(['openai'])
  })

  it('reports each visible repair stage so the UI can show real progress', async () => {
    const home = await createHome('custom')
    const rollout = await writeRollout(home, 'rollout-progress.jsonl', 'openai')
    createStateDb(home, 'openai', rollout)
    const progress: Array<{ done: number; total: number; message: string }> = []
    const service = new SessionRepairService({
      codexHome: home,
      onProgress: (event) => progress.push(event)
    })
    const preview = await service.preview('custom')

    await expect(service.apply(preview.snapshotId, 'custom')).resolves.toMatchObject({ ok: true })
    expect(progress.map((event) => event.done)).toEqual([1, 2, 3, 4, 5, 6])
    expect(progress.every((event) => event.total === 6)).toBe(true)
    expect(progress.at(-1)?.message).toContain('复检通过')
  })

  it('does not warn when encrypted content already belongs to the target provider', async () => {
    const home = await createHome('openai')
    const archived = join(home, 'archived_sessions', 'rollout-current.jsonl')
    await writeFile(
      archived,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'old', model_provider: 'openai' } })}\n${JSON.stringify({ encrypted_content: 'opaque' })}\n`,
      'utf8'
    )
    const service = new SessionRepairService({ codexHome: home })

    const preview = await service.preview('openai')

    expect(preview.encryptedContentFiles).toBe(0)
    expect(preview.encryptedContentProviders).toEqual([])
  })

  it('aborts when Codex data changes after preview', async () => {
    const home = await createHome('custom')
    const rollout = await writeRollout(home, 'rollout-changing.jsonl', 'openai')
    const service = new SessionRepairService({ codexHome: home })
    const preview = await service.preview('custom')
    await writeFile(rollout, `${await readFile(rollout, 'utf8')}\n`, 'utf8')

    const result = await service.apply(preview.snapshotId, 'custom')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('发生变化')
    expect((await readFile(rollout, 'utf8')).includes('"model_provider":"openai"')).toBe(true)
  })

  it('repairs without requiring Codex process state', async () => {
    const home = await createHome('custom')
    await writeRollout(home, 'rollout-running.jsonl', 'openai')
    const service = new SessionRepairService({ codexHome: home })
    const preview = await service.preview('custom')

    await expect(service.apply(preview.snapshotId, 'custom')).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining('复检通过')
    })
  })

  it('clears a stale repair lock left by an interrupted repair', async () => {
    const home = await createHome('custom')
    await writeRollout(home, 'rollout-stale-lock.jsonl', 'openai')
    const lockPath = join(home, 'tmp', 'account-switcher-provider-sync.lock')
    await mkdir(lockPath, { recursive: true })
    const stale = new Date(Date.now() - 31 * 60 * 1000)
    await utimes(lockPath, stale, stale)
    const service = new SessionRepairService({ codexHome: home })
    const preview = await service.preview('custom')

    await expect(service.apply(preview.snapshotId, 'custom')).resolves.toMatchObject({ ok: true })
  })

  it('rewrites every session_meta record in a selected current conversation', async () => {
    const home = await createHome('custom')
    const rollout = join(home, 'sessions', '2026', 'rollout-repeated-meta.jsonl')
    await writeFile(
      rollout,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'thread-repeated', model_provider: 'openai' } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'keep' } }),
        JSON.stringify({ type: 'session_meta', payload: { id: 'thread-repeated', model_provider: 'stale' } })
      ].join('\n') + '\n',
      'utf8'
    )
    const service = new SessionRepairService({ codexHome: home })

    const preview = await service.preview('custom', ['thread-repeated'])
    const result = await service.apply(preview.snapshotId, 'custom', ['thread-repeated'])
    const providers = (await readFile(rollout, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((line) => line.type === 'session_meta')
      .map((line) => line.payload.model_provider)

    expect(result.ok).toBe(true)
    expect(providers).toEqual(['custom', 'custom'])
  })

  it('synchronizes only selected conversations and leaves other SQLite rows unchanged', async () => {
    const home = await createHome('custom')
    const first = await writeRollout(home, 'rollout-first.jsonl', 'custom', 'thread-first')
    const second = await writeRollout(home, 'rollout-second.jsonl', 'custom', 'thread-second')
    const dbPath = join(home, 'state_5.sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, model_provider TEXT, has_user_event INTEGER, cwd TEXT)')
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(
      'thread-first',
      relative(home, first).replaceAll('\\', '/'),
      'custom',
      0,
      'C:/old'
    )
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?)').run(
      'thread-second',
      relative(home, second).replaceAll('\\', '/'),
      'custom',
      0,
      'C:/old'
    )
    db.close()
    const service = new SessionRepairService({ codexHome: home })

    const preview = await service.preview('openai', ['thread-first'])
    const result = await service.apply(preview.snapshotId, 'openai', ['thread-first'])

    expect(preview).toMatchObject({ scannedSessionFiles: 1, changedSessionFiles: 1, sqliteProviderRows: 1 })
    expect(result.ok).toBe(true)
    expect(JSON.parse((await readFile(first, 'utf8')).split('\n')[0]).payload.model_provider).toBe('openai')
    expect(JSON.parse((await readFile(second, 'utf8')).split('\n')[0]).payload.model_provider).toBe('custom')
    const checked = new DatabaseSync(dbPath, { readOnly: true })
    expect(checked.prepare('SELECT id, model_provider FROM threads ORDER BY id').all()).toEqual([
      { id: 'thread-first', model_provider: 'openai' },
      { id: 'thread-second', model_provider: 'custom' }
    ])
    checked.close()
  })

  it('rewrites large rollouts without changing their conversation payload', async () => {
    const home = await createHome('custom')
    const path = join(home, 'sessions', '2026', 'rollout-large.jsonl')
    const payload = JSON.stringify({ type: 'tool_output', payload: 'x'.repeat(4_000_000) })
    await writeFile(path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'large', model_provider: 'openai' } })}\n${payload}\n`)
    const service = new SessionRepairService({ codexHome: home })

    const preview = await service.preview('custom')
    const result = await service.apply(preview.snapshotId, 'custom')
    const text = await readFile(path, 'utf8')

    expect(result.ok).toBe(true)
    expect(JSON.parse(text.split('\n')[0]).payload.model_provider).toBe('custom')
    expect(text).toContain(payload)
  })

  it('rolls rollout and SQLite back when a later stage fails', async () => {
    const home = await createHome('custom')
    const rollout = await writeRollout(home, 'rollout-rollback.jsonl', 'openai')
    const original = await readFile(rollout, 'utf8')
    const dbPath = createStateDb(home, 'openai', rollout)
    const service = new SessionRepairService({
      codexHome: home,
      faultInjector: (stage) => {
        if (stage === 'after-sqlite') throw new Error('forced failure')
      }
    })
    const preview = await service.preview('custom')

    const result = await service.apply(preview.snapshotId, 'custom')

    expect(result.ok).toBe(false)
    expect(await readFile(rollout, 'utf8')).toBe(original)
    const db = new DatabaseSync(dbPath)
    expect(db.prepare('SELECT model_provider FROM threads').get()).toEqual({
      model_provider: 'openai'
    })
    db.close()
  })
})
