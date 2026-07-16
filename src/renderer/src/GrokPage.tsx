import {
  CheckCircle2,
  Code2,
  Copy,
  Download,
  FileArchive,
  LoaderCircle,
  Play,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Square,
  TestTube2,
  Trash2,
  Zap
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AppSnapshot } from '../../shared/ipc'
import type {
  AccountStatus,
  CpaCodexAccountSummary,
  DisplayAccountStatus,
  GrokAccountSummary,
  UsageSummary,
  UsageWindow
} from '../../shared/types'
import { ACCOUNT_SORT_OPTIONS, compareAccounts, type AccountSortMode } from './account-sort'

const LABELS: Record<DisplayAccountStatus, string> = {
  untested: '未测试',
  valid: '有效',
  invalid: '已失效',
  quota_exhausted_weekly: '周额度耗尽',
  quota_exhausted_5h: '5 小时额度耗尽',
  unknown_error: '未知错误'
}

function displayStatus(status: AccountStatus): DisplayAccountStatus {
  if (status === 'untested' || status === 'valid' || status === 'quota_exhausted_5h' || status === 'quota_exhausted_weekly') return status
  if (status === 'quota_exhausted') return 'quota_exhausted_5h'
  if (['invalid', 'no_permission', 'workspace_deactivated', 'non_refreshable'].includes(status)) return 'invalid'
  return 'unknown_error'
}

