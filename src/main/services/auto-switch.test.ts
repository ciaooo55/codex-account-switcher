import { describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../../shared/types'
import { AutoSwitchScheduler, shouldNotifyAutoSwitchCompletion } from './auto-switch'

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
    autoSwitchRestartCodex: true,
    grokDirectory: 'E:\\grok',
    customApiBaseUrl: 'https://api.openai.com/v1',
    customApiModel: 'gpt-5.4'
  }
}

describe('AutoSwitchScheduler', () => {
  it('only requests a tray notification after an account was actually switched', () => {
    const running = {
      enabled: true,
      running: true,
      nextCheckAt: null,
      lastCheckAt: null,
      lastMessage: '正在检查当前账号',
      lastSwitchedAccountId: null
    }
    const unchanged = {
      ...running,
      running: false,
      lastMessage: '当前账号无需切换'
    }
    const switched = {
      ...unchanged,
      lastMessage: '已自动切换账号',
      lastSwitchedAccountId: 'b'.repeat(64)
    }

    expect(shouldNotifyAutoSwitchCompletion(running, unchanged)).toBe(false)
    expect(shouldNotifyAutoSwitchCompletion(running, switched)).toBe(true)
    expect(shouldNotifyAutoSwitchCompletion(running, switched, true)).toBe(false)
  })

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
