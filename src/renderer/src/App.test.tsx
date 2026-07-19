// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, CodexSwitcherApi, TestProgress } from '../../shared/ipc'
import type {
  ConversationListResult,
  ConversationSummary,
  ImportPreviewCommitResult,
  ImportPreviewResult
} from '../../shared/types'
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
  cpaDirectoryStats: {
    credentialFiles: 0,
    codexFiles: 0,
    grokFiles: 0,
    duplicateFiles: 0,
    unrecognizedFiles: 0
  },
  grokTesting: { active: false, done: 0, total: 0, runningIds: [], updatedAccount: null },
  cpaGrokAccounts: [],
  cpaGrokTesting: { active: false, done: 0, total: 0, runningIds: [], updatedAccount: null },
  cpaCodexAccounts: [],
  cpaCodexTesting: { active: false, done: 0, total: 0, runningIds: [], updatedAccount: null },
  customApi: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4', hasApiKey: false }
}

const conversationSummary: ConversationSummary = {
  id: 'thread-one',
  title: '修复账号切换',
  cwd: 'C:\\work',
  provider: 'custom',
  createdAt: '2026-07-15T00:00:00Z',
  updatedAt: '2026-07-16T00:00:00Z',
  archived: false,
  sourcePath: 'C:\\Users\\lee\\.codex\\sessions\\rollout-one.jsonl',
  sizeBytes: 1024,
  kind: 'main',
  subagentKind: null,
  parentId: null,
  parentTitle: null,
  childCount: 0,
  depth: null,
  agentNickname: null,
  agentRole: null,
  lifecycleStatus: 'unknown',
  safeToClean: false,
  matchExcerpt: null
}

const conversationListResult: ConversationListResult = {
  items: [conversationSummary],
  total: 1,
  allTotal: 1,
  offset: 0,
  hasMore: false,
  facets: {
    kinds: [{ value: 'main', label: '主对话', count: 1 }],
    subagentKinds: [],
    lifecycleStatuses: [],
    archives: [{ value: 'active', label: '当前会话', count: 1 }],
    providers: [{ value: 'custom', label: 'custom', count: 1 }],
    workspaces: [{ value: 'C:\\work', label: 'C:\\work', count: 1 }]
  },
  safeCleanupCount: 0,
  safeCleanupBytes: 0
}

function importPreview(overrides: Partial<ImportPreviewResult> = {}): ImportPreviewResult {
  return {
    sessionId: '00000000-0000-4000-8000-000000000001',
    createdAt: '2026-07-16T00:00:00.000Z',
    expiresAt: '2026-07-16T00:20:00.000Z',
    sourceCount: 1,
    recognized: 1,
    errors: [],
    unrecognized: [],
    items: [{
      key: 'codex:account-import',
      provider: 'codex',
      credentialId: 'account-import',
      existingCredentialId: null,
      email: 'imported@example.com',
      planType: 'plus',
      identity: 'subject:imported',
      sourcePath: 'E:\\incoming\\account.json',
      sourceFormat: 'json',
      sourceDialect: 'cpa',
      canRefresh: true,
      switchable: true,
      disposition: 'new',
      detail: '新账号',
      suggestedDecision: 'add'
    }],
    ...overrides
  }
}

function importCommit(overrides: Partial<ImportPreviewCommitResult> = {}): ImportPreviewCommitResult {
  return {
    imported: 1,
    skipped: 0,
    recognized: 1,
    errors: [],
    codexImported: 1,
    codexSkipped: 0,
    grokImported: 0,
    grokSkipped: 0,
    accounts: snapshot.accounts,
    grokAccounts: [],
    added: 1,
    updated: 0,
    ignored: 0,
    ...overrides
  }
}

let progressListener: ((progress: TestProgress) => void) | null = null
const browserStorage = new Map<string, string>()

const localStorageMock: Storage = {
  get length() { return browserStorage.size },
  clear: () => browserStorage.clear(),
  getItem: (key) => browserStorage.get(key) ?? null,
  key: (index) => [...browserStorage.keys()][index] ?? null,
  removeItem: (key) => { browserStorage.delete(key) },
  setItem: (key, value) => { browserStorage.set(key, value) }
}

