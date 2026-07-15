// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, CodexSwitcherApi } from '../../shared/ipc'
import { App } from './App'

const snapshot: AppSnapshot = {
  accounts: [
    {
      id: 'account-a',
      email: 'person@example.com',
      workspaceId: 'workspace-a',
      planType: 'plus',
      sourcePath: 'E:\\accounts\\person.json',
      sourceFormat: 'json',
      canRefresh: true,
      accessExpiresAt: '2026-10-14T12:00:00Z',
      lastRefresh: '2026-07-14T12:00:00Z',
      status: 'valid',
      detail: '正常可用',
      lastCheckedAt: '2026-07-15T00:00:00Z',
      usage: {
        planType: 'plus',
        checkedAt: '2026-07-15T00:00:00Z',
        windows: [
          {
            id: 'five-hour',
            label: 'Codex 5小时',
            usedPercent: 20,
            remainingPercent: 80,
            resetAt: '2026-07-15T08:00:00Z',
            resetInSeconds: null,
            windowSeconds: 18_000
          }
        ]
      },
      active: true
    },
    {
      id: 'account-b',
      email: 'second@example.com',
      workspaceId: 'workspace-b',
      planType: 'free',
      sourcePath: 'E:\\accounts\\second.json',
      sourceFormat: 'json',
      canRefresh: false,
      accessExpiresAt: null,
      lastRefresh: null,
      status: 'untested',
      detail: '未测试',
      lastCheckedAt: null,
      usage: null,
      active: false
    }
  ],
  settings: {
    accountDirectory: 'E:\\home\\lee\\.cli-proxy-api',
    authPath: 'C:\\Users\\lee\\.codex\\auth.json',
    configPath: 'C:\\Users\\lee\\.codex\\config.toml',
    concurrency: 4,
    timeoutMs: 30_000,
    backupRetention: 20,
    deepTestModel: 'gpt-5.4'
  },
  testing: { active: false, done: 0, total: 0 }
}

function api(): CodexSwitcherApi {
  return {
    getSnapshot: vi.fn().mockResolvedValue(snapshot),
    scanDirectory: vi.fn().mockResolvedValue({
      imported: 0,
      skipped: 0,
      errors: [],
      accounts: snapshot.accounts
    }),
    importFiles: vi.fn().mockResolvedValue(null),
    testAccounts: vi.fn().mockResolvedValue({ tested: 1, results: [], cancelled: false }),
    cancelTests: vi.fn().mockResolvedValue(undefined),
    switchAccount: vi.fn().mockResolvedValue({ ok: true, message: 'ok', backupPath: null }),
    restoreLatest: vi.fn().mockResolvedValue({ ok: true, message: 'ok', backupPath: null }),
    restoreApiMode: vi.fn().mockResolvedValue({ ok: true, message: 'ok', backupPath: null }),
    restartCodex: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
    updateSettings: vi.fn().mockResolvedValue(snapshot.settings),
    chooseAccountDirectory: vi.fn().mockResolvedValue(null),
    revealSource: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
    previewSessionRepair: vi.fn().mockResolvedValue({
      snapshotId: 'snapshot-a',
      currentProvider: 'openai',
      targetProvider: 'openai',
      availableProviders: ['openai', 'custom'],
      scannedSessionFiles: 81,
      changedSessionFiles: 12,
      skippedLockedFiles: [],
      encryptedContentFiles: 2,
      encryptedContentProviders: ['custom'],
      sqliteProviderRows: 8,
      sqliteUserEventRows: 3,
      sqliteCwdRows: 2,
      globalStateKeys: 1
    }),
    applySessionRepair: vi.fn().mockResolvedValue({
      ok: true,
      message: '历史会话修复完成',
      targetProvider: 'openai',
      changedSessionFiles: 12,
      sqliteRowsUpdated: 13,
      globalStateKeysUpdated: 1,
      backupPath: 'C:\\backup'
    }),
    onTestProgress: vi.fn().mockReturnValue(() => undefined)
  }
}

describe('App', () => {
  beforeEach(() => {
    window.codexSwitcher = api()
  })

  afterEach(() => cleanup())

  it('renders the operational account table and quota information', async () => {
    render(<App />)

    expect((await screen.findAllByText('person@example.com')).length).toBeGreaterThan(0)
    expect(screen.getByText('second@example.com')).toBeInTheDocument()
    expect(screen.getByText('80%')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '测试全部' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导入文件' })).toBeInTheDocument()
  })

  it('tests only selected accounts', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByLabelText('选择 person@example.com'))
    fireEvent.click(screen.getByRole('button', { name: '测试选中' }))

    await waitFor(() =>
      expect(window.codexSwitcher.testAccounts).toHaveBeenCalledWith(['account-a'])
    )
  })

  it('opens settings and saves edited numeric values', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '设置' }))
    const concurrency = screen.getByLabelText('并发数')
    fireEvent.change(concurrency, { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(window.codexSwitcher.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ concurrency: 6 })
      )
    )
  })

  it('opens account actions on right click and tests that account', async () => {
    render(<App />)
    const row = await screen.findByRole('row', { name: /person@example\.com/ })

    fireEvent.contextMenu(row, { clientX: 120, clientY: 160 })

    expect(screen.getByRole('menu', { name: '账号管理' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: '检测此账号' }))
    await waitFor(() =>
      expect(window.codexSwitcher.testAccounts).toHaveBeenCalledWith(['account-a'])
    )
  })

  it('opens the source file location from the account context menu', async () => {
    render(<App />)
    const row = await screen.findByRole('row', { name: /person@example\.com/ })

    fireEvent.contextMenu(row, { clientX: 120, clientY: 160 })
    fireEvent.click(screen.getByRole('menuitem', { name: '打开源文件位置' }))

    await waitFor(() =>
      expect(window.codexSwitcher.revealSource).toHaveBeenCalledWith('account-a')
    )
  })

  it('restores the saved API provider mode from the toolbar', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '恢复 API 模式' }))

    await waitFor(() => expect(window.codexSwitcher.restoreApiMode).toHaveBeenCalledWith(false))
  })

  it('previews and confirms Codex++ style historical session repair', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '修复历史会话' }))

    expect(await screen.findByRole('dialog', { name: '修复历史会话' })).toBeInTheDocument()
    expect(screen.getByText('12')).toBeInTheDocument()
    expect(screen.getByText('81')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认修复' }))

    await waitFor(() =>
      expect(window.codexSwitcher.applySessionRepair).toHaveBeenCalledWith(
        'snapshot-a',
        'openai'
      )
    )
  })
})
