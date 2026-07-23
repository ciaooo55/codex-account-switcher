import { describe, expect, it, vi } from 'vitest'
import {
  CodexProcessManager,
  officialCodexRestartScript,
  officialCodexStartScript,
  officialCodexStopScript
} from './codex-process'

describe('CodexProcessManager', () => {
  it('targets only official OpenAI Codex package processes and starts the AppID', async () => {
    expect(officialCodexRestartScript).toContain("-Name 'OpenAI.Codex'")
    expect(officialCodexRestartScript).toContain('$package.PackageFamilyName')
    expect(officialCodexRestartScript).toContain('Get-AppxPackage')
    expect(officialCodexRestartScript).toContain('20 秒内未检测到官方 Codex 窗口')
    expect(officialCodexRestartScript).not.toContain('codex-plus-plus')
    const runner = vi.fn().mockResolvedValue(undefined)
    const manager = new CodexProcessManager(runner)

    await expect(manager.restart()).resolves.toEqual({ ok: true, message: 'Codex 已重启' })
    expect(runner).toHaveBeenCalledWith(officialCodexRestartScript)
  })

  it('returns a readable error when restart fails', async () => {
    const manager = new CodexProcessManager(vi.fn().mockRejectedValue(new Error('denied')))

    await expect(manager.restart()).resolves.toEqual({
      ok: false,
      message: 'Codex 自动重启失败：denied'
    })
  })

  it('can close the official Codex process before a manual session repair', async () => {
    const runner = vi.fn().mockResolvedValue(undefined)
    const manager = new CodexProcessManager(runner)

    await expect(manager.stop()).resolves.toEqual({ ok: true, message: 'Codex 已关闭' })
    expect(runner).toHaveBeenCalledWith(officialCodexStopScript)
  })

  it('stops Codex, prepares session state, and only then starts it', async () => {
    const order: string[] = []
    const runner = vi.fn(async (script: string) => {
      order.push(script === officialCodexStopScript ? 'stop' : script === officialCodexStartScript ? 'start' : 'other')
    })
    const manager = new CodexProcessManager(runner)

    await expect(manager.restart(async () => { order.push('prepare') })).resolves.toEqual({
      ok: true,
      message: 'Codex 已重启'
    })
    expect(order).toEqual(['stop', 'prepare', 'start'])
  })

  it('still starts Codex when pre-launch session preparation fails', async () => {
    const runner = vi.fn().mockResolvedValue(undefined)
    const manager = new CodexProcessManager(runner)

    await expect(manager.restart(async () => { throw new Error('repair failed') })).resolves.toEqual({
      ok: false,
      message: 'Codex 自动重启失败：repair failed'
    })
    expect(runner).toHaveBeenNthCalledWith(1, officialCodexStopScript)
    expect(runner).toHaveBeenNthCalledWith(2, officialCodexStartScript)
  })

  it('shares one restart operation when the action is triggered twice', async () => {
    let finish: (() => void) | undefined
    const runner = vi.fn(
      () => new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    const manager = new CodexProcessManager(runner)

    const first = manager.restart()
    const second = manager.restart()
    expect(runner).toHaveBeenCalledTimes(1)
    finish?.()

    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, message: 'Codex 已重启' },
      { ok: true, message: 'Codex 已重启' }
    ])
  })

  it('detects only a running official Codex package process', async () => {
    const runner = vi.fn().mockResolvedValue('1\r\n')
    const manager = new CodexProcessManager(runner)

    await expect(manager.isOfficialRunning()).resolves.toBe(true)
    expect(String(runner.mock.calls[0][0])).toContain("-Name 'OpenAI.Codex'")
  })
})
