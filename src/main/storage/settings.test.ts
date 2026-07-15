import { mkdtemp, rm } from 'node:fs/promises'
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
      authPath: 'C:\\Users\\lee\\.codex\\auth.json',
      configPath: 'C:\\Users\\lee\\.codex\\config.toml',
      concurrency: 4,
      backupRetention: 20
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
})