function time(value: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function sourceFileName(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
}

function secondsUntilReset(window: UsageWindow, checkedAt: string, now: number): number | null {
  const referenceNow = Math.max(now, Date.now())
  if (window.resetAt) {
    const timestamp = Date.parse(window.resetAt)
    return Number.isFinite(timestamp) ? Math.max(0, Math.ceil((timestamp - referenceNow) / 1_000)) : null
  }
  if (window.resetInSeconds === null) return null
  const checkedTimestamp = Date.parse(checkedAt)
  const elapsed = Number.isFinite(checkedTimestamp) ? Math.max(0, Math.floor((referenceNow - checkedTimestamp) / 1_000)) : 0
  return Math.max(0, window.resetInSeconds - elapsed)
}

function resetCountdown(window: UsageWindow, checkedAt: string, now: number): string | null {
  const seconds = secondsUntilReset(window, checkedAt, now)
  if (seconds === null) return null
  if (seconds === 0) return '即将恢复'
  const weekly = window.windowSeconds === 604_800 || /周|week/i.test(window.label)
  const fiveHour = window.windowSeconds === 18_000 || /5\s*(?:小时|h(?:our)?s?)/i.test(window.label)
  if (weekly) return `剩余 ${Math.ceil(seconds / 3_600)} 小时`
  if (fiveHour) return `剩余 ${Math.ceil(seconds / 60)} 分钟`
  return seconds >= 21_600 ? `剩余 ${Math.ceil(seconds / 3_600)} 小时` : `剩余 ${Math.ceil(seconds / 60)} 分钟`
}

function Quota({ usage, running, now }: { usage: UsageSummary | null; running: boolean; now: number }): React.JSX.Element {
  if (running) return <span className="testing-inline"><LoaderCircle className="spin" size={14} />正在读取额度</span>
  if (!usage?.windows.length) return <span className="muted">-</span>
  return <div className="quota-list">
    {usage.windows.slice(0, 3).map((window) => {
      const remaining = window.remainingPercent
      const countdown = resetCountdown(window, usage.checkedAt, now)
      return <div className="quota-item" key={window.id}>
        <div className="quota-label"><span>{window.label}</span><span className="quota-values"><strong>{remaining === null ? '-' : `${Math.round(remaining)}%`}</strong>{countdown && <em>{countdown}</em>}</span></div>
        <div className="quota-track"><div className={`quota-fill ${remaining !== null && remaining <= 10 ? 'danger' : remaining !== null && remaining <= 30 ? 'warn' : ''}`} style={{ width: `${remaining ?? 0}%` }} /></div>
        <span className="quota-reset">重置 {window.resetAt ? time(window.resetAt) : '-'}</span>
      </div>
    })}
  </div>
}

interface Props {
  snapshot: AppSnapshot
  onSnapshot: (snapshot: AppSnapshot) => void
  notify: (kind: 'ok' | 'warn' | 'error', text: string) => void
  now?: number
}

function selectionToggle(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string): void {
  setter((current) => {
    const next = new Set(current)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })
}

function StatusFilters({
  value,
  counts,
  total,
  onChange
}: {
  value: DisplayAccountStatus | ''
  counts: (status: DisplayAccountStatus) => number
  total: number
  onChange: (status: DisplayAccountStatus | '') => void
}): React.JSX.Element {
  return <div className="status-filter-strip" aria-label="账号状态筛选">
    <button className={value === '' ? 'active' : ''} onClick={() => onChange('')}><span>全部</span><strong>{total}</strong></button>
    {Object.entries(LABELS).map(([status, label]) => <button
      key={status}
      className={`${value === status ? 'active ' : ''}filter-${status}`}
      onClick={() => onChange(status as DisplayAccountStatus)}
    ><span>{label}</span><strong>{counts(status as DisplayAccountStatus)}</strong></button>)}
  </div>
}

function CpaCodexPanel({ snapshot, onSnapshot, notify, now = Date.now() }: Props): React.JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState<DisplayAccountStatus | ''>('')
  const [sort, setSort] = useState<AccountSortMode>('availability_reset')
  const [busy, setBusy] = useState(false)
  const accounts = useMemo(() => snapshot.cpaCodexAccounts.filter((account) => {
    if (status && displayStatus(account.status) !== status) return false
    const query = keyword.trim().toLowerCase()
    return !query || `${account.email ?? ''} ${account.workspaceId ?? ''} ${account.planType ?? ''} ${account.detail}`.toLowerCase().includes(query)
  }).sort(compareAccounts(sort)), [keyword, snapshot.cpaCodexAccounts, sort, status])

  async function run<T>(operation: () => Promise<T>, success: string | ((result: T) => void), reload = true): Promise<void> {
    setBusy(true)
    try {
      const result = await operation()
      if (reload) onSnapshot(await window.codexSwitcher.getSnapshot())
      if (typeof success === 'string') notify('ok', success)
      else success(result)
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const ids = (): string[] => [...selected]
  const setEnabled = (enabled: boolean): void => {
    void run(() => window.codexSwitcher.setCpaCodexEnabled(ids(), enabled), (result) => {
      const selectedIds = new Set(ids())
      onSnapshot({ ...snapshot, cpaCodexAccounts: snapshot.cpaCodexAccounts.map((account) => selectedIds.has(account.id) ? { ...account, disabled: !enabled } : account) })
      notify(result.changed ? 'ok' : 'warn', result.message)
    }, false)
  }
  const remove = (): void => {
    if (!selected.size || !window.confirm(`确定删除 ${selected.size} 个 CPA Codex 托管文件吗？`)) return
    const removedIds = ids()
    void run(async () => {
      const result = await window.codexSwitcher.deleteCpaCodexAccounts(removedIds)
      if (!result.deleted) throw new Error(result.message)
      const removed = new Set(removedIds)
      onSnapshot({
        ...snapshot,
        cpaCodexAccounts: snapshot.cpaCodexAccounts.filter((account) => !removed.has(account.id)),
        cpaDirectoryStats: {
          ...snapshot.cpaDirectoryStats,
          credentialFiles: Math.max(0, snapshot.cpaDirectoryStats.credentialFiles - removedIds.length),
          codexFiles: Math.max(0, snapshot.cpaDirectoryStats.codexFiles - removedIds.length)
        }
      })
      setSelected(new Set())
    }, 'CPA Codex 账号已删除', false)
  }
  const count = (value: DisplayAccountStatus): number => snapshot.cpaCodexAccounts.filter((item) => displayStatus(item.status) === value).length

  return <div className="page-view accounts-view cpa-provider-view">
    <section className="library-overview">
      <div><span>Codex 唯一账号</span><strong>{snapshot.cpaCodexAccounts.length}</strong></div>
      <div><span>Codex 凭据文件</span><strong>{snapshot.cpaDirectoryStats.codexFiles}</strong></div>
      <div><span>已停用</span><strong>{snapshot.cpaCodexAccounts.filter((item) => item.disabled).length}</strong></div>
      <div className="library-path"><span>CPA 共享目录</span><strong title={snapshot.grokDirectory}>{snapshot.grokDirectory}</strong></div>
    </section>
    <StatusFilters value={status} counts={count} total={snapshot.cpaCodexAccounts.length} onChange={setStatus} />
    <div className="toolbar">
      <div className="toolbar-group"><button onClick={() => void run(() => window.codexSwitcher.scanCpaCodexDirectory(), 'CPA Codex 扫描完成')} disabled={busy}><RefreshCw size={16} />重新扫描</button></div>
      <div className="toolbar-group"><button onClick={() => void run(() => window.codexSwitcher.testCpaCodexAccounts(), 'CPA Codex 全部检测完成', false)} disabled={busy || snapshot.cpaCodexTesting.active}><TestTube2 size={16} />测试当前页面全部</button>{snapshot.cpaCodexTesting.active && <button className="danger-button" onClick={() => void window.codexSwitcher.cancelCpaCodexTests()}><Square size={15} />取消</button>}</div>
    </div>
    {selected.size > 0 && <div className="selection-toolbar" aria-label="CPA Codex 选中账号操作">
      <div className="selection-summary"><CheckCircle2 size={15} /><strong>已选择 {selected.size} 个账号</strong><span>批量管理 CPA 文件状态</span></div>
      <button onClick={() => void run(() => window.codexSwitcher.testCpaCodexAccounts(ids()), 'CPA Codex 选中检测完成', false)} disabled={busy || snapshot.cpaCodexTesting.active}><Play size={16} />测试选中</button>
      <button onClick={() => setEnabled(true)} disabled={busy || snapshot.cpaCodexTesting.active}><Power size={16} />启用 .json</button>
      <button onClick={() => setEnabled(false)} disabled={busy || snapshot.cpaCodexTesting.active}><PowerOff size={16} />停用 .json.0</button>
      <button className="danger-button" onClick={remove} disabled={busy || snapshot.cpaCodexTesting.active}><Trash2 size={16} />删除选中</button>
    </div>}
    {snapshot.cpaCodexTesting.active && <div className="task-progress"><div style={{ width: `${snapshot.cpaCodexTesting.total ? snapshot.cpaCodexTesting.done / snapshot.cpaCodexTesting.total * 100 : 0}%` }} /><span>{snapshot.cpaCodexTesting.done} / {snapshot.cpaCodexTesting.total}</span></div>}
    <div className="filter-row"><label className="search-field"><Search size={16} /><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索 CPA Codex 邮箱、等级或状态" /></label><select aria-label="CPA Codex 排序" value={sort} onChange={(event) => setSort(event.target.value as AccountSortMode)}>{ACCOUNT_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><span className="selection-count">显示 {accounts.length} / {snapshot.cpaCodexAccounts.length} · 已选 {selected.size}</span></div>
    <div className="table-wrap"><table><thead><tr><th className="select-column"><input type="checkbox" aria-label="选择全部 CPA Codex" checked={accounts.length > 0 && accounts.every((item) => selected.has(item.id))} onChange={(event) => setSelected(event.target.checked ? new Set(accounts.map((item) => item.id)) : new Set())} /></th><th>账号</th><th>状态</th><th>等级</th><th>额度与重置</th><th>文件状态</th><th>托管文件</th></tr></thead><tbody>{accounts.map((account) => <CpaCodexRow key={account.id} account={account} running={snapshot.cpaCodexTesting.runningIds.includes(account.id)} selected={selected.has(account.id)} toggle={() => selectionToggle(setSelected, account.id)} now={now} />)}{!accounts.length && <tr><td colSpan={7} className="empty-state">没有匹配的 CPA Codex 账号</td></tr>}</tbody></table></div>
  </div>
}

function CpaCodexRow({ account, running, selected, toggle, now }: { account: CpaCodexAccountSummary; running: boolean; selected: boolean; toggle: () => void; now: number }): React.JSX.Element {
  const status = displayStatus(account.status)
  return <tr className={`account-row status-row-${status}${running ? ' testing-row' : ''}${selected ? ' selected-row' : ''}${account.disabled ? ' disabled-file-row' : ''}`} tabIndex={0} onClick={toggle} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle() } }}>
    <td><input type="checkbox" aria-label={`选择 CPA Codex ${account.email ?? account.id}`} checked={selected} onClick={(event) => event.stopPropagation()} onChange={toggle} /></td>
    <td><div className="account-title-line"><div className="account-email">{account.email ?? '邮箱未知'}</div>{account.disabled && <span className="disabled-badge">CPA 已停用</span>}</div><div className="workspace-id">{account.workspaceId ?? 'workspace 未知'}</div></td>
    <td>{running ? <><span className="status status-testing"><LoaderCircle className="spin" size={13} />检测中</span><div className="status-detail">检测完成后自动调整后缀</div></> : <><span className={`status status-${status}`}>{LABELS[status]}</span><div className="status-detail" title={account.detail}>{account.detail}</div></>}</td>
    <td>{account.planType ?? '未知'}</td><td><Quota usage={account.usage} running={running} now={now} /></td>
    <td><strong className={account.disabled ? 'text-warn' : 'text-ok'}>{account.disabled ? '.json.0 停用' : '.json 启用'}</strong><div className="muted">检测 {time(account.lastCheckedAt)}</div></td>
    <td><div className="source-path" title={account.sourcePath}>{sourceFileName(account.sourcePath)}</div><div className="source-tags"><span className="provider-label codex"><Code2 size={11} />CODEX</span><span className="format-label">CPA</span></div></td>
  </tr>
}

