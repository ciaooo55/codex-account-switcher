import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsStore } from './settings'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('SettingsStore', () => {
  it('returns Windows defaults when the settings file does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-switcher-settings-'))
    tempDirs.push(dir)
    const store = new SettingsStore(join(dir, 'settings.json'), 'C:\\Users\\lee')

    await expect(store.get()).resolves.toMatchObject({
      accountDirectory: 'E:\\home\\lee\\.cli-proxy-api',
      grokDirectory: 'E:\\home\\lee\\.cli-proxy-api',
      customApiBaseUrl: 'https://api.openai.com/v1',
      customApiModel: 'gpt-5.4',
      authPath: 'C:\\Users\\lee\\.codex\\auth.json',
      configPath: 'C:\\Users\\lee\\.codex\\config.toml',
      concurrency: 4,
      backupRetention: 20,
      autoSwitchEnabled: false,
      autoSwitchIntervalSeconds: 300,
      autoSwitchAccountIds: []
    })
  })

  it('clamps numeric settings and persists updates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-switcher-settings-'))
    tempDirs.push(dir)
    const path = join(dir, 'settings.json')
    const store = new SettingsStore(path, 'C:\\Users\\lee')

    await store.update({ concurrency: 99, timeoutMs: 10, backupRetention: 0 })
    const reloaded = new SettingsStore(path, 'C:\\Users\\lee')

    await expect(reloaded.get()).resolves.toMatchObject({
      concurrency: 12,
      timeoutMs: 1_000,
      backupRetention: 1
    })
  })

  it('normalizes an OpenAI-compatible root URL to the v1 API base', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-switcher-settings-'))
    tempDirs.push(dir)
    const store = new SettingsStore(join(dir, 'settings.json'), 'C:\\Users\\lee')

    await store.update({ customApiBaseUrl: 'http://127.0.0.1:18317' })

    await expect(store.get()).resolves.toMatchObject({
      customApiBaseUrl: 'http://127.0.0.1:18317/v1'
    })
  })

  it('merges concurrent partial updates instead of dropping one patch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-switcher-settings-'))
    tempDirs.push(dir)
    const store = new SettingsStore(join(dir, 'settings.json'), 'C:\\Users\\lee')

    await Promise.all([
      store.update({ concurrency: 7 }),
      store.update({ timeoutMs: 45_000 }),
      store.update({ backupRetention: 33 })
    ])

    await expect(store.get()).resolves.toMatchObject({
      concurrency: 7,
      timeoutMs: 45_000,
      backupRetention: 33
    })
  })

  it('rejects relative or incorrectly named Codex paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-switcher-settings-'))
    tempDirs.push(dir)
    const store = new SettingsStore(join(dir, 'settings.json'), 'C:\\Users\\lee')

    await expect(store.update({ authPath: '.\\auth.json' })).rejects.toThrow('绝对路径')
    await expect(store.update({ authPath: 'C:\\Users\\lee\\.codex\\tokens.json' })).rejects.toThrow(
      'auth.json'
    )
    await expect(store.update({ configPath: 'C:\\Users\\lee\\.codex\\settings.toml' })).rejects.toThrow(
      'config.toml'
    )
  })

  it('clamps auto-switch timing and keeps only valid unique account ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-switcher-settings-'))
    tempDirs.push(dir)
    const store = new SettingsStore(join(dir, 'settings.json'), 'C:\\Users\\lee')
    const id = 'a'.repeat(64)

    await store.update({
      autoSwitchEnabled: true,
      autoSwitchIntervalSeconds: 1,
      autoSwitchAccountIds: [id, 'not-an-id', id]
    })

    await expect(store.get()).resolves.toMatchObject({
      autoSwitchEnabled: true,
      autoSwitchIntervalSeconds: 5,
      autoSwitchAccountIds: [id]
    })
  })

  it('reports a clear error for settings with invalid runtime types', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-switcher-settings-'))
    tempDirs.push(dir)
    const path = join(dir, 'settings.json')
    await writeFile(path, JSON.stringify({ deepTestModel: 42, autoSwitchAccountIds: 'bad' }))
    const store = new SettingsStore(path, 'C:\\Users\\lee')

    await expect(store.get()).rejects.toThrow('设置文件格式损坏')
  })
})
