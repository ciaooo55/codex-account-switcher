import {
  CheckCircle2,
  CircleAlert,
  Copy,
  FolderOpen,
  Import,
  KeyRound,
  LoaderCircle,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Square,
  TestTube2,
  Wrench,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppSnapshot } from '../../shared/ipc'
import type {
  AccountStatus,
  AccountSummary,
  AppSettings,
  SessionRepairPreview,
  UsageWindow
} from '../../shared/types'

const STATUS_LABELS: Record<AccountStatus, string> = {
  untested: '未测试',
  valid: '有效',
  quota_exhausted: '额度耗尽',
  no_permission: '无权限',
  invalid: '已失效',
  needs_refresh: '需要刷新',
  non_refreshable: '不可刷新',
  model_unavailable: '模型不可用',
  network_error: '网络错误',
  file_error: '文件错误',
  endpoint_incompatible: '接口异常'
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

function Quota({ account }: { account: AccountSummary }): React.JSX.Element {
  if (!account.usage?.windows.length) return <span className="muted">-</span>
  return (
    <div className="quota-list">
      {account.usage.windows.slice(0, 3).map((window) => {
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
    </div>
  )
}

export function App(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [keyword, setKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState<AccountStatus | ''>('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [repairPreview, setRepairPreview] = useState<SessionRepairPreview | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    account: AccountSummary
    x: number
    y: number
  } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)

  const reload = async (): Promise<void> => {
    const next = await window.codexSwitcher.getSnapshot()
    setSnapshot(next)
    setSettingsDraft(next.settings)
  }

  useEffect(() => {
    void reload()
    return window.codexSwitcher.onTestProgress((testing) =>
      setSnapshot((current) => (current ? { ...current, testing } : current))
    )
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

  const accounts = useMemo(() => {
    if (!snapshot) return []
    const query = keyword.trim().toLowerCase()
    return snapshot.accounts.filter((account) => {
      if (statusFilter && account.status !== statusFilter) return false
      if (!query) return true
      return `${account.email ?? ''} ${account.sourcePath} ${account.detail}`.toLowerCase().includes(query)
    })
  }, [keyword, snapshot, statusFilter])

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
    await run(async () => {
      const result = await window.codexSwitcher.switchAccount(id, restart)
      if (!result.ok) throw new Error(result.message)
    }, restart ? '账号已切换，Codex 正在重启' : '账号已切换，请重启 Codex 使所有会话生效')
  }

  const switchSelected = async (restart: boolean): Promise<void> => {
    const id = [...selected][0]
    if (!id || selected.size !== 1) {
      setMessage({ kind: 'error', text: '请选择一个账号进行切换' })
      return
    }
    await switchAccount(id, restart)
  }

  const openContextMenu = (event: React.MouseEvent, account: AccountSummary): void => {
    event.preventDefault()
    setSelected(new Set([account.id]))
    setContextMenu({
      account,
      x: Math.min(event.clientX, Math.max(8, window.innerWidth - 238)),
      y: Math.min(event.clientY, Math.max(8, window.innerHeight - 230))
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
    result[status] = snapshot.accounts.filter((item) => item.status === status).length
    return result
  }, {})

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Codex Account Switcher</h1>
          <p>{snapshot.settings.accountDirectory}</p>
        </div>
        <button className="icon-button" title="设置" aria-label="设置" onClick={() => setSettingsOpen(true)}>
          <Settings size={19} />
        </button>
      </header>

      <section className="summary-band">
        <div><span>账号</span><strong>{snapshot.accounts.length}</strong></div>
        <div><span>有效</span><strong className="text-ok">{counts.valid ?? 0}</strong></div>
        <div><span>额度耗尽</span><strong className="text-warn">{counts.quota_exhausted ?? 0}</strong></div>
        <div><span>异常</span><strong className="text-error">{(counts.invalid ?? 0) + (counts.no_permission ?? 0) + (counts.network_error ?? 0)}</strong></div>
        <div><span>当前账号</span><strong>{snapshot.accounts.find((item) => item.active)?.email ?? '未知/API 模式'}</strong></div>
      </section>

      <div className="toolbar">
        <button onClick={() => void run(() => window.codexSwitcher.scanDirectory(), '目录扫描完成')} disabled={busy}>
          <RefreshCw size={16} />扫描目录
        </button>
        <button onClick={() => void run(() => window.codexSwitcher.importFiles(), '文件导入完成')} disabled={busy}>
          <Import size={16} />导入文件
        </button>
        <span className="toolbar-divider" />
        <button onClick={() => void run(() => window.codexSwitcher.testAccounts(), '全部账号检测完成')} disabled={busy || snapshot.testing.active}>
          <TestTube2 size={16} />测试全部
        </button>
        <button onClick={() => void run(() => window.codexSwitcher.testAccounts([...selected]), '选中账号检测完成')} disabled={busy || selected.size === 0 || snapshot.testing.active}>
          <Play size={16} />测试选中
        </button>
        {snapshot.testing.active && (
          <button className="danger-button" onClick={() => void window.codexSwitcher.cancelTests()}>
            <Square size={15} />取消
          </button>
        )}
        <span className="toolbar-divider" />
        <button className="primary-button" onClick={() => void switchSelected(false)} disabled={busy || selected.size !== 1}>
          <CheckCircle2 size={16} />切换账号
        </button>
        <button onClick={() => void switchSelected(true)} disabled={busy || selected.size !== 1}>
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
          <KeyRound size={16} />恢复 API 模式
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
      {message && (
        <div className={`message ${message.kind}`}>
          {message.kind === 'ok' ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
          {message.text}
        </div>
      )}

      <div className="filter-row">
        <label className="search-field">
          <Search size={16} />
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索邮箱、文件或错误" />
        </label>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as AccountStatus | '')}>
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
            {accounts.map((account) => (
              <tr key={account.id} className={account.active ? 'active-row' : ''} onContextMenu={(event) => openContextMenu(event, account)}>
                <td><input type="checkbox" aria-label={`选择 ${account.email ?? account.sourcePath}`} checked={selected.has(account.id)} onChange={() => toggle(account.id)} /></td>
                <td>
                  <div className="account-email">{account.email ?? '邮箱未知'} {account.active && <span className="active-badge">当前</span>}</div>
                  <div className="workspace-id">{account.workspaceId ?? 'workspace 未知'} · {account.canRefresh ? '可刷新' : '仅 access token'}</div>
                </td>
                <td><span className={`status status-${account.status}`}>{STATUS_LABELS[account.status]}</span><div className="status-detail" title={account.detail}>{account.detail}</div></td>
                <td>{account.planType ?? '-'}</td>
                <td><Quota account={account} /></td>
                <td><div>刷新 {dateTime(account.lastRefresh)}</div><div className="muted">到期 {dateTime(account.accessExpiresAt)}</div><div className="muted">检测 {dateTime(account.lastCheckedAt)}</div></td>
                <td><div className="source-path" title={account.sourcePath}>{account.sourcePath}</div><span className="format-label">{account.sourceFormat.toUpperCase()}</span></td>
              </tr>
            ))}
            {accounts.length === 0 && <tr><td colSpan={7} className="empty-state">没有匹配的账号</td></tr>}
          </tbody>
        </table>
      </div>

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
          <button role="menuitem" onClick={() => contextAction(() => switchAccount(contextMenu.account.id, false))}>
            <CheckCircle2 size={15} />切换到此账号
          </button>
          <button role="menuitem" onClick={() => contextAction(() => switchAccount(contextMenu.account.id, true))}>
            <RotateCcw size={15} />切换并重启
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
              写入前会再次校验快照并创建备份；Codex 仍在运行时不会修改任何文件。
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
            <label>账号目录<div className="path-input"><input value={settingsDraft.accountDirectory} onChange={(event) => setSettingsDraft({ ...settingsDraft, accountDirectory: event.target.value })} /><button title="选择目录" onClick={async () => { const path = await window.codexSwitcher.chooseAccountDirectory(); if (path) setSettingsDraft({ ...settingsDraft, accountDirectory: path }) }}><FolderOpen size={17} /></button></div></label>
            <label>auth.json 路径<input value={settingsDraft.authPath} onChange={(event) => setSettingsDraft({ ...settingsDraft, authPath: event.target.value })} /></label>
            <label>config.toml 路径<input value={settingsDraft.configPath} onChange={(event) => setSettingsDraft({ ...settingsDraft, configPath: event.target.value })} /></label>
            <div className="settings-grid">
              <label>并发数<input aria-label="并发数" type="number" min={1} max={12} value={settingsDraft.concurrency} onChange={(event) => setSettingsDraft({ ...settingsDraft, concurrency: Number(event.target.value) })} /></label>
              <label>超时（毫秒）<input type="number" min={1000} value={settingsDraft.timeoutMs} onChange={(event) => setSettingsDraft({ ...settingsDraft, timeoutMs: Number(event.target.value) })} /></label>
              <label>备份保留数<input type="number" min={1} value={settingsDraft.backupRetention} onChange={(event) => setSettingsDraft({ ...settingsDraft, backupRetention: Number(event.target.value) })} /></label>
              <label>深度检测模型<input value={settingsDraft.deepTestModel} onChange={(event) => setSettingsDraft({ ...settingsDraft, deepTestModel: event.target.value })} /></label>
            </div>
            <div className="panel-actions"><button onClick={() => setSettingsOpen(false)}>取消</button><button className="primary-button" onClick={() => void run(async () => { await window.codexSwitcher.updateSettings(settingsDraft); setSettingsOpen(false) }, '设置已保存')}>保存设置</button></div>
          </section>
        </div>
      )}
    </div>
  )
}
