import {
  CheckCircle2,
  CircleAlert,
  ClipboardPaste,
  Copy,
  Download,
  FolderInput,
  FolderOpen,
  Import,
  KeyRound,
  ListChecks,
  LoaderCircle,
  PackageOpen,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Square,
  TestTube2,
  TimerReset,
  Trash2,
  Wrench,
  X
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AppSnapshot, UpdateState } from '../../shared/ipc'
import type {
  AccountStatus,
  AccountSummary,
  AppSettings,
  DisplayAccountStatus,
  CredentialExportFormat,
  CredentialExportLayout,
  ScanResult,
  SessionRepairPreview,
  UsageWindow
} from '../../shared/types'
import { GrokPage } from './GrokPage'

const STATUS_LABELS: Record<DisplayAccountStatus, string> = {
  untested: '未测试',
  valid: '有效',
  quota_exhausted_5h: '5 小时额度耗尽',
  quota_exhausted_weekly: '周额度耗尽',
  invalid: '已失效',
  unknown_error: '未知错误'
}

function displayStatus(status: AccountStatus): DisplayAccountStatus {
  if (status === 'untested' || status === 'valid' || status === 'quota_exhausted_5h' || status === 'quota_exhausted_weekly') return status
  if (status === 'quota_exhausted') return 'quota_exhausted_5h'
  if (['invalid', 'no_permission', 'workspace_deactivated', 'non_refreshable'].includes(status)) return 'invalid'
  return 'unknown_error'
}