function api(): CodexSwitcherApi {
  const getSnapshot = vi.fn().mockResolvedValue(snapshot)
  return {
    getSnapshot,
    getPageSnapshot: vi.fn(() => getSnapshot()),
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
    importAnyFiles: vi.fn().mockResolvedValue(null),
    importAnyDirectory: vi.fn().mockResolvedValue({
      imported: 2, skipped: 0, errors: [], accounts: snapshot.accounts,
      codexImported: 2, codexSkipped: 0, grokImported: 0, grokSkipped: 0, grokAccounts: []
    }),
    importAnyPasted: vi.fn().mockResolvedValue({
      imported: 1, skipped: 0, errors: [], accounts: snapshot.accounts,
      codexImported: 1, codexSkipped: 0, grokImported: 0, grokSkipped: 0, grokAccounts: []
    }),
    previewAnyFiles: vi.fn().mockResolvedValue(null),
    previewAnyDirectory: vi.fn().mockResolvedValue(null),
    previewAnyPasted: vi.fn().mockResolvedValue({
      sessionId: '00000000-0000-4000-8000-000000000000',
      createdAt: '2026-07-16T00:00:00.000Z',
      expiresAt: '2026-07-16T00:20:00.000Z',
      sourceCount: 1,
      recognized: 0,
      errors: [],
      items: [],
      unrecognized: []
    }),
    previewRefreshTokens: vi.fn().mockResolvedValue({
      sessionId: '00000000-0000-4000-8000-000000000000',
      createdAt: '2026-07-16T00:00:00.000Z',
      expiresAt: '2026-07-16T00:20:00.000Z',
      sourceCount: 1,
      recognized: 0,
      errors: [],
      items: [],
      unrecognized: []
    }),
    previewOAuthComplete: vi.fn().mockResolvedValue({
      sessionId: '00000000-0000-4000-8000-000000000000',
      createdAt: '2026-07-16T00:00:00.000Z',
      expiresAt: '2026-07-16T00:20:00.000Z',
      sourceCount: 1,
      recognized: 0,
      errors: [],
      items: [],
      unrecognized: []
    }),
    commitImportPreview: vi.fn().mockResolvedValue({
      imported: 0, skipped: 0, recognized: 0, errors: [],
      codexImported: 0, codexSkipped: 0, grokImported: 0, grokSkipped: 0,
      accounts: snapshot.accounts, grokAccounts: [], added: 0, updated: 0, ignored: 0
    }),
    refineImportPreview: vi.fn().mockResolvedValue(importPreview()),
    discardImportPreview: vi.fn().mockResolvedValue(undefined),
    importRefreshTokens: vi.fn().mockResolvedValue({
      imported: 1, skipped: 0, errors: [], accounts: snapshot.accounts
    }),
    startOAuthAuthorization: vi.fn().mockResolvedValue({
      sessionId: '0123456789abcdef0123456789abcdef',
      authUrl: 'https://auth.openai.com/oauth/authorize?state=test',
      expiresAt: '2026-07-16T00:30:00.000Z'
    }),
    completeOAuthAuthorization: vi.fn().mockResolvedValue({
      imported: 1, skipped: 0, errors: [], accounts: snapshot.accounts
    }),
    deleteAccounts: vi.fn().mockResolvedValue({
      deleted: 1,
      message: '已从账号库删除 1 个账号，原始文件未修改'
    }),
    updateAccountMetadata: vi.fn().mockResolvedValue(undefined),
    inspectLibraries: vi.fn().mockResolvedValue({
      snapshotId: '00000000-0000-4000-8000-000000000000',
      generatedAt: '2026-07-16T00:00:00.000Z',
      scannedFiles: 0,
      healthyAccounts: 0,
      issues: []
    }),
    repairLibraries: vi.fn().mockResolvedValue({
      repaired: 0,
      skipped: 0,
      errors: [],
      message: '没有需要修复的问题',
      report: {
        snapshotId: '00000000-0000-4000-8000-000000000000',
        generatedAt: '2026-07-16T00:00:00.000Z',
        scannedFiles: 0,
        healthyAccounts: 0,
        issues: []
      }
    }),
    exportAccounts: vi.fn().mockResolvedValue({
      ok: true,
      cancelled: false,
      exported: 1,
      files: ['E:\\export\\codex-person.json'],
      errors: [],
      message: '已导出 1 个账号'
    }),
    exportAccountsToCpa: vi.fn().mockResolvedValue({
      imported: 1,
      skipped: 0,
      errors: [],
      accounts: []
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
    exportGrokAccountsToCpa: vi.fn().mockResolvedValue({ imported: 0, skipped: 0, errors: [], accounts: [] }),
    scanCpaGrokDirectory: vi.fn().mockResolvedValue({ imported: 0, skipped: 0, errors: [], accounts: [] }),
    syncCpaGrokToLibrary: vi.fn().mockResolvedValue({ imported: 0, skipped: 0, errors: [], accounts: [] }),
    deleteCpaGrokAccounts: vi.fn().mockResolvedValue({ deleted: 0, message: 'ok' }),
    testCpaGrokAccounts: vi.fn().mockResolvedValue({ tested: 0, results: [], cancelled: false }),
    cancelCpaGrokTests: vi.fn().mockResolvedValue(undefined),
    setCpaGrokEnabled: vi.fn().mockResolvedValue({ changed: 0, skipped: 0, message: 'ok' }),
    scanCpaCodexDirectory: vi.fn().mockResolvedValue({ imported: 0, skipped: 0, errors: [], accounts: [] }),
    syncCpaCodexToLibrary: vi.fn().mockResolvedValue({ imported: 0, skipped: 0, errors: [], accounts: snapshot.accounts }),
    testCpaCodexAccounts: vi.fn().mockResolvedValue({ tested: 0, results: [], cancelled: false }),
    cancelCpaCodexTests: vi.fn().mockResolvedValue(undefined),
    deleteCpaCodexAccounts: vi.fn().mockResolvedValue({ deleted: 0, message: 'ok' }),
    setCpaCodexEnabled: vi.fn().mockResolvedValue({ changed: 0, skipped: 0, message: 'ok' }),
    setGrokEnabled: vi.fn().mockResolvedValue({ changed: 0, skipped: 0, message: 'ok' }),
    restartCodex: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
    updateSettings: vi.fn().mockResolvedValue(snapshot.settings),
    chooseAccountDirectory: vi.fn().mockResolvedValue(null),
    chooseGrokDirectory: vi.fn().mockResolvedValue(null),
    revealSource: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
    revealManagedSource: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
    listConversations: vi.fn().mockResolvedValue(conversationListResult),
    getConversation: vi.fn().mockResolvedValue({
      conversation: conversationSummary,
      messages: [{ id: 'message-one', role: 'user', text: '请修复账号切换', timestamp: null }],
      totalMessages: 1,
      truncated: false
    }),
    revealConversation: vi.fn().mockResolvedValue({ ok: true, message: 'ok' }),
    deleteConversations: vi.fn().mockResolvedValue({
      deleted: 1,
      failed: 0,
      deletedIds: ['thread-one'],
      indexEntriesChanged: 4,
      errors: [],
      message: '已将 1 个对话移入 Windows 回收站；已清理 4 条本地索引。'
    }),
    previewSafeConversationCleanup: vi.fn().mockResolvedValue({
      count: 0,
      sizeBytes: 0,
      candidateIds: [],
      closedSubagents: 0,
      skippedOpen: 0,
      skippedRecent: 0,
      skippedUnknown: 0,
      graceMinutes: 60
    }),
    cleanupSafeConversations: vi.fn().mockResolvedValue({
      deleted: 0,
      failed: 0,
      deletedIds: [],
      indexEntriesChanged: 0,
      errors: [],
      message: '没有符合保守清理条件的已关闭子代理对话。'
    }),
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
    onCpaGrokTestProgress: vi.fn().mockImplementation(() => () => undefined),
    onCpaCodexTestProgress: vi.fn().mockImplementation(() => () => undefined),
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
    browserStorage.clear()
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: localStorageMock
    })
    window.codexSwitcher = api()
  })

  afterEach(() => cleanup())

  it('renders the operational account table and quota information', async () => {
    render(<App />)

    expect((await screen.findAllByText('person@example.com')).length).toBeGreaterThan(0)
    expect(screen.getByText('second@example.com')).toBeInTheDocument()
    expect(screen.getByText('80%')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '测试当前页面全部' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导入账号' })).toBeInTheDocument()
    expect(screen.getByText('正在使用')).toBeInTheDocument()
  })

  it('reloads only the page scope when navigating between account libraries', async () => {
    const bridge = api()
    vi.mocked(bridge.getPageSnapshot).mockResolvedValue(snapshot)
    window.codexSwitcher = bridge
    render(<App />)
    expect((await screen.findAllByText('person@example.com')).length).toBeGreaterThan(0)
    vi.mocked(bridge.getPageSnapshot).mockClear()

    fireEvent.click(screen.getByRole('button', { name: /^Grok 账号库/ }))
    await waitFor(() => expect(bridge.getPageSnapshot).toHaveBeenCalledWith('grok'))
    fireEvent.click(screen.getByRole('button', { name: /^CPA 账号管理/ }))
    await waitFor(() => expect(bridge.getPageSnapshot).toHaveBeenCalledWith('cpa'))
    fireEvent.click(screen.getByRole('button', { name: '定时切换' }))
    await waitFor(() => expect(bridge.getPageSnapshot).toHaveBeenCalledWith('automation'))

    expect(bridge.getSnapshot).toHaveBeenCalledTimes(1)
  })

  it('toggles additive multi-select by clicking account rows', async () => {
    render(<App />)
    const firstRow = await screen.findByRole('row', { name: /person@example\.com/ })
    const secondRow = screen.getByRole('row', { name: /second@example\.com/ })

    expect(screen.getByText('未选择账号')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '测试选中' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '切换账号' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '删除选中' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '修复历史会话' })).toBeEnabled()

    fireEvent.click(secondRow)
    expect(screen.getByLabelText('选择 second@example.com')).toBeChecked()
    expect(screen.getByLabelText('选择 person@example.com')).not.toBeChecked()
    expect(secondRow).toHaveClass('selected-row')

    fireEvent.click(firstRow)
    expect(screen.getByLabelText('选择 second@example.com')).toBeChecked()
    expect(screen.getByLabelText('选择 person@example.com')).toBeChecked()

    fireEvent.click(firstRow)
    expect(screen.getByLabelText('选择 person@example.com')).not.toBeChecked()
    expect(screen.getByLabelText('选择 second@example.com')).toBeChecked()
  })

  it('prunes selections that disappear after a rescan', async () => {
    const bridge = api()
    window.codexSwitcher = bridge
    render(<App />)
    const secondRow = await screen.findByRole('row', { name: /second@example\.com/ })
    fireEvent.click(secondRow)
    expect(screen.getByText('已选择 1 个账号')).toBeInTheDocument()

    vi.mocked(bridge.getSnapshot).mockResolvedValue({
      ...snapshot,
      accounts: snapshot.accounts.filter((account) => account.id !== 'account-b')
    })
    fireEvent.click(screen.getByRole('button', { name: '重新扫描' }))

    await waitFor(() => {
      expect(screen.queryByText('second@example.com')).not.toBeInTheDocument()
      expect(screen.queryByText('已选择 1 个账号')).not.toBeInTheDocument()
      expect(screen.getByText('未选择账号')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: '测试选中' })).toBeDisabled()
    })
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
        sourcePath: 'E:\\app\\aa\\grok\\grok@example.com_supergrok.json',
        sourceFormat: 'json',
        sourceDialect: 'cpa',
        canRefresh: true,
        expiresAt: '2030-01-01T00:00:00Z',
        lastRefresh: '2026-07-16T00:00:00Z',
        status: 'untested',
        detail: '未测试',
        lastCheckedAt: null,
        usage: null,
        disabled: false
      }]
    }
    vi.mocked(bridge.getSnapshot).mockResolvedValue(grokSnapshot)
    window.codexSwitcher = bridge
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /^Grok 账号库/ }))
    const grokRow = await screen.findByRole('row', { name: /grok@example\.com/ })
    fireEvent.click(grokRow)
    expect(screen.getByLabelText('选择 Grok grok@example.com')).toBeChecked()
    expect(grokRow).toHaveClass('selected-row')
    fireEvent.click(screen.getByRole('button', { name: '测试当前页面全部' }))

    await waitFor(() => expect(bridge.testGrokAccounts).toHaveBeenCalledWith(['g'.repeat(64)]))
    expect(bridge.testAccounts).not.toHaveBeenCalled()
    expect(bridge.testCpaGrokAccounts).not.toHaveBeenCalled()
  })

  it('manages CPA Codex files independently and supports additive row selection', async () => {
    const bridge = api()
    const cpaSnapshot: AppSnapshot = {
      ...snapshot,
      cpaCodexAccounts: [{
        id: 'c'.repeat(64),
        email: 'cpa-codex@example.com',
        workspaceId: 'workspace-cpa',
        planType: 'team',
        sourcePath: 'E:\\cpa\\codex-cpa.json',
        sourceDialect: 'cpa',
        canRefresh: true,
        accessExpiresAt: '2030-01-01T00:00:00Z',
        lastRefresh: '2026-07-16T00:00:00Z',
        status: 'valid',
        detail: '有效',
        lastCheckedAt: '2026-07-16T01:00:00Z',
        usage: null,
        disabled: false
      }]
    }
    vi.mocked(bridge.getSnapshot).mockResolvedValue(cpaSnapshot)
    window.codexSwitcher = bridge
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /^CPA 账号管理/ }))
    fireEvent.click(screen.getByRole('button', { name: '同步全部到 aa' }))
    await waitFor(() => expect(bridge.syncCpaCodexToLibrary).toHaveBeenCalledWith(undefined))
    const row = await screen.findByRole('row', { name: /cpa-codex@example\.com/ })
    fireEvent.click(row)
    expect(screen.getByLabelText('选择 CPA Codex cpa-codex@example.com')).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: '同步选中到 aa' }))
    await waitFor(() => expect(bridge.syncCpaCodexToLibrary).toHaveBeenCalledWith(['c'.repeat(64)]))
    fireEvent.click(screen.getByRole('button', { name: '停用 .json.0' }))

    await waitFor(() => expect(bridge.setCpaCodexEnabled).toHaveBeenCalledWith(['c'.repeat(64)], false))
    expect(bridge.setGrokEnabled).not.toHaveBeenCalled()

    fireEvent.contextMenu(await screen.findByRole('row', { name: /cpa-codex@example\.com/ }), { clientX: 120, clientY: 160 })
    fireEvent.click(screen.getByRole('menuitem', { name: '打开文件位置' }))
    await waitFor(() => expect(bridge.revealManagedSource).toHaveBeenCalledWith('cpa-codex', 'c'.repeat(64)))
  })

  it('imports every supported file from a selected folder', async () => {
    vi.mocked(window.codexSwitcher.previewAnyDirectory).mockResolvedValue(importPreview())
    vi.mocked(window.codexSwitcher.commitImportPreview).mockResolvedValue(importCommit({
      imported: 2,
      recognized: 2,
      codexImported: 2,
      added: 2
    }))
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '导入账号' }))
    fireEvent.click(screen.getByRole('button', { name: '导入文件夹' }))

    await waitFor(() => expect(window.codexSwitcher.previewAnyDirectory).toHaveBeenCalledTimes(1))
    const preview = await screen.findByRole('dialog', { name: '导入预检' })
    fireEvent.click(within(preview).getByRole('button', { name: '确认写入 aa' }))
    await waitFor(() => expect(window.codexSwitcher.commitImportPreview).toHaveBeenCalledWith({
      sessionId: '00000000-0000-4000-8000-000000000001',
      decisions: { 'codex:account-import': 'add' }
    }))
    expect(await screen.findByText('导入完成：新增 2，更新 0，跳过 0')).toBeInTheDocument()
  })

  it('shows newly imported Codex accounts even when the previous filter hid untested rows', async () => {
    const bridge = api()
    const importedAccount = {
      ...snapshot.accounts[1],
      id: 'account-new',
      email: 'newly-imported@example.com',
      sourcePath: 'E:\\accounts\\newly-imported.json'
    }
    vi.mocked(bridge.previewAnyDirectory).mockResolvedValue(importPreview({
      items: [{
        ...importPreview().items[0],
        credentialId: 'account-new',
        key: 'codex:account-new',
        email: 'newly-imported@example.com'
      }]
    }))
    vi.mocked(bridge.commitImportPreview).mockResolvedValue(importCommit({
      accounts: [...snapshot.accounts, importedAccount],
      added: 1
    }))
    window.codexSwitcher = bridge
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')
    fireEvent.change(screen.getByLabelText('Codex 状态筛选'), { target: { value: 'valid' } })
    fireEvent.change(screen.getByPlaceholderText('搜索邮箱、文件或错误'), { target: { value: 'person' } })

    fireEvent.click(screen.getByRole('button', { name: '导入账号' }))
    fireEvent.click(screen.getByRole('button', { name: '导入文件夹' }))
    const preview = await screen.findByRole('dialog', { name: '导入预检' })
    fireEvent.click(within(preview).getByRole('button', { name: '确认写入 aa' }))

    expect(await screen.findByLabelText('选择 newly-imported@example.com')).toBeInTheDocument()
    expect(screen.getByLabelText('Codex 状态筛选')).toHaveValue('')
    expect(screen.getByPlaceholderText('搜索邮箱、文件或错误')).toHaveValue('')
  })

  it('does not report success when the file picker is cancelled', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '导入账号' }))
    fireEvent.click(screen.getByRole('button', { name: '导入多个文件' }))

    expect(await screen.findByText('已取消操作')).toBeInTheDocument()
    expect(screen.queryByText(/文件导入完成/)).not.toBeInTheDocument()
  })

  it('reports partial import failures instead of hiding them behind a success message', async () => {
    vi.mocked(window.codexSwitcher.previewAnyFiles).mockResolvedValue(importPreview({
      errors: ['broken.json: invalid']
    }))
    vi.mocked(window.codexSwitcher.commitImportPreview).mockResolvedValue(importCommit({
      imported: 3,
      skipped: 2,
      recognized: 5,
      errors: ['broken.json: invalid'],
      codexImported: 2,
      codexSkipped: 1,
      grokImported: 1,
      grokSkipped: 1,
      added: 3,
      ignored: 2
    }))
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '导入账号' }))
    fireEvent.click(screen.getByRole('button', { name: '导入多个文件' }))
    const preview = await screen.findByRole('dialog', { name: '导入预检' })
    fireEvent.click(within(preview).getByRole('button', { name: '确认写入 aa' }))

    const result = await screen.findByText('导入完成：新增 3，更新 0，跳过 2；1 项存在问题')
    expect(result.closest('.message')).toHaveClass('warn')
  })

  it('blocks unrecognized sources until the user explicitly skips them', async () => {
    vi.mocked(window.codexSwitcher.previewAnyFiles).mockResolvedValue(importPreview({
      recognized: 0,
      items: [],
      unrecognized: [{
        key: 'unknown:0:broken.txt',
        sourcePath: 'E:\\incoming\\broken.txt',
        sourceFormat: 'txt',
        detail: '未找到可用凭据'
      }]
    }))
    vi.mocked(window.codexSwitcher.commitImportPreview).mockResolvedValue(importCommit({ skipped: 1, ignored: 1 }))
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '导入账号' }))
    fireEvent.click(screen.getByRole('button', { name: '导入多个文件' }))
    const preview = await screen.findByRole('dialog', { name: '导入预检' })
    const confirm = within(preview).getByRole('button', { name: '确认写入 aa' })
    expect(confirm).toBeDisabled()
    expect(within(preview).getByText(/无法识别的来源/)).toBeInTheDocument()

    fireEvent.click(within(preview).getByLabelText('我确认跳过以上未识别内容'))
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(window.codexSwitcher.commitImportPreview).toHaveBeenCalledWith({
      sessionId: '00000000-0000-4000-8000-000000000001',
      decisions: {},
      skipUnrecognized: true
    }))
  })

  it('lets the user choose a parser for an unrecognized source before importing it', async () => {
    const bridge = api()
    const sourceKey = 'unknown:0:tokens.txt'
    vi.mocked(bridge.previewAnyFiles).mockResolvedValue(importPreview({
      unrecognized: [{
        key: sourceKey,
        sourcePath: 'E:\\incoming\\tokens.txt',
        sourceFormat: 'txt',
        detail: '未找到可用凭据'
      }]
    }))
    vi.mocked(bridge.refineImportPreview).mockResolvedValue(importPreview({
      recognized: 2,
      unrecognized: [],
      items: [
        ...importPreview().items,
        {
          ...importPreview().items[0],
          key: 'refined-codex:manual-account',
          credentialId: 'manual-account',
          email: 'manual@example.com',
          sourcePath: 'E:\\incoming\\tokens.txt',
          sourceFormat: 'txt'
        }
      ]
    }))
    window.codexSwitcher = bridge
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '导入账号' }))
    fireEvent.click(screen.getByRole('button', { name: '导入多个文件' }))
    const preview = await screen.findByRole('dialog', { name: '导入预检' })
    fireEvent.change(within(preview).getByLabelText(`${sourceKey} 的手动识别方式`), {
      target: { value: 'codex_rt' }
    })
    fireEvent.click(within(preview).getByRole('button', { name: '重新识别' }))

    await waitFor(() => expect(bridge.refineImportPreview).toHaveBeenCalledWith({
      sessionId: '00000000-0000-4000-8000-000000000001',
      sourceKey,
      mode: 'codex_rt'
    }))
    expect(await within(preview).findByText('manual@example.com')).toBeInTheDocument()
    expect(within(preview).queryByText(/无法识别的来源/)).not.toBeInTheDocument()
    expect(within(preview).getByRole('button', { name: '确认写入 aa' })).toBeEnabled()
  })

  it('persists an account alias, group, tags and note from the selection toolbar', async () => {
    const bridge = api()
    window.codexSwitcher = bridge
    render(<App />)
    fireEvent.click(await screen.findByRole('row', { name: /person@example\.com/ }))
    fireEvent.click(screen.getByRole('button', { name: '标签与分组' }))

    const dialog = await screen.findByRole('dialog', { name: '账号标签与分组' })
    fireEvent.change(within(dialog).getByLabelText('账号别名'), { target: { value: '主力 Plus' } })
    fireEvent.change(within(dialog).getByLabelText(/分组/), { target: { value: '日常' } })
    fireEvent.change(within(dialog).getByLabelText(/标签/), { target: { value: '稳定, 高优先级' } })
    fireEvent.change(within(dialog).getByLabelText('备注'), { target: { value: '本机备注' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(bridge.updateAccountMetadata).toHaveBeenCalledWith({
      accountIds: ['account-a'],
      alias: '主力 Plus',
      group: '日常',
      tags: ['稳定', '高优先级'],
      tagMode: 'replace',
      note: '本机备注'
    }))
  })

  it('previews library health issues and repairs only after confirmation', async () => {
    const bridge = api()
    vi.mocked(bridge.inspectLibraries).mockResolvedValue({
      snapshotId: '00000000-0000-4000-8000-000000000010',
      generatedAt: '2026-07-16T00:00:00.000Z',
      scannedFiles: 3,
      healthyAccounts: 2,
      issues: [{
        id: 'a'.repeat(24),
        scope: 'aa-codex',
        severity: 'warning',
        kind: 'duplicate_identity',
        title: 'Codex 同一账号存在多个文件',
        detail: '同一稳定身份出现在 2 个凭证文件中',
        paths: ['E:\\aa\\one.json', 'E:\\aa\\two.json'],
        accountIds: ['account-a'],
        repairable: true,
        repairAction: '保留信息最完整的凭证并统一为一账号一文件'
      }]
    })
    window.codexSwitcher = bridge
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')
    fireEvent.click(screen.getByText('更多'))
    fireEvent.click(screen.getByRole('button', { name: '账号库体检' }))

    const dialog = await screen.findByRole('dialog', { name: '账号库体检' })
    expect(within(dialog).getByText('Codex 同一账号存在多个文件')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: '修复选中' }))
    const confirmation = await screen.findByRole('alertdialog', { name: '修复 1 项账号库问题' })
    fireEvent.click(within(confirmation).getByRole('button', { name: '确认修复' }))

    await waitFor(() => expect(bridge.repairLibraries).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000010',
      ['a'.repeat(24)]
    ))
  })

  it('filters by persistent status and searches workspace text', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.change(screen.getByLabelText('Codex 状态筛选'), { target: { value: 'valid' } })
    expect(screen.getByRole('row', { name: /person@example\.com/ })).toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /second@example\.com/ })).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Codex 状态筛选'), { target: { value: '' } })
    fireEvent.change(screen.getByPlaceholderText('搜索邮箱、文件或错误'), {
      target: { value: 'workspace-b' }
    })
    expect(screen.getByRole('row', { name: /second@example\.com/ })).toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /person@example\.com/ })).not.toBeInTheDocument()
  })

  it('derives and combines account type, email domain and actual failure reason filters', async () => {
    const bridge = api()
    vi.mocked(bridge.getSnapshot).mockResolvedValue({
      ...snapshot,
      accounts: [
        snapshot.accounts[0],
        {
          ...snapshot.accounts[1],
          id: 'invalid-team',
          email: 'invalid-team@outlook.com',
          planType: 'team',
          status: 'invalid',
          detail: 'Refresh token 已失效'
        },
        {
          ...snapshot.accounts[1],
          id: 'error-team',
          email: 'error-team@outlook.com',
          planType: 'team',
          status: 'network_error',
          detail: 'CPA 网络超时'
        },
        {
          ...snapshot.accounts[1],
          id: 'weekly-plus',
          email: 'weekly@proton.me',
          planType: 'plus',
          status: 'quota_exhausted_weekly',
          detail: '周额度耗尽'
        }
      ]
    })
    window.codexSwitcher = bridge
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    expect(screen.queryByRole('button', { name: /^未测试/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^5 小时额度耗尽/ })).not.toBeInTheDocument()
    expect(within(screen.getByLabelText('Codex账号类型')).getByRole('option', { name: /plus/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^已失效/ }))
    expect(within(screen.getByLabelText('Codex账号类型')).queryByRole('option', { name: /plus/ })).not.toBeInTheDocument()
    expect(within(screen.getByLabelText('Codex账号类型')).getByRole('option', { name: /team/ })).toBeInTheDocument()
    expect(within(screen.getByLabelText('Codex邮箱域名')).queryByRole('option', { name: /example\.com/ })).not.toBeInTheDocument()
    expect(within(screen.getByLabelText('Codex失效或错误原因')).queryByRole('option', { name: /CPA 网络超时/ })).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Codex账号类型'), { target: { value: 'team' } })
    expect(screen.getByRole('row', { name: /invalid-team@outlook\.com/ })).toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /error-team@outlook\.com/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /person@example\.com/ })).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Codex邮箱域名'), { target: { value: 'outlook.com' } })
    fireEvent.change(screen.getByLabelText('Codex失效或错误原因'), { target: { value: 'Refresh token 已失效' } })
    expect(screen.getByRole('row', { name: /invalid-team@outlook\.com/ })).toBeInTheDocument()
    expect(screen.queryByRole('row', { name: /error-team@outlook\.com/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '测试当前页面全部' }))
    await waitFor(() => expect(bridge.testAccounts).toHaveBeenCalledWith(['invalid-team'], 'full'))
  })

  it('refreshes usage for only the active Codex account from the current-account summary', async () => {
    const bridge = api()
    window.codexSwitcher = bridge
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '刷新额度' }))

    await waitFor(() => expect(bridge.testAccounts).toHaveBeenCalledWith(['account-a'], 'usage'))
  })

  it('tests only the accounts visible under the current Codex status filter', async () => {
    const bridge = api()
    window.codexSwitcher = bridge
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.change(screen.getByLabelText('Codex 状态筛选'), { target: { value: 'valid' } })
    fireEvent.click(screen.getByRole('button', { name: '测试当前页面全部' }))

    await waitFor(() => expect(bridge.testAccounts).toHaveBeenCalledWith(['account-a'], 'full'))
  })

  it('tests only the visible CPA Codex status group', async () => {
    const bridge = api()
    vi.mocked(bridge.getSnapshot).mockResolvedValue({
      ...snapshot,
      cpaCodexAccounts: [
        {
          id: 'c'.repeat(64), email: 'valid-cpa@example.com', workspaceId: 'workspace-valid',
          planType: 'plus', sourcePath: 'E:\\cpa\\valid.json', sourceDialect: 'cpa',
          canRefresh: true, accessExpiresAt: null, lastRefresh: null, status: 'valid',
          detail: '有效', lastCheckedAt: null, usage: null, disabled: false
        },
        {
          id: 'd'.repeat(64), email: 'invalid-cpa@example.com', workspaceId: 'workspace-invalid',
          planType: 'team', sourcePath: 'E:\\cpa\\invalid.json.0', sourceDialect: 'cpa',
          canRefresh: false, accessExpiresAt: null, lastRefresh: null, status: 'invalid',
          detail: '已失效', lastCheckedAt: null, usage: null, disabled: true
        }
      ]
    })
    window.codexSwitcher = bridge
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /^CPA 账号管理/ }))
    fireEvent.click(screen.getByRole('button', { name: /^已失效/ }))
    fireEvent.click(screen.getByRole('button', { name: '测试当前页面全部' }))

    await waitFor(() => expect(bridge.testCpaCodexAccounts).toHaveBeenCalledWith(['d'.repeat(64)], 'full'))
  })

  it('tests only the visible Grok quota status group', async () => {
    const bridge = api()
    vi.mocked(bridge.getSnapshot).mockResolvedValue({
      ...snapshot,
      grokAccounts: [
        {
          id: 'e'.repeat(64), email: 'valid-grok@example.com', subject: 'grok-valid', teamId: null,
          planType: 'SuperGrok', sourcePath: 'E:\\app\\aa\\grok\\valid-grok@example.com_supergrok.json', sourceFormat: 'json',
          sourceDialect: 'cpa', canRefresh: true, expiresAt: null, lastRefresh: null,
          status: 'valid', detail: '有效', lastCheckedAt: null, usage: null, disabled: false
        },
        {
          id: 'f'.repeat(64), email: 'limited-grok@example.com', subject: 'grok-limited', teamId: null,
          planType: 'SuperGrok', sourcePath: 'E:\\app\\aa\\grok\\limited-grok@example.com_supergrok.json.0', sourceFormat: 'json',
          sourceDialect: 'cpa', canRefresh: true, expiresAt: null, lastRefresh: null,
          status: 'quota_exhausted_weekly', detail: '周额度耗尽', lastCheckedAt: null,
          usage: null, disabled: true
        }
      ]
    })
    window.codexSwitcher = bridge
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /^Grok 账号库/ }))
    fireEvent.click(screen.getByRole('button', { name: /^周额度耗尽/ }))
    fireEvent.click(screen.getByRole('button', { name: '测试当前页面全部' }))

    await waitFor(() => expect(bridge.testGrokAccounts).toHaveBeenCalledWith(['f'.repeat(64)]))
    expect(bridge.testCpaGrokAccounts).not.toHaveBeenCalled()
  })

  it('keeps CPA Grok accounts and actions separate from the local Grok library', async () => {
    const bridge = api()
    vi.mocked(bridge.getSnapshot).mockResolvedValue({
      ...snapshot,
      grokAccounts: [],
      cpaGrokAccounts: [{
        id: '9'.repeat(64), email: 'cpa-grok@example.com', subject: 'cpa-grok', teamId: null,
        planType: 'SuperGrok', sourcePath: 'E:\\cpa\\grok-cpa-grok@example.com-supergrok.json',
        sourceFormat: 'json', sourceDialect: 'cpa', canRefresh: true, expiresAt: null,
        lastRefresh: null, status: 'valid', detail: '有效', lastCheckedAt: null,
        usage: null, disabled: false
      }]
    })
    window.codexSwitcher = bridge
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /^CPA 账号管理/ }))
    fireEvent.click(screen.getByRole('navigation', { name: 'CPA 账号类型' }).querySelectorAll('button')[1])
    expect(await screen.findByText('cpa-grok@example.com')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '同步全部到 aa' }))
    await waitFor(() => expect(bridge.syncCpaGrokToLibrary).toHaveBeenCalledWith(undefined))
    fireEvent.click(screen.getByRole('button', { name: '测试当前页面全部' }))

    await waitFor(() => expect(bridge.testCpaGrokAccounts).toHaveBeenCalledWith(['9'.repeat(64)]))
    expect(bridge.testGrokAccounts).not.toHaveBeenCalled()

    fireEvent.contextMenu(await screen.findByRole('row', { name: /cpa-grok@example\.com/ }), { clientX: 120, clientY: 160 })
    fireEvent.click(screen.getByRole('menuitem', { name: '打开文件位置' }))
    await waitFor(() => expect(bridge.revealManagedSource).toHaveBeenCalledWith('cpa-grok', '9'.repeat(64)))
  })

  it('deletes selected accounts only after confirmation', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByLabelText('选择 person@example.com'))
    fireEvent.click(screen.getByRole('button', { name: '删除选中' }))
    const confirmation = await screen.findByRole('alertdialog', { name: '删除 1 个账号' })
    expect(confirmation).toHaveTextContent('外部源文件不会被修改')
    fireEvent.click(within(confirmation).getByRole('button', { name: '确认删除' }))

    await waitFor(() =>
      expect(window.codexSwitcher.deleteAccounts).toHaveBeenCalledWith(['account-a'])
    )
  })

  it('tests only selected accounts', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByLabelText('选择 person@example.com'))
    fireEvent.click(screen.getByRole('button', { name: '测试选中' }))

    await waitFor(() =>
      expect(window.codexSwitcher.testAccounts).toHaveBeenCalledWith(['account-a'], 'full')
    )
  })

  it('uses the selected Codex test mode for filtered and selected tests', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '仅额度' }))
    fireEvent.click(screen.getByLabelText('选择 person@example.com'))
    fireEvent.click(screen.getByRole('button', { name: '测试选中' }))

    await waitFor(() =>
      expect(window.codexSwitcher.testAccounts).toHaveBeenCalledWith(['account-a'], 'usage')
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
      expect(window.codexSwitcher.testAccounts).toHaveBeenCalledWith(['account-a'], 'full')
    )
  })

  it('switches and restarts the exact account chosen from the context menu', async () => {
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
    const confirmation = await screen.findByRole('alertdialog', { name: '切换账号并重启' })
    fireEvent.click(within(confirmation).getByRole('button', { name: '继续切换并重启' }))

    await waitFor(() =>
      expect(window.codexSwitcher.switchAccount).toHaveBeenCalledWith('account-a', true)
    )
    expect(await screen.findByText('切换成功，Codex 已重启')).toBeInTheDocument()
    expect(screen.getAllByRole('status')).toHaveLength(1)
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
    const confirmation = await screen.findByRole('alertdialog', { name: '切换账号并重启' })
    fireEvent.click(within(confirmation).getByRole('button', { name: '继续切换并重启' }))

    const warning = await screen.findByText(/账号已完成切换，可手动重启 Codex/)
    expect(warning.closest('.message')).toHaveClass('warn')
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

    fireEvent.click(screen.getByText('更多'))
    fireEvent.click(screen.getByRole('button', { name: '恢复备份 API' }))

    await waitFor(() => expect(window.codexSwitcher.restoreApiMode).toHaveBeenCalledWith(false))
  })

  it('asks whether to restart Codex after saving a custom API without repairing conversations', async () => {
    const bridge = api()
    window.codexSwitcher = bridge
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByText('更多'))
    fireEvent.click(screen.getByRole('button', { name: '自定义 API' }))
    fireEvent.change(screen.getByLabelText('API 地址'), {
      target: { value: 'http://127.0.0.1:18317' }
    })
    fireEvent.change(screen.getByLabelText('API Key'), {
      target: { value: 'temporary-custom-key' }
    })
    fireEvent.click(screen.getByRole('button', { name: '保存并切换' }))

    await waitFor(() => expect(bridge.switchToCustomApi).toHaveBeenCalledWith({
      baseUrl: 'http://127.0.0.1:18317',
      model: 'gpt-5.4',
      apiKey: 'temporary-custom-key'
    }, false))
    const confirmation = await screen.findByRole('alertdialog', { name: '重启 Codex 使 API 生效' })
    expect(confirmation).toHaveTextContent('历史对话仍保留在原来的 openai 分组')
    fireEvent.click(within(confirmation).getByRole('button', { name: '立即重启' }))
    await waitFor(() => expect(bridge.restartCodex).toHaveBeenCalledTimes(1))
    expect(bridge.previewSessionRepair).not.toHaveBeenCalled()
  })

  it('previews and confirms Codex++ style historical session repair', async () => {
    render(<App />)
    const accountSelection = await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(accountSelection)
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

  it('searches, views and selectively synchronizes Codex conversations', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '对话管理' }))
    expect(await screen.findByRole('dialog', { name: 'Codex 对话管理' })).toBeInTheDocument()
    expect(await screen.findByText('修复账号切换')).toBeInTheDocument()

    fireEvent.click(screen.getByText('修复账号切换'))
    expect(await screen.findByText('请修复账号切换')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '选择 修复账号切换' }))
    fireEvent.click(screen.getByRole('button', { name: '同步选中' }))

    await waitFor(() => expect(window.codexSwitcher.previewSessionRepair).toHaveBeenCalledWith(
      undefined,
      ['thread-one']
    ))
  })

  it('deletes selected Codex conversations only after confirmation', async () => {
    const bridge = window.codexSwitcher
    vi.mocked(bridge.listConversations)
      .mockResolvedValueOnce({
        ...conversationListResult,
        items: [conversationSummary]
      })
      .mockResolvedValue({ ...conversationListResult, items: [], total: 0 })

    render(<App />)
    await screen.findByLabelText('选择 person@example.com')
    fireEvent.click(screen.getByRole('button', { name: '对话管理' }))
    const dialog = await screen.findByRole('dialog', { name: 'Codex 对话管理' })
    await within(dialog).findByText('修复账号切换')
    fireEvent.click(within(dialog).getByRole('button', { name: '选择 修复账号切换' }))
    fireEvent.click(within(dialog).getByRole('button', { name: '删除选中' }))

    const confirmation = await screen.findByRole('alertdialog', { name: '删除 1 个 Codex 对话' })
    expect(confirmation).toHaveTextContent('Windows 回收站')
    fireEvent.click(within(confirmation).getByRole('button', { name: '删除对话' }))
    await waitFor(() => expect(bridge.deleteConversations).toHaveBeenCalledWith(['thread-one']))
    expect(await screen.findByText(/已将 1 个对话移入 Windows 回收站/)).toBeInTheDocument()
  })

  it('filters subagents and conservatively cleans only previewed closed children', async () => {
    const bridge = window.codexSwitcher
    const child: ConversationSummary = {
      ...conversationSummary,
      id: 'thread-child',
      title: '检查配额接口',
      kind: 'subagent',
      subagentKind: 'thread_spawn',
      parentId: 'thread-one',
      parentTitle: '修复账号切换',
      depth: 1,
      agentNickname: 'Helper',
      agentRole: 'worker',
      lifecycleStatus: 'closed',
      safeToClean: true
    }
    vi.mocked(bridge.listConversations).mockResolvedValue({
      ...conversationListResult,
      items: [child],
      facets: {
        ...conversationListResult.facets,
        kinds: [{ value: 'subagent', label: '子代理', count: 1 }],
        subagentKinds: [{ value: 'thread_spawn', label: '派生代理', count: 1 }],
        lifecycleStatuses: [{ value: 'closed', label: '已关闭', count: 1 }]
      },
      safeCleanupCount: 1,
      safeCleanupBytes: 1024
    })
    vi.mocked(bridge.previewSafeConversationCleanup).mockResolvedValue({
      count: 1,
      sizeBytes: 1024,
      candidateIds: ['thread-child'],
      closedSubagents: 1,
      skippedOpen: 0,
      skippedRecent: 0,
      skippedUnknown: 0,
      graceMinutes: 60
    })
    vi.mocked(bridge.cleanupSafeConversations).mockResolvedValue({
      deleted: 1,
      failed: 0,
      deletedIds: ['thread-child'],
      indexEntriesChanged: 3,
      errors: [],
      message: '已将 1 个对话移入 Windows 回收站。'
    })

    render(<App />)
    await screen.findByLabelText('选择 person@example.com')
    fireEvent.click(screen.getByRole('button', { name: '对话管理' }))
    const dialog = await screen.findByRole('dialog', { name: 'Codex 对话管理' })
    await within(dialog).findByText('检查配额接口')
    fireEvent.change(within(dialog).getByLabelText('对话来源'), { target: { value: 'subagent' } })
    await waitFor(() => expect(bridge.listConversations).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'subagent' })
    ))
    fireEvent.click(within(dialog).getByRole('button', { name: '保守清理 1' }))

    await waitFor(() => expect(bridge.previewSafeConversationCleanup).toHaveBeenCalled())
    const confirmation = await screen.findByRole('alertdialog', { name: '保守清理 1 个子代理对话' })
    expect(confirmation).toHaveTextContent('主对话、可恢复代理和状态不明确的对话不会处理')
    fireEvent.click(within(confirmation).getByRole('button', { name: '开始清理' }))
    await waitFor(() => expect(bridge.cleanupSafeConversations).toHaveBeenCalled())
  })

  it('imports cleaned credentials pasted by the user', async () => {
    vi.mocked(window.codexSwitcher.previewAnyPasted).mockResolvedValue(importPreview())
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '导入账号' }))
    fireEvent.change(screen.getByLabelText('凭据文本'), {
      target: { value: '{"access_token":"secret"}' }
    })
    fireEvent.click(screen.getByRole('button', { name: '清洗并导入' }))

    await waitFor(() =>
      expect(window.codexSwitcher.previewAnyPasted).toHaveBeenCalledWith('{"access_token":"secret"}')
    )
  })

  it('clears pasted credentials when the import dialog is dismissed with Escape', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '导入账号' }))
    const input = screen.getByLabelText('凭据文本')
    fireEvent.change(input, { target: { value: 'rt.1.temporary-secret' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '导入账号' })).not.toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: '导入账号' }))
    expect(screen.getByLabelText('凭据文本')).toHaveValue('')
  })

  it('imports mobile refresh tokens using the explicit Sub2API client mode', async () => {
    vi.mocked(window.codexSwitcher.previewRefreshTokens).mockResolvedValue(importPreview())
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '导入账号' }))
    fireEvent.click(screen.getByRole('button', { name: '移动端 RT' }))
    fireEvent.change(screen.getByLabelText('凭据文本'), {
      target: { value: 'rt.1.temporary-refresh-token-value' }
    })
    fireEvent.click(screen.getByRole('button', { name: '清洗并导入' }))

    await waitFor(() =>
      expect(window.codexSwitcher.previewRefreshTokens).toHaveBeenCalledWith(
        'rt.1.temporary-refresh-token-value',
        'mobile'
      )
    )
  })

  it('distinguishes recognized but invalid RTs from unrecognized input', async () => {
    vi.mocked(window.codexSwitcher.previewRefreshTokens).mockResolvedValueOnce(importPreview({
      recognized: 94,
      errors: ['#1：Codex RT：invalid_refresh_token: Invalid refresh token.'],
      items: []
    }))
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '导入账号' }))
    fireEvent.click(screen.getByRole('button', { name: 'Codex RT' }))
    fireEvent.change(screen.getByLabelText('凭据文本'), {
      target: { value: 'rt.1.invalid-refresh-token-value' }
    })
    fireEvent.click(screen.getByRole('button', { name: '清洗并导入' }))

    expect(await screen.findByText(/已识别 94 条，但均未完成导入/)).toBeInTheDocument()
    expect(screen.queryByText(/未识别到 Codex 或 Grok 账号/)).not.toBeInTheDocument()
  })

  it('completes the Sub2API-style browser OAuth flow from a pasted callback URL', async () => {
    vi.mocked(window.codexSwitcher.previewOAuthComplete).mockResolvedValue(importPreview())
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')

    fireEvent.click(screen.getByRole('button', { name: '导入账号' }))
    fireEvent.click(screen.getByRole('button', { name: '浏览器授权' }))
    fireEvent.click(screen.getByRole('button', { name: '打开 OpenAI 授权页' }))
    await waitFor(() => expect(window.codexSwitcher.startOAuthAuthorization).toHaveBeenCalled())
    const callback = 'http://localhost:1455/auth/callback?code=test-code&state=test-state'
    fireEvent.change(screen.getByLabelText('凭据文本'), { target: { value: callback } })
    fireEvent.click(screen.getByRole('button', { name: '完成授权并导入' }))

    await waitFor(() => expect(window.codexSwitcher.previewOAuthComplete).toHaveBeenCalledWith(
      '0123456789abcdef0123456789abcdef',
      callback
    ))
  })

  it('exports selected accounts using the chosen native format and layout', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')
    fireEvent.click(screen.getByLabelText('选择 person@example.com'))
    fireEvent.click(screen.getByLabelText('选择 second@example.com'))

    fireEvent.click(screen.getByRole('button', { name: '导出账号' }))
    fireEvent.click(screen.getByRole('button', { name: 'SubAPI' }))
    fireEvent.click(screen.getByRole('button', { name: '合并单文件' }))
    fireEvent.click(screen.getByLabelText('分别设置每个账号'))
    fireEvent.change(screen.getByLabelText('person@example.com 的优先级'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('second@example.com 的优先级'), { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: '选择目录并导出' }))

    await waitFor(() =>
      expect(window.codexSwitcher.exportAccounts).toHaveBeenCalledWith({
        accountIds: ['account-a', 'account-b'],
        format: 'sub2api',
        layout: 'bundle',
        defaultPriority: 10,
        priorities: { 'account-a': 5, 'account-b': 20 }
      })
    )
  })

  it('exports selected accounts as official Codex auth documents', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')
    fireEvent.click(screen.getByLabelText('选择 person@example.com'))

    fireEvent.click(screen.getByRole('button', { name: '导出账号' }))
    fireEvent.click(screen.getByRole('button', { name: 'Codex auth.json' }))
    fireEvent.click(screen.getByRole('button', { name: '选择目录并导出' }))

    await waitFor(() =>
      expect(window.codexSwitcher.exportAccounts).toHaveBeenCalledWith({
        accountIds: ['account-a'],
        format: 'codex',
        layout: 'separate'
      })
    )
  })

  it('persists and applies the light and dark themes', async () => {
    render(<App />)
    await screen.findByLabelText('选择 person@example.com')
    expect(document.documentElement.dataset.theme).toBe('light')

    fireEvent.click(screen.getByRole('button', { name: '切换到深色模式' }))

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(window.localStorage.getItem('codex-account-switcher/theme')).toBe('dark')
    expect(screen.getByRole('button', { name: '切换到浅色模式' })).toBeInTheDocument()
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

    expect((await screen.findAllByText('已失效')).length).toBeGreaterThan(0)
    expect(screen.getByText('凭据已失效')).toBeInTheDocument()
  })
})
