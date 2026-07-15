import { describe, expect, it, vi } from 'vitest'
import { CodexProcessManager, officialCodexRestartScript } from './codex-process'

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
