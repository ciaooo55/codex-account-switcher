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
      switchable: true,
      switchMode: 'oauth',
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
      switchable: true,
      switchMode: 'external',
      accessExpiresAt: null,
      lastRefresh: null,
      status: 'untested',
      detail: '未测试',
      lastCheckedAt: null,
      usage: null,
      active: false
    }
  ],
  importDirectory: 'C:\\Users\\lee\\AppData\\Roaming\\Codex Account Switcher\\aa',
  settings: {
    accountDirectory: 'E:\\home\\lee\\.cli-proxy-api',
    authPath: 'C:\\Users\\lee\\.codex\\auth.json',
    configPath: 'C:\\Users\\lee\\.codex\\config.toml',
    concurrency: 4,
    timeoutMs: 30_000,
    backupRetention: 20,
    deepTestModel: 'gpt-5.4',
    autoSwitchEnabled: false,
    autoSwitchIntervalSeconds: 300,
    autoSwitchAccountIds: [],
    autoSwitchRestartCodex: true,
    grokDirectory: 'E:\\home\\lee\\.cli-proxy-api',
    customApiBaseUrl: 'https://api.openai.com/v1',
    customApiModel: 'gpt-5.4'
  },
  testing: { active: false, done: 0, total: 0, runningIds: [], updatedAccount: null },
  autoSwitch: {
    enabled: false,
    running: false,
    nextCheckAt: null,
    lastCheckAt: null,
    lastMessage: '自动切换未启用',
    lastSwitchedAccountId: null
  },
  grokAccounts: [],
  grokDirectory: 'E:\\home\\lee\\.cli-proxy-api',
  grokTesting: { active: false, done: 0, total: 0, runningIds: [], updatedAccount: null },
  customApi: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4', hasApiKey: false }
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
    switchToCustomApi: vi.fn().mockResolvedValue({ ok: true, message: 'ok', backupPath: null }),
    getCustomApiProfile: vi.fn().mockResolvedValue(snapshot.customApi),
    scanGrokDirectory: vi.fn().mockResolvedValue({ imported: 0, skipped: 0, errors: [], accounts: [] }),
    importGrokFiles: vi.fn().mockResolvedValue(null),
    importGrokDirectory: vi.fn().mockResolvedValue(null),
    importGrokPasted: vi.fn().mockResolvedValue({ imported: 0, skipped: 0, errors: [], accounts: [] }),
    deleteGrokAccounts: vi.fn().mockResolvedValue({ deleted: 0, message: 'ok' }),
    testGrokAccounts: vi.fn().mockResolvedValue({ tested: 0, results: [], cancelled: false }),
    cancelGrokTests: vi.fn().mockResolvedValue(undefined),
    exportGrokAccounts: vi.fn().mockResolvedValue([]),
    restartCodex: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
    updateSettings: vi.fn().mockResolvedValue(snapshot.settings),
    chooseAccountDirectory: vi.fn().mockResolvedValue(null),
    chooseGrokDirectory: vi.fn().mockResolvedValue(null),
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
    runAutoSwitchNow: vi.fn().mockResolvedValue({
      ok: true,
      switched: false,
      message: '当前账号无需切换',
      checkedAccountIds: [],
      switchedAccountId: null
    }),
    onUpdateState: vi.fn().mockImplementation(() => () => undefined),
    onGrokTestProgress: vi.fn().mockImplementation(() => () => undefined),
    onAutoSwitchState: vi.fn().mockImplementation(() => () => undefined),
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

  it('keeps Codex and Grok test-all actions isolated by page', async () => {
    const bridge = api()
    const grokSnapshot: AppSnapshot = {
      ...snapshot,
      grokAccounts: [{
        id: 'g'.repeat(64),
        email: 'grok@example.com',
        subject: 'grok-user',
        teamId: 'team-a',
        planType: 'SuperGrok',
        sourcePath: 'E:\\grok\\grok-account.json',
        sourceFormat: 'json',
        sourceDialect: 'cpa',
        canRefresh: true,
        expiresAt: '2030-01-01T00:00:00Z',
        lastRefresh: '2026-07-16T00:00:00Z',
        status: 'untested',
        detail: '未测试',
        lastCheckedAt: null,
        usage: null
      }]
    }
    vi.mocked(bridge.getSnapshot).mockResolvedValue(grokSnapshot)
    window.codexSwitcher = bridge
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: 'Grok 账号库' }))
    await screen.findByText('grok@example.com')
    fireEvent.click(screen.getByRole('button', { name: '测试全部' }))

    await waitFor(() => expect(bridge.testGrokAccounts).toHaveBeenCalledWith())
    expect(bridge.testAccounts).not.toHaveBeenCalled()
  })

  it('imports every supported file from a selected folder', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '导入文件夹' }))

    await waitFor(() => expect(window.codexSwitcher.importDirectory).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('文件夹导入完成：导入 2，跳过 0')).toBeInTheDocument()
  })

  it('does not report success when the file picker is cancelled', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '导入文件' }))

    expect(await screen.findByText('已取消操作')).toBeInTheDocument()
    expect(screen.queryByText(/文件导入完成/)).not.toBeInTheDocument()
  })

  it('reports partial import failures instead of hiding them behind a success message', async () => {
    window.codexSwitcher.importFiles = vi.fn().mockResolvedValue({
      imported: 3,
      skipped: 2,
      errors: ['broken.json: invalid'],
      accounts: snapshot.accounts
    })
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '导入文件' }))

    const warning = await screen.findByText('文件导入完成：导入 3，跳过 2，失败 1')
    expect(warning.closest('.message')).toHaveClass('warn')
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
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('外部原始文件不受影响'))
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

  it('configures a timed auto-switch pool in seconds', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '定时切换' }))
    fireEvent.click(screen.getByLabelText('启用定时自动切换'))
    fireEvent.change(screen.getByLabelText('自动切换检查间隔'), { target: { value: '45' } })
    fireEvent.click(screen.getByLabelText('自动切换候选 person@example.com'))
    expect(screen.getByLabelText('自动切换候选 second@example.com')).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))

    await waitFor(() =>
      expect(window.codexSwitcher.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          autoSwitchEnabled: true,
          autoSwitchIntervalSeconds: 45,
          autoSwitchAccountIds: ['account-a']
        })
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

  it('switches and restarts the exact account chosen from the context menu', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    window.codexSwitcher.switchAccount = vi.fn().mockResolvedValue({
      ok: true,
      message: '账号切换完成；Codex 已重启',
      backupPath: null,
      restartResult: { ok: true, message: 'Codex 已重启' }
    })
    render(<App />)
    const row = await screen.findByRole('row', { name: /person@example\.com/ })

    fireEvent.contextMenu(row, { clientX: 120, clientY: 160 })
    fireEvent.click(screen.getByRole('menuitem', { name: '切换并重启' }))

    await waitFor(() =>
      expect(window.codexSwitcher.switchAccount).toHaveBeenCalledWith('account-a', true)
    )
    expect(await screen.findByText('账号切换完成；Codex 已重启')).toBeInTheDocument()
    confirm.mockRestore()
  })

  it('allows workspace-bound access-only accounts to use external Codex switching', async () => {
    render(<App />)
    const row = await screen.findByRole('row', { name: /second@example\.com/ })

    expect(row).toHaveTextContent('可切换 · 外部凭据，需重启')
    fireEvent.contextMenu(row, { clientX: 120, clientY: 160 })
    expect(screen.getByRole('menuitem', { name: '检测此账号' })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: '切换到此账号' })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: '切换并重启' })).toBeEnabled()
  })

  it('reports a restart failure without claiming the completed account switch was rolled back', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    window.codexSwitcher.switchAccount = vi.fn().mockResolvedValue({
      ok: true,
      message: '账号切换完成，但 Codex 自动重启失败。账号已完成切换，可手动重启 Codex',
      backupPath: null,
      restartResult: { ok: false, message: 'Codex 自动重启失败' }
    })
    render(<App />)
    const row = await screen.findByRole('row', { name: /person@example\.com/ })

    fireEvent.contextMenu(row, { clientX: 120, clientY: 160 })
    fireEvent.click(screen.getByRole('menuitem', { name: '切换并重启' }))

    const warning = await screen.findByText(/账号已完成切换，可手动重启 Codex/)
    expect(warning.closest('.message')).toHaveClass('warn')
    confirm.mockRestore()
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

    fireEvent.click(screen.getByRole('button', { name: '恢复备份 API' }))

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