function GrokPanel({ snapshot, onSnapshot, notify, now = Date.now() }: Props): React.JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState<DisplayAccountStatus | ''>('')
  const [sort, setSort] = useState<AccountSortMode>('availability_reset')
  const [busy, setBusy] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ account: GrokAccountSummary; x: number; y: number } | null>(null)
  const accounts = useMemo(() => snapshot.grokAccounts.filter((account) => {
    if (status && account.status !== status) return false
    const query = keyword.trim().toLowerCase()
    return !query || `${account.email ?? ''} ${account.subject ?? ''} ${account.teamId ?? ''} ${account.planType ?? ''} ${account.detail}`.toLowerCase().includes(query)
  }).sort(compareAccounts(sort)), [keyword, snapshot.grokAccounts, sort, status])
  async function run<T>(operation: () => Promise<T>, success: string | ((result: T) => void), reload = true): Promise<void> {
    setBusy(true)
    try {
      const result = await operation()
      if (reload) onSnapshot(await window.codexSwitcher.getSnapshot())
      if (typeof success === 'string') notify('ok', success)
      else success(result)
    }
    catch (error) { notify('error', error instanceof Error ? error.message : '操作失败') }
    finally { setBusy(false) }
  }
  const chosen = (): string[] => [...selected]
  const remove = async (ids = chosen()): Promise<void> => {
    if (!ids.length || !window.confirm(`确定删除选中的 ${ids.length} 个 Grok 账号吗？对应托管文件会同时删除。`)) return
    await run(async () => { const result = await window.codexSwitcher.deleteGrokAccounts(ids); if (!result.deleted) throw new Error('没有删除任何账号'); const removed = new Set(ids); onSnapshot({ ...snapshot, grokAccounts: snapshot.grokAccounts.filter((account) => !removed.has(account.id)), cpaDirectoryStats: { ...snapshot.cpaDirectoryStats, credentialFiles: Math.max(0, snapshot.cpaDirectoryStats.credentialFiles - ids.length), grokFiles: Math.max(0, snapshot.cpaDirectoryStats.grokFiles - ids.length) } }); setSelected(new Set()) }, 'Grok 账号已删除', false)
  }
  const setEnabled = (enabled: boolean, ids = chosen()): void => { void run(() => window.codexSwitcher.setGrokEnabled(ids, enabled), (result) => { const selectedIds = new Set(ids); onSnapshot({ ...snapshot, grokAccounts: snapshot.grokAccounts.map((account) => selectedIds.has(account.id) ? { ...account, disabled: !enabled } : account) }); notify(result.changed ? 'ok' : 'warn', result.message) }, false) }
  const exportAccounts = async (layout: 'separate' | 'bundle', ids = selected.size ? chosen() : accounts.map((item) => item.id)): Promise<void> => { if (ids.length) await run(async () => { const paths = await window.codexSwitcher.exportGrokAccounts(ids, layout); if (!paths) throw new Error('已取消导出') }, layout === 'bundle' ? 'Sub2API 合并文件已导出' : 'CPA 单账号文件已导出', false) }
  const count = (value: DisplayAccountStatus): number => snapshot.grokAccounts.filter((item) => item.status === value).length
  return <div className="page-view accounts-view grok-view cpa-provider-view">
    <section className="library-overview"><div><span>Grok 唯一账号</span><strong>{snapshot.grokAccounts.length}</strong></div><div><span>Grok 凭据文件</span><strong>{snapshot.cpaDirectoryStats.grokFiles}</strong></div><div><span>已停用</span><strong>{snapshot.grokAccounts.filter((item) => item.disabled).length}</strong></div><div className="library-path"><span>CPA 共享目录</span><strong title={snapshot.grokDirectory}>{snapshot.grokDirectory}</strong></div></section>
    <StatusFilters value={status} counts={count} total={snapshot.grokAccounts.length} onChange={setStatus} />
    <div className="toolbar">
      <div className="toolbar-group"><button onClick={() => void run(() => window.codexSwitcher.scanGrokDirectory(), 'Grok 扫描完成')} disabled={busy || snapshot.grokTesting.active}><RefreshCw size={16} />重新扫描</button></div>
      <div className="toolbar-group"><button onClick={() => void run(() => window.codexSwitcher.testGrokAccounts(), 'Grok 全部检测完成', false)} disabled={busy || snapshot.grokTesting.active}><TestTube2 size={16} />测试当前页面全部</button>{snapshot.grokTesting.active && <button className="danger-button" onClick={() => void window.codexSwitcher.cancelGrokTests()}><Square size={15} />取消</button>}</div>
    </div>
    {selected.size > 0 && <div className="selection-toolbar" aria-label="Grok 选中账号操作">
      <div className="selection-summary"><CheckCircle2 size={15} /><strong>已选择 {selected.size} 个账号</strong><span>批量测试、导出或调整文件状态</span></div>
      <button onClick={() => void run(() => window.codexSwitcher.testGrokAccounts(chosen()), 'Grok 选中检测完成', false)} disabled={busy || snapshot.grokTesting.active}><Play size={16} />测试选中</button>
      <button onClick={() => setEnabled(true)} disabled={busy || snapshot.grokTesting.active}><Power size={16} />启用 .json</button>
      <button onClick={() => setEnabled(false)} disabled={busy || snapshot.grokTesting.active}><PowerOff size={16} />停用 .json.0</button>
      <button onClick={() => void exportAccounts('separate')} disabled={busy || snapshot.grokTesting.active}><Download size={16} />逐号导出</button>
      <button onClick={() => void exportAccounts('bundle')} disabled={busy || snapshot.grokTesting.active}><FileArchive size={16} />合并导出</button>
      <button className="danger-button" onClick={() => void remove()} disabled={busy || snapshot.grokTesting.active}><Trash2 size={16} />删除选中</button>
    </div>}
    {snapshot.grokTesting.active && <div className="task-progress"><div style={{ width: `${snapshot.grokTesting.total ? snapshot.grokTesting.done / snapshot.grokTesting.total * 100 : 0}%` }} /><span>{snapshot.grokTesting.done} / {snapshot.grokTesting.total}</span></div>}
    <div className="filter-row"><label className="search-field"><Search size={16} /><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索 Grok 邮箱、团队或等级" /></label><select aria-label="Grok 账号排序" value={sort} onChange={(event) => setSort(event.target.value as AccountSortMode)}>{ACCOUNT_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><span className="selection-count">显示 {accounts.length} / {snapshot.grokAccounts.length} · 已选 {selected.size}</span></div>
    <div className="table-wrap"><table><thead><tr><th className="select-column"><input type="checkbox" aria-label="选择全部 Grok 账号" checked={accounts.length > 0 && accounts.every((item) => selected.has(item.id))} onChange={(event) => setSelected(event.target.checked ? new Set(accounts.map((item) => item.id)) : new Set())} /></th><th>账号</th><th>状态</th><th>等级</th><th>额度与重置</th><th>文件状态</th><th>托管文件</th></tr></thead><tbody>{accounts.map((account) => { const running = snapshot.grokTesting.runningIds.includes(account.id); const toggle = () => selectionToggle(setSelected, account.id); return <tr key={account.id} className={`account-row status-row-${account.status}${running ? ' testing-row' : ''}${selected.has(account.id) ? ' selected-row' : ''}${account.disabled ? ' disabled-file-row' : ''}`} tabIndex={0} onClick={toggle} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle() } }} onContextMenu={(event) => { event.preventDefault(); setSelected(new Set([account.id])); setContextMenu({ account, x: Math.min(event.clientX, window.innerWidth - 240), y: Math.min(event.clientY, window.innerHeight - 260) }) }}><td><input type="checkbox" aria-label={`选择 Grok ${account.email ?? account.id}`} checked={selected.has(account.id)} onClick={(event) => event.stopPropagation()} onChange={toggle} /></td><td><div className="account-title-line"><div className="account-email">{account.email ?? '邮箱未知'}</div>{account.disabled && <span className="disabled-badge">CPA 已停用</span>}</div><div className="workspace-id">{account.subject ?? 'subject 未知'}{account.teamId ? ` · team ${account.teamId}` : ''}</div></td><td>{running ? <><span className="status status-testing"><LoaderCircle className="spin" size={13} />检测中</span><div className="status-detail">检测完成后自动调整后缀</div></> : <><span className={`status status-${account.status}`}>{LABELS[account.status]}</span><div className="status-detail" title={account.detail}>{account.detail}</div></>}</td><td>{account.planType ?? '未知'}</td><td><Quota usage={account.usage} running={running} now={now} /></td><td><strong className={account.disabled ? 'text-warn' : 'text-ok'}>{account.disabled ? '.json.0 停用' : '.json 启用'}</strong><div className="muted">检测 {time(account.lastCheckedAt)}</div></td><td><div className="source-path" title={account.sourcePath}>{sourceFileName(account.sourcePath)}</div><div className="source-tags"><span className="provider-label grok"><Zap size={11} />GROK</span><span className="format-label">CPA</span></div></td></tr> })}{!accounts.length && <tr><td colSpan={7} className="empty-state">没有匹配的 Grok 账号</td></tr>}</tbody></table></div>
    {contextMenu && <div className="account-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseLeave={() => setContextMenu(null)}><div className="context-account">{contextMenu.account.email ?? contextMenu.account.subject ?? 'Grok 账号'}</div><button role="menuitem" onClick={() => { const id = contextMenu.account.id; setContextMenu(null); void run(() => window.codexSwitcher.testGrokAccounts([id]), 'Grok 账号检测完成') }}><TestTube2 size={15} />检测这个账号</button><button role="menuitem" onClick={() => { const account = contextMenu.account; setContextMenu(null); setEnabled(account.disabled, [account.id]) }}>{contextMenu.account.disabled ? <Power size={15} /> : <PowerOff size={15} />}{contextMenu.account.disabled ? '启用这个文件' : '停用这个文件'}</button><button role="menuitem" disabled={!contextMenu.account.email} onClick={() => { if (contextMenu.account.email) void navigator.clipboard.writeText(contextMenu.account.email); setContextMenu(null) }}><Copy size={15} />复制邮箱</button><button role="menuitem" onClick={() => { const id = contextMenu.account.id; setContextMenu(null); void exportAccounts('separate', [id]) }}><Download size={15} />导出这个账号</button><button className="context-danger" role="menuitem" onClick={() => { const id = contextMenu.account.id; setContextMenu(null); void remove([id]) }}><Trash2 size={15} />删除这个账号</button></div>}
  </div>
}

