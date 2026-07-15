import { describe, expect, it, vi } from 'vitest'
import { CodexProcessManager, officialCodexRestartScript } from './codex-process'

describe('CodexProcessManager', () => {
  it('targets only official OpenAI Codex package processes and starts the AppID', async () => {
    expect(officialCodexRestartScript).toContain('OpenAI.Codex_')
    expect(officialCodexRestartScript).toContain('OpenAI.Codex_2p2nqsd0c76g0!App')
    expect(officialCodexRestartScript).not.toContain('codex-plus-plus')
    const runner = vi.fn().mockResolvedValue(undefined)
    const manager = new CodexProcessManager(runner)

    await expect(manager.restart()).resolves.toEqual({ ok: true, message: 'Codex 已重启' })
    expect(runner).toHaveBeenCalledWith(officialCodexRestartScript)
  })

  it('returns a readable error when restart fails', async () => {
    const manager = new CodexProcessManager(vi.fn().mockRejectedValue(new Error('denied')))

    await expect(manager.restart()).resolves.toEqual({ ok: false, message: 'denied' })
  })

  it('detects only a running official Codex package process', async () => {
    const runner = vi.fn().mockResolvedValue('1\r\n')
    const manager = new CodexProcessManager(runner)

    await expect(manager.isOfficialRunning()).resolves.toBe(true)
    expect(String(runner.mock.calls[0][0])).toContain('OpenAI.Codex_')
  })
})