function dateTime(value: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function resetText(window: UsageWindow): string {
  if (window.resetAt) return dateTime(window.resetAt)
  if (window.resetInSeconds !== null) {
    const hours = Math.floor(window.resetInSeconds / 3600)
    const minutes = Math.floor((window.resetInSeconds % 3600) / 60)
    return hours > 0 ? `${hours}小时${minutes}分钟` : `${minutes}分钟`
  }
  return '-'
}

function Quota({
  account,
  running = false
}: {
  account: AccountSummary
  running?: boolean
}): React.JSX.Element {
  if (running) {
    return (
      <span className="testing-inline">
        <LoaderCircle className="spin" size={14} />正在刷新额度
      </span>
    )
  }
  if (!account.usage) return <span className="muted">-</span>
  const { windows, credits, spendLimit, resetCreditsAvailable } = account.usage
  if (
    windows.length === 0 &&
    !credits &&
    !spendLimit &&
    resetCreditsAvailable == null
  ) return <span className="muted">-</span>
  return (
    <div className="quota-list">
      {windows.slice(0, 3).map((window) => {
        const remaining = window.remainingPercent
        const className = remaining !== null && remaining <= 10 ? 'danger' : remaining !== null && remaining <= 30 ? 'warn' : ''
        return (
          <div className="quota-item" key={window.id}>
            <div className="quota-label">
              <span>{window.label}</span>
              <strong>{remaining === null ? '-' : `${Math.round(remaining)}%`}</strong>
            </div>
            <div className="quota-track">
              <div className={`quota-fill ${className}`} style={{ width: `${remaining ?? 0}%` }} />
            </div>
            <span className="quota-reset">重置 {resetText(window)}</span>
          </div>
        )
      })}
      {credits && (
        <div className="quota-meta">
          <span>额外余额</span>
          <strong>{credits.unlimited ? '无限' : credits.balance ?? (credits.hasCredits ? '可用' : '0')}</strong>
        </div>
      )}
      {spendLimit && (
        <div className="quota-meta" title={spendLimit.resetAt ? `重置 ${dateTime(spendLimit.resetAt)}` : undefined}>
          <span>支出限额</span>
          <strong>{spendLimit.remainingPercent !== null ? `${Math.round(spendLimit.remainingPercent)}%` : spendLimit.remaining ?? '-'}</strong>
        </div>
      )}
      {resetCreditsAvailable != null && (
        <div className="quota-meta"><span>重置券</span><strong>{resetCreditsAvailable}</strong></div>
      )}
    </div>
  )
}

export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [keyword, setKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState<DisplayAccountStatus | ''>('')
  const [activeView, setActiveView] = useState<'accounts' | 'grok' | 'automation'>('accounts')
  const [automationKeyword, setAutomationKeyword] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null)
  const [customApiKey, setCustomApiKey] = useState('')
  const [message, setMessage] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [repairPreview, setRepairPreview] = useState<SessionRepairPreview | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [exportDialog, setExportDialog] = useState<{
    accountIds: string[]
    format: CredentialExportFormat
    layout: CredentialExportLayout
  } | null>(null)
  const [updateState, setUpdateState] = useState<UpdateState | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    account: AccountSummary
    x: number
    y: number
  } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  const reload = async (preserveSettingsDraft = false): Promise<void> => {
    const next = await window.codexSwitcher.getSnapshot()
    setSnapshot(next)
    if (!preserveSettingsDraft) setSettingsDraft(next.settings)
  }

  useEffect(() => {
    void reload()
    void window.codexSwitcher.getUpdateState().then(setUpdateState)
    const stopTesting = window.codexSwitcher.onTestProgress((testing) =>
      setSnapshot((current) => {
        if (!current) return current
        const accounts = testing.updatedAccount
          ? current.accounts.map((account) =>
              account.id === testing.updatedAccount?.id ? testing.updatedAccount : account
            )
          : current.accounts
        return { ...current, accounts, testing }
      })
    )
    const stopUpdates = window.codexSwitcher.onUpdateState(setUpdateState)
    const stopGrokTesting = window.codexSwitcher.onGrokTestProgress((grokTesting) =>
      setSnapshot((current) => {
        if (!current) return current
        const grokAccounts = grokTesting.updatedAccount
          ? current.grokAccounts.map((account) => account.id === grokTesting.updatedAccount?.id ? grokTesting.updatedAccount : account)
          : current.grokAccounts
        return { ...current, grokAccounts, grokTesting }
      })
    )
    const stopAutoSwitch = window.codexSwitcher.onAutoSwitchState((autoSwitch) => {
      setSnapshot((current) => current ? { ...current, autoSwitch } : current)
      if (!autoSwitch.running) void reload(true)
    })
    return () => {
      stopTesting()
      stopUpdates()
      stopGrokTesting()
      stopAutoSwitch()
    }
  }, [])

  useEffect(() => {
    if (!contextMenu) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && contextMenuRef.current?.contains(event.target)) return
      setContextMenu(null)
    }
    const close = (): void => setContextMenu(null)
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', closeOutside)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [contextMenu])

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return
    const margin = 8
    const bounds = contextMenuRef.current.getBoundingClientRect()
    const x = Math.max(margin, Math.min(contextMenu.x, window.innerWidth - bounds.width - margin))
    const y = Math.max(margin, Math.min(contextMenu.y, window.innerHeight - bounds.height - margin))
    if (x === contextMenu.x && y === contextMenu.y) return
    setContextMenu((current) => current ? { ...current, x, y } : null)
  }, [contextMenu])

  const accounts = useMemo(() => {
    if (!snapshot) return []
    const query = keyword.trim().toLowerCase()
    return snapshot.accounts.filter((account) => {
      if (statusFilter && displayStatus(account.status) !== statusFilter) return false
      if (!query) return true
      return `${account.email ?? ''} ${account.workspaceId ?? ''} ${account.planType ?? ''} ${account.sourceDialect} ${account.sourcePath} ${account.detail}`
        .toLowerCase()
        .includes(query)
    })
  }, [keyword, snapshot, statusFilter])

  const openExport = (ids?: string[]): void => {
    const accountIds = ids ?? (selected.size > 0 ? [...selected] : accounts.map((item) => item.id))
    if (accountIds.length === 0) {
      setMessage({ kind: 'error', text: '没有可导出的账号' })
      return
    }
    setExportDialog({ accountIds, format: 'cpa', layout: 'separate' })
  }

  const submitExport = async (): Promise<void> => {
    if (!exportDialog) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await window.codexSwitcher.exportAccounts(exportDialog)
      if (!result.cancelled) {
        setMessage({ kind: result.ok ? 'ok' : 'error', text: result.message })
        setExportDialog(null)
      }
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const submitPaste = async (): Promise<void> => {
    if (!pasteText.trim()) return
    await run(async () => {
      const result = await window.codexSwitcher.importPasted(pasteText)
      if (result.imported === 0) throw new Error(result.errors[0] ?? '未提取到有效账号')
      setPasteOpen(false)
      setPasteText('')
    }, '粘贴内容已清洗并导入')
  }

  const checkForUpdates = async (): Promise<void> => {
    try {
      setUpdateState(await window.codexSwitcher.checkForUpdates())
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }

  const downloadUpdate = async (): Promise<void> => {
    try {
      await window.codexSwitcher.downloadUpdate()
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }

  const installUpdate = async (): Promise<void> => {
    if (!window.confirm('安装更新会退出应用并覆盖安装，继续吗？')) return
    try {
      await window.codexSwitcher.installUpdate()
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }

  const automationPatch = (): Pick<AppSettings, 'autoSwitchEnabled' | 'autoSwitchIntervalSeconds' | 'autoSwitchAccountIds' | 'autoSwitchRestartCodex'> => ({
    autoSwitchEnabled: settingsDraft!.autoSwitchEnabled,
    autoSwitchIntervalSeconds: settingsDraft!.autoSwitchIntervalSeconds,
    autoSwitchAccountIds: settingsDraft!.autoSwitchAccountIds,
    autoSwitchRestartCodex: settingsDraft!.autoSwitchRestartCodex
  })

  const saveAutomation = async (): Promise<void> => {
    if (settingsDraft?.autoSwitchEnabled && settingsDraft.autoSwitchAccountIds.length === 0) {
      setMessage({ kind: 'error', text: '启用自动切换前至少选择一个候选账号' })
      return
    }
    await run(() => window.codexSwitcher.updateSettings(automationPatch()), '自动切换设置已保存')
  }

  const saveAndRunAutomation = async (): Promise<void> => {
    if (!settingsDraft || settingsDraft.autoSwitchAccountIds.length === 0) {
      setMessage({ kind: 'error', text: '请先选择至少一个候选账号' })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      await window.codexSwitcher.updateSettings(automationPatch())
      const result = await window.codexSwitcher.runAutoSwitchNow()
      await reload()
      setMessage({ kind: result.ok ? 'ok' : 'warn', text: result.message })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const run = async (action: () => Promise<unknown>, success?: string): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      await action()
      await reload()
      if (success) setMessage({ kind: 'ok', text: success })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const runScan = async (
    action: () => Promise<ScanResult | null>,
    success: string
  ): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await action()
      if (!result) {
        setMessage({ kind: 'warn', text: '已取消操作' })
        return
      }
      await reload()
      const summary = `导入 ${result.imported}，跳过 ${result.skipped}`
      setMessage({
        kind: result.errors.length > 0 ? 'warn' : 'ok',
        text: result.errors.length > 0
          ? `${success}：${summary}，失败 ${result.errors.length}`
          : `${success}：${summary}`
      })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const switchAccount = async (id: string, restart: boolean): Promise<void> => {
    if (restart && !window.confirm('切换并重启会中断正在运行的 Codex 任务，继续吗？')) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await window.codexSwitcher.switchAccount(id, restart)
      if (!result.ok) throw new Error(result.message)
      await reload()
      setMessage({
        kind: result.restartResult && !result.restartResult.ok ? 'warn' : 'ok',
        text: restart ? result.message : '账号已切换，请重启 Codex 使所有会话生效'
      })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const switchSelected = async (restart: boolean): Promise<void> => {
    const id = [...selected][0]
    if (!id || selected.size !== 1) {
      setMessage({ kind: 'error', text: '请选择一个账号进行切换' })
      return
    }
    await switchAccount(id, restart)
  }

  const deleteAccounts = async (ids?: string[]): Promise<void> => {
    const accountIds = ids ?? [...selected]
    if (accountIds.length === 0) {
      setMessage({ kind: 'error', text: '请选择要删除的账号' })
      return
    }
    if (!window.confirm(`确定删除 ${accountIds.length} 个账号吗？aa 中对应的账号 JSON 会一并删除，外部原始文件不受影响。`)) {
      return
    }
    await run(async () => {
      const result = await window.codexSwitcher.deleteAccounts(accountIds)
      if (result.deleted === 0) throw new Error('没有删除任何账号')
      setSelected((current) => {
        const next = new Set(current)
        for (const id of accountIds) next.delete(id)
        return next
      })
    }, `已删除 ${accountIds.length} 个账号及对应凭证文件`)
  }

  const openContextMenu = (event: React.MouseEvent, account: AccountSummary): void => {
    event.preventDefault()
    setSelected(new Set([account.id]))
    setContextMenu({
      account,
      x: event.clientX,
      y: event.clientY
    })
  }

  const contextAction = (action: () => void | Promise<void>): void => {
    setContextMenu(null)
    void action()
  }

  const openSessionRepair = async (targetProvider?: string): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      setRepairPreview(await window.codexSwitcher.previewSessionRepair(targetProvider))
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const applySessionRepair = async (): Promise<void> => {
    if (!repairPreview) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await window.codexSwitcher.applySessionRepair(
        repairPreview.snapshotId,
        repairPreview.targetProvider
      )
      if (!result.ok) throw new Error(result.message)
      setRepairPreview(null)
      setMessage({ kind: 'ok', text: result.message })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  if (!snapshot || !settingsDraft) {
    return (
      <main className="loading-screen">
        <LoaderCircle className="spin" size={28} />
        <span>正在读取本地账号</span>
      </main>
    )
  }

  const counts = Object.keys(STATUS_LABELS).reduce<Record<string, number>>((result, status) => {
    result[status] = snapshot.accounts.filter((item) => displayStatus(item.status) === status).length
    return result
  }, {})
  const selectedAccount = selected.size === 1
    ? snapshot.accounts.find((account) => selected.has(account.id)) ?? null
    : null
  const automationAccounts = snapshot.accounts.filter((account) => {
    const query = automationKeyword.trim().toLowerCase()
    return !query || `${account.email ?? ''} ${account.planType ?? ''} ${account.detail}`.toLowerCase().includes(query)
  })
  const switchCapability = (account: AccountSummary): string => {
    if (!account.switchable) return '仅用于检测'
    const mode = account.switchMode ?? (account.canRefresh ? 'oauth' : 'external')
    return mode === 'oauth' ? '可切换 · 标准 OAuth' : '可切换 · 外部凭据，需重启'
  }
  const usesExternalAuth = (account: AccountSummary): boolean =>
    (account.switchMode ?? (account.canRefresh ? 'oauth' : 'external')) === 'external'

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-identity">
          <h1>Codex Account Switcher</h1>
          <p>{activeView === 'grok' ? snapshot.grokDirectory : snapshot.importDirectory}</p>
        </div>
        <nav className="view-tabs" aria-label="主页面">
          <button className={activeView === 'accounts' ? 'active' : ''} onClick={() => setActiveView('accounts')}>
            <ListChecks size={16} />Codex 账号库
          </button>
          <button className={activeView === 'grok' ? 'active' : ''} onClick={() => setActiveView('grok')}>
            <TestTube2 size={16} />Grok 账号库
          </button>
          <button className={activeView === 'automation' ? 'active' : ''} onClick={() => setActiveView('automation')}>
            <TimerReset size={16} />定时切换
          </button>
        </nav>
        <button className="icon-button" title="设置" aria-label="设置" onClick={() => setSettingsOpen(true)} disabled={busy}>
          <Settings size={19} />
        </button>
      </header>

      {message && (
        <div className={`message ${message.kind}`}>
          {message.kind === 'ok' ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
          {message.text}
        </div>
      )}

      {activeView === 'accounts' ? <div className="page-view accounts-view">

      <section className="summary-band">
        <div><span>账号</span><strong>{snapshot.accounts.length}</strong></div>
        <div><span>有效</span><strong className="text-ok">{counts.valid ?? 0}</strong></div>
        <div><span>5h 耗尽</span><strong className="text-warn">{counts.quota_exhausted_5h ?? 0}</strong></div>
        <div><span>周额度耗尽</span><strong className="text-warn">{counts.quota_exhausted_weekly ?? 0}</strong></div>
        <div><span>已失效 / 未知</span><strong className="text-error">{(counts.invalid ?? 0) + (counts.unknown_error ?? 0)}</strong></div>
        <div><span>当前账号</span><strong>{snapshot.accounts.find((item) => item.active)?.email ?? '未知/API 模式'}</strong></div>
        <div><span>自动切换</span><strong className={snapshot.autoSwitch.enabled ? 'text-ok' : ''}>{snapshot.autoSwitch.running ? '检测中' : snapshot.autoSwitch.enabled ? '已启用' : '关闭'}</strong></div>
      </section>

      <div className="toolbar">
        <button onClick={() => void runScan(() => window.codexSwitcher.importFiles(), '文件导入完成')} disabled={busy}>
          <Import size={16} />导入文件
        </button>
        <button onClick={() => void runScan(() => window.codexSwitcher.importDirectory(), '文件夹导入完成')} disabled={busy}>
          <FolderInput size={16} />导入文件夹
        </button>
        <button onClick={() => setPasteOpen(true)} disabled={busy}>
          <ClipboardPaste size={16} />粘贴导入
        </button>
        <button onClick={() => void runScan(() => window.codexSwitcher.scanDirectory(), 'aa 重新扫描完成')} disabled={busy}>
          <RefreshCw size={16} />重新扫描
        </button>
        <button onClick={() => openExport()} disabled={busy || snapshot.accounts.length === 0}>
          <Download size={16} />导出账号
        </button>
        <button className="danger-button" onClick={() => void deleteAccounts()} disabled={busy || selected.size === 0 || snapshot.testing.active}>
          <Trash2 size={16} />删除选中
        </button>
        <span className="toolbar-divider" />
        <button onClick={() => void run(() => window.codexSwitcher.testAccounts(), '全部账号检测完成')} disabled={busy || snapshot.testing.active}>
          <TestTube2 size={16} />测试全部
        </button>
        <button onClick={() => void run(() => window.codexSwitcher.testAccounts([...selected]), '选中账号检测完成')} disabled={busy || selected.size === 0 || snapshot.testing.active}>
          <Play size={16} />测试选中
        </button>
        {snapshot.testing.active && !snapshot.autoSwitch.running && (
          <button className="danger-button" onClick={() => void window.codexSwitcher.cancelTests()}>
            <Square size={15} />取消
          </button>
        )}
        <span className="toolbar-divider" />
        <button className="primary-button" onClick={() => void switchSelected(false)} disabled={busy || !selectedAccount?.switchable} title={selectedAccount && !selectedAccount.switchable ? '该账号缺少完整 OAuth 凭据，也没有可用的 Team/K12 workspace ID' : selectedAccount && usesExternalAuth(selectedAccount) ? '外部 Team/K12 凭据切换后必须重启 Codex，且 Codex 不会自动刷新' : undefined}>
          <CheckCircle2 size={16} />切换账号
        </button>
        <button onClick={() => void switchSelected(true)} disabled={busy || !selectedAccount?.switchable} title={selectedAccount && !selectedAccount.switchable ? '该账号缺少完整 OAuth 凭据，也没有可用的 Team/K12 workspace ID' : selectedAccount && usesExternalAuth(selectedAccount) ? '外部 Team/K12 凭据会以当前 Codex 支持的临时认证模式启动' : undefined}>
          <RotateCcw size={16} />切换并重启
        </button>
        <button onClick={() => void run(async () => {
          const result = await window.codexSwitcher.restoreLatest(false)
          if (!result.ok) throw new Error(result.message)
        }, '已恢复上一个配置')} disabled={busy}>
          <RotateCcw size={16} />恢复上一个
        </button>
        <button onClick={() => void run(async () => {
          const result = await window.codexSwitcher.restoreApiMode(false)
          if (!result.ok) throw new Error(result.message)
        }, '已恢复原 API/代理模式')} disabled={busy}>
          <RotateCcw size={16} />恢复备份 API
        </button>
        <button onClick={() => setSettingsOpen(true)} disabled={busy}>
          <KeyRound size={16} />自定义 API
        </button>
        <span className="toolbar-divider" />
        <button onClick={() => void openSessionRepair()} disabled={busy}>
          <Wrench size={16} />修复历史会话
        </button>
      </div>

      {snapshot.testing.active && (
        <div className="task-progress">
          <div style={{ width: `${snapshot.testing.total ? (snapshot.testing.done / snapshot.testing.total) * 100 : 0}%` }} />
          <span>{snapshot.testing.done} / {snapshot.testing.total}</span>
        </div>
      )}
      <div className="filter-row">
        <label className="search-field">
          <Search size={16} />
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索邮箱、文件或错误" />
        </label>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as DisplayAccountStatus | '')}>
          <option value="">全部状态</option>
          {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <span className="selection-count">已选 {selected.size}</span>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="select-column"><input type="checkbox" aria-label="选择全部" checked={accounts.length > 0 && accounts.every((item) => selected.has(item.id))} onChange={(event) => setSelected(event.target.checked ? new Set(accounts.map((item) => item.id)) : new Set())} /></th>
              <th>账号</th><th>状态</th><th>计划</th><th>用量与重置</th><th>凭据时间</th><th>来源</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => {
              const running = snapshot.testing.runningIds.includes(account.id)
              return (
              <tr
                key={account.id}
                className={`account-row status-row-${displayStatus(account.status)}${account.active ? ' active-row' : ''}${running ? ' testing-row' : ''}${selected.has(account.id) ? ' selected-row' : ''}`}
                aria-busy={running}
                onContextMenu={(event) => openContextMenu(event, account)}
              >
                <td><input type="checkbox" aria-label={`选择 ${account.email ?? account.sourcePath}`} checked={selected.has(account.id)} onChange={() => toggle(account.id)} /></td>
                <td>
                  <div className="account-email">{account.email ?? '邮箱未知'} {account.active && <span className="active-badge">当前</span>}</div>
                  <div className="workspace-id">{account.workspaceId ?? 'workspace 未知'} · {switchCapability(account)}</div>
                </td>
                <td>
                  {running ? (
                    <><span className="status status-testing"><LoaderCircle className="spin" size={13} />检测中</span><div className="status-detail">正在验证账号并刷新额度</div></>
                  ) : (
                    <><span className={`status status-${displayStatus(account.status)}`}>{STATUS_LABELS[displayStatus(account.status)]}</span><div className="status-detail" title={account.detail}>{account.detail}</div></>
                  )}
                </td>
                <td>{account.planType ?? '-'}</td>
                <td><Quota account={account} running={running} /></td>
                <td><div>刷新 {dateTime(account.lastRefresh)}</div><div className="muted">到期 {dateTime(account.accessExpiresAt)}</div><div className="muted">检测 {dateTime(account.lastCheckedAt)}</div></td>
                <td><div className="source-path" title={account.sourcePath}>{account.sourcePath}</div><span className="format-label">{account.sourceDialect.toUpperCase()} · {account.sourceFormat.toUpperCase()}</span></td>
              </tr>
              )
            })}
            {accounts.length === 0 && <tr><td colSpan={7} className="empty-state">没有匹配的账号</td></tr>}
          </tbody>
        </table>
      </div>
      </div> : activeView === 'grok' ? (
        <GrokPage
          snapshot={snapshot}
          onSnapshot={(next) => { setSnapshot(next); setSettingsDraft(next.settings) }}
          notify={(kind, text) => setMessage({ kind, text })}
        />
      ) : (
        <main className="page-view automation-view">
          <section className="automation-status-band">
            <div><span>运行状态</span><strong className={snapshot.autoSwitch.enabled ? 'text-ok' : ''}>{snapshot.autoSwitch.running ? '正在检查' : snapshot.autoSwitch.enabled ? '已启用' : '未启用'}</strong></div>
            <div><span>当前账号</span><strong>{snapshot.accounts.find((account) => account.active)?.email ?? '未匹配'}</strong></div>
            <div><span>上次检查</span><strong>{dateTime(snapshot.autoSwitch.lastCheckAt)}</strong></div>
            <div><span>下次检查</span><strong>{dateTime(snapshot.autoSwitch.nextCheckAt)}</strong></div>
            <div className="automation-message"><span>结果</span><strong>{snapshot.autoSwitch.lastMessage}</strong></div>
          </section>

          {snapshot.testing.active && snapshot.autoSwitch.running && (
            <div className="task-progress">
              <div style={{ width: `${snapshot.testing.total ? (snapshot.testing.done / snapshot.testing.total) * 100 : 0}%` }} />
              <span>{snapshot.testing.done} / {snapshot.testing.total}</span>
            </div>
          )}

          <section className="automation-controls" aria-label="自动切换设置">
            <label className="automation-toggle">
              <span>定时自动切换</span>
              <span className="switch-control">
                <input aria-label="启用定时自动切换" type="checkbox" checked={settingsDraft.autoSwitchEnabled} onChange={(event) => setSettingsDraft({ ...settingsDraft, autoSwitchEnabled: event.target.checked })} />
                <span />
              </span>
            </label>
            <label>检查间隔（秒）<input aria-label="自动切换检查间隔" type="number" min={5} max={86400} value={settingsDraft.autoSwitchIntervalSeconds} onChange={(event) => setSettingsDraft({ ...settingsDraft, autoSwitchIntervalSeconds: Number(event.target.value) })} /></label>
            <label className="check-option"><input type="checkbox" checked={settingsDraft.autoSwitchRestartCodex} onChange={(event) => setSettingsDraft({ ...settingsDraft, autoSwitchRestartCodex: event.target.checked })} />切换成功后重启 Codex</label>
            <span className="automation-spacer" />
            <button onClick={() => void saveAutomation()} disabled={busy}>保存设置</button>
            <button className="primary-button" onClick={() => void saveAndRunAutomation()} disabled={busy || snapshot.autoSwitch.running || settingsDraft.autoSwitchAccountIds.length === 0}>
              {snapshot.autoSwitch.running ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}立即检查
            </button>
          </section>

          <div className="automation-filter-row">
            <label className="search-field"><Search size={16} /><input value={automationKeyword} onChange={(event) => setAutomationKeyword(event.target.value)} placeholder="搜索候选账号" /></label>
            <span>候选 {settingsDraft.autoSwitchAccountIds.length} / {snapshot.accounts.filter((account) => account.switchable).length}</span>
            <button onClick={() => setSettingsDraft({ ...settingsDraft, autoSwitchAccountIds: snapshot.accounts.filter((account) => account.switchable).map((account) => account.id) })}>全选可切换</button>
            <button onClick={() => setSettingsDraft({ ...settingsDraft, autoSwitchAccountIds: [] })}>清空</button>
          </div>

          <div className="table-wrap automation-table-wrap">
            <table className="automation-table">
              <thead><tr><th className="select-column">候选</th><th>账号</th><th>状态</th><th>等级</th><th>当前额度</th><th>最后检测</th></tr></thead>
              <tbody>
                {automationAccounts.map((account) => {
                  const checked = settingsDraft.autoSwitchAccountIds.includes(account.id)
                  const running = snapshot.testing.runningIds.includes(account.id)
                  return (
                    <tr key={account.id} className={`status-row-${displayStatus(account.status)}${account.active ? ' active-row' : ''}${running ? ' testing-row' : ''}`}>
                      <td><input type="checkbox" aria-label={`自动切换候选 ${account.email ?? account.id}`} disabled={!account.switchable} checked={checked} onChange={(event) => setSettingsDraft({ ...settingsDraft, autoSwitchAccountIds: event.target.checked ? [...settingsDraft.autoSwitchAccountIds, account.id] : settingsDraft.autoSwitchAccountIds.filter((id) => id !== account.id) })} /></td>
                      <td><div className="account-email">{account.email ?? '邮箱未知'} {account.active && <span className="active-badge">当前</span>}</div><div className="workspace-id">{switchCapability(account)}</div></td>
                      <td>{running ? <span className="status status-testing"><LoaderCircle className="spin" size={13} />检测中</span> : <><span className={`status status-${displayStatus(account.status)}`}>{STATUS_LABELS[displayStatus(account.status)]}</span><div className="status-detail">{account.detail}</div></>}</td>
                      <td>{account.planType ?? '未知'}</td>
                      <td><Quota account={account} running={running} /></td>
                      <td>{dateTime(account.lastCheckedAt)}</td>
                    </tr>
                  )
                })}
                {automationAccounts.length === 0 && <tr><td colSpan={6} className="empty-state">没有匹配的账号</td></tr>}
              </tbody>
            </table>
          </div>
        </main>
      )}

      {pasteOpen && (
        <div className="repair-backdrop" role="presentation">
          <section className="compact-dialog" role="dialog" aria-modal="true" aria-label="粘贴导入账号">
            <div className="panel-header">
              <h2>粘贴导入</h2>
              <button className="icon-button" title="关闭" aria-label="关闭粘贴导入" onClick={() => setPasteOpen(false)} disabled={busy}>
                <X size={18} />
              </button>
            </div>
            <label className="paste-field">
              凭据文本
              <textarea
                aria-label="凭据文本"
                value={pasteText}
                onChange={(event) => setPasteText(event.target.value)}
                placeholder="粘贴 JSON、JSONL、键值文本或静态 JS"
              />
            </label>
            <div className="dialog-note">内容会在主进程清洗解析，完整 token 不会进入界面状态或日志。</div>
            <div className="panel-actions">
              <button onClick={() => setPasteOpen(false)} disabled={busy}>取消</button>
              <button className="primary-button" onClick={() => void submitPaste()} disabled={busy || !pasteText.trim()}>
                {busy ? <LoaderCircle className="spin" size={16} /> : <ClipboardPaste size={16} />}
                清洗并导入
              </button>
            </div>
          </section>
        </div>
      )}

      {exportDialog && (
        <div className="repair-backdrop" role="presentation">
          <section className="compact-dialog" role="dialog" aria-modal="true" aria-label="导出账号">
            <div className="panel-header">
              <h2>导出 {exportDialog.accountIds.length} 个账号</h2>
              <button className="icon-button" title="关闭" aria-label="关闭账号导出" onClick={() => setExportDialog(null)} disabled={busy}>
                <X size={18} />
              </button>
            </div>
            <div className="option-group">
              <span>目标格式</span>
              <div className="segmented-control">
                <button className={exportDialog.format === 'cpa' ? 'selected' : ''} onClick={() => setExportDialog({ ...exportDialog, format: 'cpa' })}>CPA</button>
                <button className={exportDialog.format === 'sub2api' ? 'selected' : ''} onClick={() => setExportDialog({ ...exportDialog, format: 'sub2api' })}>SubAPI</button>
              </div>
            </div>
            <div className="option-group">
              <span>文件布局</span>
              <div className="segmented-control">
                <button className={exportDialog.layout === 'separate' ? 'selected' : ''} onClick={() => setExportDialog({ ...exportDialog, layout: 'separate' })}>每账号一文件</button>
                <button className={exportDialog.layout === 'bundle' ? 'selected' : ''} onClick={() => setExportDialog({ ...exportDialog, layout: 'bundle' })}>合并单文件</button>
              </div>
            </div>
            <div className="export-warning">
              <CircleAlert size={17} />
              <span>导出文件包含可直接使用的明文凭据。CPA 合并模式输出 ZIP；SubAPI 合并模式输出原生 accounts[] JSON。</span>
            </div>
            <div className="panel-actions">
              <button onClick={() => setExportDialog(null)} disabled={busy}>取消</button>
              <button className="primary-button" onClick={() => void submitExport()} disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={16} />}
                选择目录并导出
              </button>
            </div>
          </section>
        </div>
      )}

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="account-context-menu"
          role="menu"
          aria-label="账号管理"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="context-account" title={contextMenu.account.email ?? contextMenu.account.sourcePath}>
            {contextMenu.account.email ?? '邮箱未知'}
          </div>
          <button role="menuitem" onClick={() => contextAction(() => run(() => window.codexSwitcher.testAccounts([contextMenu.account.id]), '账号检测完成'))}>
            <TestTube2 size={15} />检测此账号
          </button>
          <button role="menuitem" disabled={busy || snapshot.testing.active || !contextMenu.account.switchable} title={!contextMenu.account.switchable ? '缺少完整 OAuth 凭据或 Team/K12 workspace ID' : snapshot.testing.active ? '账号检测进行中' : usesExternalAuth(contextMenu.account) ? '外部凭据切换后需重启 Codex' : undefined} onClick={() => contextAction(() => switchAccount(contextMenu.account.id, false))}>
            <CheckCircle2 size={15} />切换到此账号
          </button>
          <button role="menuitem" disabled={busy || snapshot.testing.active || !contextMenu.account.switchable} title={!contextMenu.account.switchable ? '缺少完整 OAuth 凭据或 Team/K12 workspace ID' : snapshot.testing.active ? '账号检测进行中' : usesExternalAuth(contextMenu.account) ? '使用当前 Codex 的外部凭据模式启动' : undefined} onClick={() => contextAction(() => switchAccount(contextMenu.account.id, true))}>
            <RotateCcw size={15} />切换并重启
          </button>
          <button role="menuitem" onClick={() => contextAction(() => openExport([contextMenu.account.id]))}>
            <Download size={15} />导出此账号
          </button>
          <button role="menuitem" onClick={() => contextAction(async () => {
            const result = await window.codexSwitcher.revealSource(contextMenu.account.id)
            if (!result.ok) setMessage({ kind: 'error', text: result.message })
          })}>
            <FolderOpen size={15} />打开源文件位置
          </button>
          <button role="menuitem" disabled={!contextMenu.account.email} onClick={() => contextAction(async () => {
            if (!contextMenu.account.email) return
            await navigator.clipboard.writeText(contextMenu.account.email)
            setMessage({ kind: 'ok', text: '邮箱已复制' })
          })}>
            <Copy size={15} />复制邮箱
          </button>
          <button className="context-danger" role="menuitem" disabled={busy || snapshot.testing.active} onClick={() => contextAction(() => deleteAccounts([contextMenu.account.id]))}>
            <Trash2 size={15} />删除此账号
          </button>
        </div>
      )}

      {repairPreview && (
        <div className="repair-backdrop" role="presentation">
          <section
            className="repair-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="repair-title"
          >
            <div className="panel-header">
              <h2 id="repair-title">修复历史会话</h2>
              <button
                className="icon-button"
                title="关闭"
                aria-label="关闭会话修复"
                onClick={() => setRepairPreview(null)}
                disabled={busy}
              >
                <X size={18} />
              </button>
            </div>
            <label className="repair-provider">
              目标供应商
              <select
                aria-label="目标供应商"
                value={repairPreview.targetProvider}
                disabled={busy}
                onChange={(event) => void openSessionRepair(event.target.value)}
              >
                {repairPreview.availableProviders.map((provider) => (
                  <option key={provider} value={provider}>
                    {provider}{provider === repairPreview.currentProvider ? '（当前）' : ''}
                  </option>
                ))}
              </select>
            </label>
            <div className="repair-metrics">
              <div><span>扫描会话</span><strong>{repairPreview.scannedSessionFiles}</strong></div>
              <div><span>待改文件</span><strong>{repairPreview.changedSessionFiles}</strong></div>
              <div><span>SQLite 供应商</span><strong>{repairPreview.sqliteProviderRows}</strong></div>
              <div><span>可见性</span><strong>{repairPreview.sqliteUserEventRows}</strong></div>
              <div><span>工作区路径</span><strong>{repairPreview.sqliteCwdRows}</strong></div>
              <div><span>全局状态</span><strong>{repairPreview.globalStateKeys}</strong></div>
            </div>
            {repairPreview.encryptedContentFiles > 0 && (
              <div className="repair-warning">
                <CircleAlert size={17} />
                <span>
                  {repairPreview.encryptedContentFiles} 个会话包含来自{' '}
                  {repairPreview.encryptedContentProviders.join('、') || '其他供应商'} 的加密内容，
                  跨供应商继续或压缩时可能需要切回原供应商。
                </span>
              </div>
            )}
            {repairPreview.skippedLockedFiles.length > 0 && (
              <div className="repair-warning">
                <CircleAlert size={17} />
                <span>{repairPreview.skippedLockedFiles.length} 个锁定文件将被跳过。</span>
              </div>
            )}
            <div className="repair-note">
              写入前会校验快照并创建备份，写入后会再次扫描确认结果。Codex 运行时也可修复；被占用的文件会跳过并明确提示。
            </div>
            <div className="panel-actions">
              <button onClick={() => setRepairPreview(null)} disabled={busy}>取消</button>
              <button
                className="primary-button"
                onClick={() => void applySessionRepair()}
                disabled={busy}
              >
                {busy ? <LoaderCircle className="spin" size={16} /> : <Wrench size={16} />}
                确认修复
              </button>
            </div>
          </section>
        </div>
      )}

      {settingsOpen && (
        <div className="modal-backdrop" role="presentation">
          <section className="settings-panel" role="dialog" aria-modal="true" aria-label="设置">
            <div className="panel-header"><h2>设置</h2><button className="icon-button" title="关闭" onClick={() => setSettingsOpen(false)}><X size={18} /></button></div>
            <label>aa 托管凭证库<input aria-label="应用凭证库" value={snapshot.importDirectory} readOnly /></label>
            <label>导入文件默认目录<div className="path-input"><input value={settingsDraft.accountDirectory} onChange={(event) => setSettingsDraft({ ...settingsDraft, accountDirectory: event.target.value })} /><button title="选择目录" onClick={async () => { const path = await window.codexSwitcher.chooseAccountDirectory(); if (path) setSettingsDraft({ ...settingsDraft, accountDirectory: path }) }}><FolderOpen size={17} /></button></div></label>
            <label>Grok 账号目录<div className="path-input"><input value={settingsDraft.grokDirectory} onChange={(event) => setSettingsDraft({ ...settingsDraft, grokDirectory: event.target.value })} /><button title="选择 Grok 目录" onClick={async () => { const path = await window.codexSwitcher.chooseGrokDirectory(); if (path) setSettingsDraft({ ...settingsDraft, grokDirectory: path }) }}><FolderOpen size={17} /></button></div></label>
            <label>auth.json 路径<input value={settingsDraft.authPath} onChange={(event) => setSettingsDraft({ ...settingsDraft, authPath: event.target.value })} /></label>
            <label>config.toml 路径<input value={settingsDraft.configPath} onChange={(event) => setSettingsDraft({ ...settingsDraft, configPath: event.target.value })} /></label>
            <div className="settings-grid">
              <label>并发数<input aria-label="并发数" type="number" min={1} max={12} value={settingsDraft.concurrency} onChange={(event) => setSettingsDraft({ ...settingsDraft, concurrency: Number(event.target.value) })} /></label>
              <label>超时（毫秒）<input type="number" min={1000} value={settingsDraft.timeoutMs} onChange={(event) => setSettingsDraft({ ...settingsDraft, timeoutMs: Number(event.target.value) })} /></label>
              <label>备份保留数<input type="number" min={1} value={settingsDraft.backupRetention} onChange={(event) => setSettingsDraft({ ...settingsDraft, backupRetention: Number(event.target.value) })} /></label>
              <label>深度检测模型<input value={settingsDraft.deepTestModel} onChange={(event) => setSettingsDraft({ ...settingsDraft, deepTestModel: event.target.value })} /></label>
            </div>
            <section className="custom-api-panel" aria-label="自定义 API">
              <div className="section-heading">
                <div><strong>自定义 API</strong><span>地址和模型会记忆，Key 使用 Windows DPAPI 加密且不会回显</span></div>
                <span className={`saved-secret ${snapshot.customApi.hasApiKey ? 'ready' : ''}`}>{snapshot.customApi.hasApiKey ? 'Key 已保存' : '未保存 Key'}</span>
              </div>
              <label>API 地址<input value={settingsDraft.customApiBaseUrl} onChange={(event) => setSettingsDraft({ ...settingsDraft, customApiBaseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
              <div className="settings-grid">
                <label>模型<input value={settingsDraft.customApiModel} onChange={(event) => setSettingsDraft({ ...settingsDraft, customApiModel: event.target.value })} /></label>
                <label>API Key<input type="password" value={customApiKey} onChange={(event) => setCustomApiKey(event.target.value)} placeholder={snapshot.customApi.hasApiKey ? '留空继续使用已保存 Key' : '输入 API Key'} autoComplete="new-password" /></label>
              </div>
              <button className="primary-button" onClick={() => void run(async () => {
                const result = await window.codexSwitcher.switchToCustomApi({
                  baseUrl: settingsDraft.customApiBaseUrl,
                  model: settingsDraft.customApiModel,
                  ...(customApiKey.trim() ? { apiKey: customApiKey } : {})
                }, false)
                if (!result.ok) throw new Error(result.message)
                setCustomApiKey('')
                await reload()
              }, '已切换到自定义 API 模式')} disabled={busy || (!snapshot.customApi.hasApiKey && !customApiKey.trim())}>
                <KeyRound size={16} />保存并切换
              </button>
            </section>
            <section className="update-panel" aria-label="应用更新">
              <div>
                <strong>应用更新</strong>
                <span>{updateState?.message ?? '正在读取版本信息'}</span>
              </div>
              {updateState?.status === 'available' && (
                <button onClick={() => void downloadUpdate()} disabled={busy}>
                  <Download size={16} />下载 {updateState.availableVersion}
                </button>
              )}
              {updateState?.status === 'downloading' && (
                <button disabled><LoaderCircle className="spin" size={16} />{Math.round(updateState.percent ?? 0)}%</button>
              )}
              {updateState?.status === 'downloaded' && (
                <button className="primary-button" onClick={() => void installUpdate()}>
                  <PackageOpen size={16} />安装并重启
                </button>
              )}
              {!['available', 'downloading', 'downloaded'].includes(updateState?.status ?? '') && (
                <button onClick={() => void checkForUpdates()} disabled={updateState?.status === 'checking'}>
                  {updateState?.status === 'checking' ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
                  检查更新
                </button>
              )}
            </section>
            <div className="panel-actions"><button onClick={() => setSettingsOpen(false)} disabled={busy}>取消</button><button className="primary-button" disabled={busy} onClick={() => void run(async () => { if (settingsDraft.autoSwitchEnabled && settingsDraft.autoSwitchAccountIds.length === 0) throw new Error('启用自动切换前至少选择一个候选账号'); await window.codexSwitcher.updateSettings(settingsDraft); setSettingsOpen(false) }, '设置已保存')}>保存设置</button></div>
          </section>
        </div>
      )}
    </div>
  )
}
