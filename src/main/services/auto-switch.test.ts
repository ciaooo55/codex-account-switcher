import { describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../../shared/types'
import { AutoSwitchScheduler } from './auto-switch'

function settings(enabled = true): AppSettings {
  return {
    accountDirectory: 'E:\\accounts',
    authPath: 'C:\\Users\\lee\\.codex\\auth.json',
    configPath: 'C:\\Users\\lee\\.codex\\config.toml',
    concurrency: 4,
    timeoutMs: 30_000,
    backupRetention: 20,
    deepTestModel: 'gpt-5.4',
    autoSwitchEnabled: enabled,
    autoSwitchIntervalSeconds: 30,
    autoSwitchAccountIds: ['a'.repeat(64)],
    autoSwitchRestartCodex: true
  }
}

describe('AutoSwitchScheduler', () => {
  it('publishes a checked result and schedules the next run', async () => {
    vi.useFakeTimers()
    const states = [] as ReturnType<AutoSwitchScheduler['getState']>[]
    const execute = vi.fn().mockResolvedValue({
      ok: true,
      switched: false,
      message: '当前账号无需切换',
      checkedAccountIds: ['a'],
      switchedAccountId: null
    })
    const scheduler = new AutoSwitchScheduler({
      getSettings: async () => settings(),
      execute,
      onState: (state) => states.push(state),
      now: () => new Date('2026-07-16T00:00:00Z')
    })

    await scheduler.start()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(execute).toHaveBeenCalledTimes(1)
    expect(states.at(-1)).toMatchObject({
      running: false,
      lastMessage: '当前账号无需切换',
      nextCheckAt: '2026-07-16T00:00:30.000Z'
    })
    scheduler.stop()
    vi.useRealTimers()
  })

  it('allows a manual check while the scheduled feature is disabled', async () => {
    const execute = vi.fn().mockResolvedValue({
      ok: false,
      switched: false,
      message: '没有可用候选账号',
      checkedAccountIds: [],
      switchedAccountId: null
    })
    const scheduler = new AutoSwitchScheduler({
      getSettings: async () => settings(false),
      execute,
      onState: () => undefined
    })

    await expect(scheduler.runNow(true)).resolves.toMatchObject({ message: '没有可用候选账号' })
    expect(execute).toHaveBeenCalledOnce()
    scheduler.stop()
  })
})
