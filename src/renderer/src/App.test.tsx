// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, CodexSwitcherApi, TestProgress } from '../../shared/ipc'
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
      sourceDialect: 'cpa',
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
      sourceDialect: 'sub2api',
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
  importDirectory: 'C:\\Users\\lee\\AppData\\Roaming\\codex-account-switcher\\imports',
  settings: {
    accountDirectory: 'E:\\home\\lee\\.cli-proxy-api',
    authPath: 'C:\\Users\\lee\\.codex\\auth.json',
    configPath: 'C:\\Users\\lee\\.codex\\config.toml',
    concurrency: 4,
    timeoutMs: 30_000,
    backupRetention: 20,
    deepTestModel: 'gpt-5.4'
  },
  testing: { active: false, done: 0, total: 0, runningIds: [], updatedAccount: null }
}

let progressListener: ((progress: TestProgress) => void) | null = null

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
    importDirectory: vi.fn().mockResolvedValue({
      imported: 2,
      skipped: 0,
      errors: [],
      accounts: snapshot.accounts
    }),
    importPasted: vi.fn().mockResolvedValue({
      imported: 1,
      skipped: 0,
      errors: [],
      accounts: snapshot.accounts
    }),
    deleteAccounts: vi.fn().mockResolvedValue({
      deleted: 1,
      message: '已从账号库删除 1 个账号，原始文件未修改'
    }),
    exportAccounts: vi.fn().mockResolvedValue({
      ok: true,
      cancelled: false,
      exported: 1,
      files: ['E:\\export\\codex-person.json'],
      errors: [],
      message: '已导出 1 个账号'
    }),
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
    getUpdateState: vi.fn().mockResolvedValue({
      status: 'idle',
      currentVersion: '0.1.0',
      availableVersion: null,
      percent: null,
      message: '尚未检查更新'
    }),
    checkForUpdates: vi.fn().mockResolvedValue({
      status: 'not_available',
      currentVersion: '0.1.0',
      availableVersion: null,
      percent: null,
      message: '当前已是最新版本'
    }),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    installUpdate: vi.fn().mockResolvedValue(undefined),
    onUpdateState: vi.fn().mockImplementation(() => () => undefined),
    onTestProgress: vi.fn().mockImplementation((listener) => {
      progressListener = listener
      return () => {
        progressListener = null
      }
    })
  }
}

describe('App', () => {
  beforeEach(() => {
    progressListener = null
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
    expect(screen.getByRole('button', { name: '导入文件夹' })).toBeInTheDocument()
  })

  it('imports every supported file from a selected folder', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '导入文件夹' }))

    await waitFor(() => expect(window.codexSwitcher.importDirectory).toHaveBeenCalledTimes(1))
  })

  it('filters by persistent status and searches workspace text', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'valid' } })
    expect(screen.getByRole('row', { name: /person@example\.com/ })).toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /second@example\.com/ })).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } })
    fireEvent.change(screen.getByPlaceholderText('搜索邮箱、文件或错误'), {
      target: { value: 'workspace-b' }
    })
    expect(screen.getByRole('row', { name: /second@example\.com/ })).toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /person@example\.com/ })).not.toBeInTheDocument()
  })

  it('deletes selected accounts only after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByLabelText('选择 person@example.com'))
    fireEvent.click(screen.getByRole('button', { name: '删除选中' }))

    await waitFor(() =>
      expect(window.codexSwitcher.deleteAccounts).toHaveBeenCalledWith(['account-a'])
    )
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('原始导入文件不会被删除'))
    confirm.mockRestore()
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

  it('imports cleaned credentials pasted by the user', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '粘贴导入' }))
    fireEvent.change(screen.getByLabelText('凭据文本'), {
      target: { value: '{"access_token":"secret"}' }
    })
    fireEvent.click(screen.getByRole('button', { name: '清洗并导入' }))

    await waitFor(() =>
      expect(window.codexSwitcher.importPasted).toHaveBeenCalledWith('{"access_token":"secret"}')
    )
  })

  it('exports selected accounts using the chosen native format and layout', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')
    fireEvent.click(screen.getByLabelText('选择 person@example.com'))

    fireEvent.click(screen.getByRole('button', { name: '导出账号' }))
    fireEvent.click(screen.getByRole('button', { name: 'SubAPI' }))
    fireEvent.click(screen.getByRole('button', { name: '合并单文件' }))
    fireEvent.click(screen.getByRole('button', { name: '选择目录并导出' }))

    await waitFor(() =>
      expect(window.codexSwitcher.exportAccounts).toHaveBeenCalledWith({
        accountIds: ['account-a'],
        format: 'sub2api',
        layout: 'bundle'
      })
    )
  })

  it('shows a running row immediately and applies each completed account update', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    progressListener?.({
      active: true,
      done: 0,
      total: 1,
      runningIds: ['account-a'],
      updatedAccount: null
    })
    expect(await screen.findByText('检测中')).toBeInTheDocument()

    progressListener?.({
      active: true,
      done: 1,
      total: 1,
      runningIds: [],
      updatedAccount: {
        ...snapshot.accounts[0],
        status: 'invalid',
        detail: '凭据已失效',
        usage: null
      }
    })

    expect(await screen.findByText('已失效')).toBeInTheDocument()
    expect(screen.getByText('凭据已失效')).toBeInTheDocument()
  })
})