export function CpaPage(props: Props): React.JSX.Element {
  const [provider, setProvider] = useState<'codex' | 'grok'>('codex')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(interval)
  }, [])
  const timedProps = { ...props, now }
  return <div className="page-view cpa-view">
    <nav className="cpa-provider-tabs" aria-label="CPA 账号类型">
      <button className={provider === 'codex' ? 'active' : ''} onClick={() => setProvider('codex')}><Code2 size={16} />Codex <span>{props.snapshot.cpaCodexAccounts.length}</span></button>
      <button className={provider === 'grok' ? 'active' : ''} onClick={() => setProvider('grok')}><Zap size={16} />Grok <span>{props.snapshot.grokAccounts.length}</span></button>
      <div className="cpa-inventory"><strong>{props.snapshot.cpaDirectoryStats.credentialFiles}</strong> 个凭据文件 · <strong>{props.snapshot.cpaCodexAccounts.length + props.snapshot.grokAccounts.length}</strong> 个唯一账号 · <strong>{props.snapshot.cpaDirectoryStats.duplicateFiles}</strong> 个重复文件{props.snapshot.cpaDirectoryStats.unrecognizedFiles ? ` · ${props.snapshot.cpaDirectoryStats.unrecognizedFiles} 个其他凭据文件` : ''}</div>
    </nav>
    {provider === 'codex' ? <CpaCodexPanel {...timedProps} /> : <GrokPanel {...timedProps} />}
  </div>
}
