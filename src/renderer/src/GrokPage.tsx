import {
  CheckCircle2,
  Code2,
  Copy,
  Download,
  FileArchive,
  FolderSync,
  FolderOpen,
  LoaderCircle,
  Play,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Square,
  Tags,
  TestTube2,
  Trash2,
  Zap
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppSnapshot, AppSnapshotPatch } from '../../shared/ipc'
import type {
  CpaCodexAccountSummary,
  CodexTestMode,
  DisplayAccountStatus,
  GrokAccountSummary,
  UsageSummary,
  UsageWindow
} from '../../shared/types'
import { ACCOUNT_SORT_OPTIONS, compareAccounts, type AccountSortMode } from './account-sort'
import {
  buildAccountFacets,
  EMPTY_ACCOUNT_FACET_FILTERS,
  hasFacetOption,
  matchesAccountFacets,
  type AccountFacetFilters as AccountFacetFilterValues
} from './account-filters'
import { displayStatus, STATUS_LABELS } from './account-status'
import { AccountFacetFilters } from './components/AccountFacetFilters'
import {
  CODEX_TEST_MODE_RUNNING,
  CODEX_TEST_MODE_SUCCESS,
  CodexTestModeControl
} from './components/CodexTestModeControl'
import { StatusFilterStrip } from './components/StatusFilterStrip'
import type { RequestConfirmation } from './hooks/useConfirmation'
import { toggleSelection, usePrunedSelection } from './hooks/usePrunedSelection'
import { useVirtualTableRows } from './hooks/useVirtualTableRows'

function time(value: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function sourceFileName(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
}

function cpaFileState(path: string): { label: string; className: 'text-ok' | 'text-warn' } {
  if (/\.json\.无权限$/i.test(path)) return { label: '.json.无权限', className: 'text-warn' }
  if (/\.json\.无用量$/i.test(path)) return { label: '.json.无用量', className: 'text-warn' }
  if (/\.json\.0$/i.test(path)) return { label: '.json.0 停用', className: 'text-warn' }
  return { label: '.json 启用', className: 'text-ok' }
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
  onSnapshot: (snapshot: AppSnapshotPatch) => void
  notify: (kind: 'ok' | 'warn' | 'error', text: string) => void
  requestConfirmation: RequestConfirmation
  onBusyChange?: (busy: boolean) => void
  onEditMetadata: (ids: string[]) => void
  now?: number
}

function MetadataChips({ account }: { account: { group?: string | null; tags?: string[] } }): React.JSX.Element | null {
  if (!account.group && !(account.tags?.length)) return null
  return <div className="account-metadata-chips">
    {account.group && <span className="account-group-chip">{account.group}</span>}
    {(account.tags ?? []).slice(0, 3).map((tag) => <span key={tag} className="account-tag-chip">{tag}</span>)}
    {(account.tags?.length ?? 0) > 3 && <span className="account-tag-more">+{account.tags!.length - 3}</span>}
  </div>
}

function CpaCodexPanel({ snapshot, onSnapshot, notify, requestConfirmation, onBusyChange, onEditMetadata, now = Date.now() }: Props): React.JSX.Element {
  const [selected, setSelected] = usePrunedSelection(snapshot.cpaCodexAccounts.map((account) => account.id))
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState<DisplayAccountStatus | ''>('')
  const [facetFilters, setFacetFilters] = useState<AccountFacetFilterValues>(EMPTY_ACCOUNT_FACET_FILTERS)
  const [sort, setSort] = useState<AccountSortMode>('availability_reset')
  const [testMode, setTestMode] = useState<CodexTestMode>('full')
  const [busy, setBusy] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ account: CpaCodexAccountSummary; x: number; y: number } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!contextMenu) return
    contextMenuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setContextMenu(null)
    }
    const closeOutside = (event: PointerEvent): void => {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    window.addEventListener('pointerdown', closeOutside)
    return () => {
      window.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('pointerdown', closeOutside)
    }
  }, [contextMenu])
  const facets = useMemo(() => buildAccountFacets(snapshot.cpaCodexAccounts), [snapshot.cpaCodexAccounts])
  const availableFacets = useMemo(() => {
    if (!status) return facets
    return buildAccountFacets(
      snapshot.cpaCodexAccounts.filter((account) => displayStatus(account.status) === status)
    )
  }, [facets, snapshot.cpaCodexAccounts, status])
  useEffect(() => {
    setFacetFilters((current) => {
      const next = {
        plan: hasFacetOption(availableFacets.plans, current.plan) ? current.plan : '',
        domain: hasFacetOption(availableFacets.domains, current.domain) ? current.domain : '',
        reason: hasFacetOption(availableFacets.reasons, current.reason) ? current.reason : '',
        group: hasFacetOption(availableFacets.groups, current.group) ? current.group : '',
        tag: hasFacetOption(availableFacets.tags, current.tag) ? current.tag : ''
      }
      return next.plan === current.plan && next.domain === current.domain && next.reason === current.reason && next.group === current.group && next.tag === current.tag ? current : next
    })
  }, [availableFacets])
  const accounts = useMemo(() => snapshot.cpaCodexAccounts.filter((account) => {
    if (status && displayStatus(account.status) !== status) return false
    if (!matchesAccountFacets(account, facetFilters)) return false
    const query = keyword.trim().toLowerCase()
    return !query || `${account.alias ?? ''} ${account.email ?? ''} ${account.workspaceId ?? ''} ${account.planType ?? ''} ${account.group ?? ''} ${(account.tags ?? []).join(' ')} ${account.note ?? ''} ${account.detail}`.toLowerCase().includes(query)
  }).sort(compareAccounts(sort)), [facetFilters, keyword, snapshot.cpaCodexAccounts, sort, status])
  const runningIds = useMemo(() => new Set(snapshot.cpaCodexTesting.runningIds), [snapshot.cpaCodexTesting.runningIds])
  const virtualAccounts = useVirtualTableRows(accounts, (account) => account.id)

  async function run<T>(operation: () => Promise<T>, success: string | ((result: T) => void), reload = true): Promise<void> {
    setBusy(true)
    onBusyChange?.(true)
    try {
      const result = await operation()
      if (reload) onSnapshot(await window.codexSwitcher.getPageSnapshot('cpa'))
      if (typeof success === 'string') notify('ok', success)
      else success(result)
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '操作失败')
    } finally {
      setBusy(false)
      onBusyChange?.(false)
    }
  }

  const ids = (): string[] => [...selected]
  const setEnabled = (enabled: boolean, selectedIds = ids()): void => {
    void run(
      () => window.codexSwitcher.setCpaCodexEnabled(selectedIds, enabled),
      (result) => notify(result.changed ? 'ok' : 'warn', result.message)
    )
  }
  const remove = async (removedIds = ids()): Promise<void> => {
    if (!removedIds.length || !await requestConfirmation({
      title: `删除 ${removedIds.length} 个 CPA Codex 账号`,
      message: '对应的 CPA 托管凭据文件会被删除。',
      detail: '本地 aa 账号库不会被连带删除；需要时仍可再次导出到 CPA。',
      confirmLabel: '确认删除',
      tone: 'danger'
    })) return
    await run(async () => {
      const result = await window.codexSwitcher.deleteCpaCodexAccounts(removedIds)
      if (!result.deleted) throw new Error(result.message)
      setSelected(new Set())
    }, 'CPA Codex 账号已删除')
  }
  const syncToLibrary = (selectedIds?: string[]): void => {
    void run(
      () => window.codexSwitcher.syncCpaCodexToLibrary(selectedIds),
      (result) => notify(
        result.errors.length ? 'warn' : 'ok',
        `已同步到 aa：新增 ${result.imported} 个，重复跳过 ${result.skipped} 个${result.errors.length ? `，${result.errors.length} 个文件读取失败` : ''}`
      )
    )
  }
  return <div className="page-view accounts-view cpa-provider-view">
    <section className="library-overview">
      <div><span>Codex 唯一账号</span><strong>{snapshot.cpaCodexAccounts.length}</strong></div>
      <div><span>Codex 凭据文件</span><strong>{snapshot.cpaDirectoryStats.codexFiles}</strong></div>
      <div><span>已停用</span><strong>{snapshot.cpaCodexAccounts.filter((item) => item.disabled).length}</strong></div>
      <div className="library-path"><span>CPA 共享目录</span><strong title={snapshot.grokDirectory}>{snapshot.grokDirectory}</strong></div>
    </section>
    <StatusFilterStrip value={status} counts={facets.statusCounts} total={snapshot.cpaCodexAccounts.length} onChange={setStatus} label="CPA Codex 账号状态" />
    <div className="toolbar">
      <div className="toolbar-group"><button onClick={() => void run(() => window.codexSwitcher.scanCpaCodexDirectory(), 'CPA Codex 扫描完成')} disabled={busy}><RefreshCw size={16} />重新扫描</button><button onClick={() => syncToLibrary()} disabled={busy || snapshot.cpaCodexTesting.active}><FolderSync size={16} />同步全部到 aa</button></div>
      <div className="toolbar-group"><CodexTestModeControl value={testMode} onChange={setTestMode} disabled={busy || snapshot.cpaCodexTesting.active} label="CPA Codex 检测模式" /><button onClick={() => void run(() => window.codexSwitcher.testCpaCodexAccounts(accounts.map((account) => account.id), testMode), `CPA Codex 当前筛选 ${accounts.length} 个账号${CODEX_TEST_MODE_SUCCESS[testMode]}`)} disabled={busy || snapshot.cpaCodexTesting.active || accounts.length === 0}><TestTube2 size={16} />测试当前页面全部</button>{snapshot.cpaCodexTesting.active && <button className="danger-button" onClick={() => void window.codexSwitcher.cancelCpaCodexTests()}><Square size={15} />取消</button>}</div>
    </div>
    {selected.size > 0 && <div className="selection-toolbar" aria-label="CPA Codex 选中账号操作">
      <div className="selection-summary"><CheckCircle2 size={15} /><strong>已选择 {selected.size} 个账号</strong><span>批量管理 CPA 文件状态</span></div>
      <button onClick={() => void run(() => window.codexSwitcher.testCpaCodexAccounts(ids(), testMode), `CPA Codex 选中账号${CODEX_TEST_MODE_SUCCESS[testMode]}`)} disabled={busy || snapshot.cpaCodexTesting.active}><Play size={16} />测试选中</button>
      <button onClick={() => setEnabled(true)} disabled={busy || snapshot.cpaCodexTesting.active}><Power size={16} />启用 .json</button>
      <button onClick={() => setEnabled(false)} disabled={busy || snapshot.cpaCodexTesting.active}><PowerOff size={16} />停用 .json.0</button>
      <button onClick={() => syncToLibrary(ids())} disabled={busy || snapshot.cpaCodexTesting.active}><FolderSync size={16} />同步选中到 aa</button>
      <button onClick={() => onEditMetadata(ids())} disabled={busy || snapshot.cpaCodexTesting.active}><Tags size={16} />标签与分组</button>
      <button className="danger-button" onClick={() => remove()} disabled={busy || snapshot.cpaCodexTesting.active}><Trash2 size={16} />删除选中</button>
    </div>}
    {snapshot.cpaCodexTesting.active && <div className="task-progress"><div style={{ width: `${snapshot.cpaCodexTesting.total ? snapshot.cpaCodexTesting.done / snapshot.cpaCodexTesting.total * 100 : 0}%` }} /><span>{snapshot.cpaCodexTesting.done} / {snapshot.cpaCodexTesting.total}</span></div>}
    <div className="filter-row"><label className="search-field"><Search size={16} /><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索 CPA Codex 邮箱、等级或状态" /></label><AccountFacetFilters label="CPA Codex" facets={availableFacets} value={facetFilters} onChange={setFacetFilters} /><select aria-label="CPA Codex 排序" value={sort} onChange={(event) => setSort(event.target.value as AccountSortMode)}>{ACCOUNT_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><span className="selection-count">显示 {accounts.length} / {snapshot.cpaCodexAccounts.length} · 已选 {selected.size}</span></div>
    <div className="table-wrap" ref={virtualAccounts.scrollRef}><table><thead><tr><th className="select-column"><input type="checkbox" aria-label="选择全部 CPA Codex" checked={accounts.length > 0 && accounts.every((item) => selected.has(item.id))} onChange={(event) => setSelected(event.target.checked ? new Set(accounts.map((item) => item.id)) : new Set())} /></th><th>账号</th><th>状态</th><th>等级</th><th>额度与重置</th><th>文件状态</th><th>托管文件</th></tr></thead><tbody>{virtualAccounts.paddingTop > 0 && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={7} style={{ height: virtualAccounts.paddingTop }} /></tr>}{virtualAccounts.rows.map(({ index, item: account }) => <CpaCodexRow key={account.id} account={account} running={runningIds.has(account.id)} selected={selected.has(account.id)} toggle={() => toggleSelection(setSelected, account.id)} now={now} testMode={testMode} virtualIndex={index} rowRef={virtualAccounts.enabled ? virtualAccounts.measureElement : undefined} openContextMenu={(event) => {
      event.preventDefault()
      if (!selected.has(account.id)) setSelected(new Set([account.id]))
      setContextMenu({ account, x: Math.min(event.clientX, window.innerWidth - 240), y: Math.min(event.clientY, window.innerHeight - 300) })
    }} />)}{virtualAccounts.paddingBottom > 0 && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={7} style={{ height: virtualAccounts.paddingBottom }} /></tr>}{!accounts.length && <tr><td colSpan={7} className="empty-state">没有匹配的 CPA Codex 账号</td></tr>}</tbody></table></div>
    {contextMenu && <div ref={contextMenuRef} className="account-context-menu" role="menu" aria-label="CPA Codex 账号管理" style={{ left: contextMenu.x, top: contextMenu.y }}>
      <div className="context-account">{contextMenu.account.alias ?? contextMenu.account.email ?? 'CPA Codex 账号'}</div>
      <button role="menuitem" onClick={() => { const id = contextMenu.account.id; setContextMenu(null); void run(() => window.codexSwitcher.testCpaCodexAccounts([id], testMode), `CPA Codex ${CODEX_TEST_MODE_SUCCESS[testMode]}`) }}><TestTube2 size={15} />检测这个账号</button>
      <button role="menuitem" onClick={() => { const account = contextMenu.account; setContextMenu(null); setEnabled(account.disabled, [account.id]) }}>{contextMenu.account.disabled ? <Power size={15} /> : <PowerOff size={15} />}{contextMenu.account.disabled ? '启用这个文件' : '停用这个文件'}</button>
      <button role="menuitem" onClick={() => { const id = contextMenu.account.id; setContextMenu(null); void run(async () => { const result = await window.codexSwitcher.revealManagedSource('cpa-codex', id); if (!result.ok) throw new Error(result.message) }, '已打开账号文件位置', false) }}><FolderOpen size={15} />打开文件位置</button>
      <button role="menuitem" onClick={() => { const id = contextMenu.account.id; setContextMenu(null); syncToLibrary([id]) }}><FolderSync size={15} />同步这个账号到 aa</button>
      <button role="menuitem" onClick={() => { const id = contextMenu.account.id; setContextMenu(null); onEditMetadata([id]) }}><Tags size={15} />编辑别名与标签</button>
      <button role="menuitem" disabled={!contextMenu.account.email} onClick={() => { if (contextMenu.account.email) void navigator.clipboard.writeText(contextMenu.account.email); setContextMenu(null) }}><Copy size={15} />复制邮箱</button>
      <button className="context-danger" role="menuitem" onClick={() => { const id = contextMenu.account.id; setContextMenu(null); remove([id]) }}><Trash2 size={15} />删除这个账号</button>
    </div>}
  </div>
}

function CpaCodexRow({ account, running, selected, toggle, now, testMode, virtualIndex, rowRef, openContextMenu }: { account: CpaCodexAccountSummary; running: boolean; selected: boolean; toggle: () => void; now: number; testMode: CodexTestMode; virtualIndex: number; rowRef?: (element: HTMLTableRowElement | null) => void; openContextMenu: (event: React.MouseEvent<HTMLTableRowElement>) => void }): React.JSX.Element {
  const status = displayStatus(account.status)
  const state = cpaFileState(account.sourcePath)
  return <tr ref={rowRef} data-index={virtualIndex} className={`account-row status-row-${status}${running ? ' testing-row' : ''}${selected ? ' selected-row' : ''}${account.disabled ? ' disabled-file-row' : ''}`} tabIndex={0} onClick={toggle} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle() } }} onContextMenu={openContextMenu}>
    <td><input type="checkbox" aria-label={`选择 CPA Codex ${account.email ?? account.id}`} checked={selected} onClick={(event) => event.stopPropagation()} onChange={toggle} /></td>
    <td><div className="account-title-line"><div className="account-email">{account.alias ?? account.email ?? '邮箱未知'}</div>{account.disabled && <span className="disabled-badge">CPA 已停用</span>}</div>{account.alias && <div className="account-secondary-email">{account.email ?? '邮箱未知'}</div>}<div className="workspace-id">{account.workspaceId ?? 'workspace 未知'}</div><MetadataChips account={account} /><div className="compact-row-meta">{account.planType ?? '未知'} · {sourceFileName(account.sourcePath)}</div></td>
    <td>{running ? <><span className="status status-testing"><LoaderCircle className="spin" size={13} />检测中</span><div className="status-detail">{CODEX_TEST_MODE_RUNNING[testMode]}</div></> : <><span className={`status status-${status}`}>{STATUS_LABELS[status]}</span><div className="status-detail" title={account.detail}>{account.detail}</div></>}</td>
    <td>{account.planType ?? '未知'}</td><td><Quota usage={account.usage} running={running} now={now} /></td>
    <td><strong className={state.className}>{state.label}</strong><div className="muted">检测 {time(account.lastCheckedAt)}</div></td>
    <td><div className="source-path" title={account.sourcePath}>{sourceFileName(account.sourcePath)}</div><div className="source-tags"><span className="provider-label codex"><Code2 size={11} />CODEX</span><span className="format-label">CPA</span></div></td>
  </tr>
}

function GrokPanel({ snapshot, onSnapshot, notify, requestConfirmation, onBusyChange, onEditMetadata, now = Date.now(), scope }: Props & { scope: 'library' | 'cpa' }): React.JSX.Element {
  const cpa = scope === 'cpa'
  const sourceAccounts = cpa ? snapshot.cpaGrokAccounts : snapshot.grokAccounts
  const testing = cpa ? snapshot.cpaGrokTesting : snapshot.grokTesting
  const [selected, setSelected] = usePrunedSelection(sourceAccounts.map((account) => account.id))
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState<DisplayAccountStatus | ''>('')
  const [facetFilters, setFacetFilters] = useState<AccountFacetFilterValues>(EMPTY_ACCOUNT_FACET_FILTERS)
  const [sort, setSort] = useState<AccountSortMode>('availability_reset')
  const [busy, setBusy] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ account: GrokAccountSummary; x: number; y: number } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!contextMenu) return
    contextMenuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setContextMenu(null)
    }
    const closeOutside = (event: PointerEvent): void => {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    window.addEventListener('pointerdown', closeOutside)
    return () => {
      window.removeEventListener('keydown', closeOnEscape)
      window.removeEventListener('pointerdown', closeOutside)
    }
  }, [contextMenu])
  const facets = useMemo(() => buildAccountFacets(sourceAccounts), [sourceAccounts])
  const availableFacets = useMemo(() => {
    if (!status) return facets
    return buildAccountFacets(sourceAccounts.filter((account) => account.status === status))
  }, [facets, sourceAccounts, status])
  useEffect(() => {
    setFacetFilters((current) => {
      const next = {
        plan: hasFacetOption(availableFacets.plans, current.plan) ? current.plan : '',
        domain: hasFacetOption(availableFacets.domains, current.domain) ? current.domain : '',
        reason: hasFacetOption(availableFacets.reasons, current.reason) ? current.reason : '',
        group: hasFacetOption(availableFacets.groups, current.group) ? current.group : '',
        tag: hasFacetOption(availableFacets.tags, current.tag) ? current.tag : ''
      }
      return next.plan === current.plan && next.domain === current.domain && next.reason === current.reason && next.group === current.group && next.tag === current.tag ? current : next
    })
  }, [availableFacets])
  const accounts = useMemo(() => sourceAccounts.filter((account) => {
    if (status && account.status !== status) return false
    if (!matchesAccountFacets(account, facetFilters)) return false
    const query = keyword.trim().toLowerCase()
    return !query || `${account.alias ?? ''} ${account.email ?? ''} ${account.subject ?? ''} ${account.teamId ?? ''} ${account.planType ?? ''} ${account.group ?? ''} ${(account.tags ?? []).join(' ')} ${account.note ?? ''} ${account.detail}`.toLowerCase().includes(query)
  }).sort(compareAccounts(sort)), [facetFilters, keyword, sort, sourceAccounts, status])
  const runningIds = useMemo(() => new Set(testing.runningIds), [testing.runningIds])
  const virtualAccounts = useVirtualTableRows(accounts, (account) => account.id)
  async function run<T>(operation: () => Promise<T>, success: string | ((result: T) => void), reload = true): Promise<void> {
    setBusy(true)
    onBusyChange?.(true)
    try {
      const result = await operation()
      if (reload) onSnapshot(await window.codexSwitcher.getPageSnapshot(cpa ? 'cpa' : 'grok'))
      if (typeof success === 'string') notify('ok', success)
      else success(result)
    }
    catch (error) { notify('error', error instanceof Error ? error.message : '操作失败') }
    finally { setBusy(false); onBusyChange?.(false) }
  }
  const chosen = (): string[] => [...selected]
  const remove = async (ids = chosen()): Promise<void> => {
    if (!ids.length || !await requestConfirmation({
      title: `删除 ${ids.length} 个 Grok 账号`,
      message: `对应的${cpa ? ' CPA' : '本地'}托管凭据文件会同时删除。`,
      detail: cpa ? '本地 aa 账号库不会被连带删除。' : 'CPA 目录中的同账号凭据不会被连带删除。',
      confirmLabel: '确认删除',
      tone: 'danger'
    })) return
    await run(async () => {
      const result = cpa
        ? await window.codexSwitcher.deleteCpaGrokAccounts(ids)
        : await window.codexSwitcher.deleteGrokAccounts(ids)
      if (!result.deleted) throw new Error('没有删除任何账号')
      setSelected(new Set())
    }, `Grok 账号已从${cpa ? ' CPA' : '本地账号库'}删除`)
  }
  const setEnabled = (enabled: boolean, ids = chosen()): void => { void run(() => cpa ? window.codexSwitcher.setCpaGrokEnabled(ids, enabled) : window.codexSwitcher.setGrokEnabled(ids, enabled), (result) => notify(result.changed ? 'ok' : 'warn', result.message)) }
  const testAccounts = (ids: string[]) => cpa ? window.codexSwitcher.testCpaGrokAccounts(ids) : window.codexSwitcher.testGrokAccounts(ids)
  const cancelTests = () => cpa ? window.codexSwitcher.cancelCpaGrokTests() : window.codexSwitcher.cancelGrokTests()
  const scan = () => cpa ? window.codexSwitcher.scanCpaGrokDirectory() : window.codexSwitcher.scanGrokDirectory()
  const exportAccounts = async (layout: 'separate' | 'bundle', ids = selected.size ? chosen() : accounts.map((item) => item.id)): Promise<void> => { if (ids.length) await run(async () => { const paths = await window.codexSwitcher.exportGrokAccounts(ids, layout); if (!paths) throw new Error('已取消导出') }, layout === 'bundle' ? 'Sub2API 合并文件已导出' : 'CPA 单账号文件已导出', false) }
  const exportToCpa = async (ids = selected.size ? chosen() : accounts.map((item) => item.id)): Promise<void> => {
    if (!ids.length) return
    await run(
      () => window.codexSwitcher.exportGrokAccountsToCpa(ids),
      (result) => notify(result.errors.length ? 'warn' : 'ok', `已导出 ${result.imported} 个 Grok 账号到 CPA，重复跳过 ${result.skipped} 个`)
    )
  }
  const syncToLibrary = (ids?: string[]): void => {
    if (!cpa) return
    void run(
      () => window.codexSwitcher.syncCpaGrokToLibrary(ids),
      (result) => notify(
        result.errors.length ? 'warn' : 'ok',
        `已同步到 aa：新增 ${result.imported} 个，重复跳过 ${result.skipped} 个${result.errors.length ? `，${result.errors.length} 个文件读取失败` : ''}`
      )
    )
  }
  return <div className="page-view accounts-view grok-view cpa-provider-view">
    <section className="library-overview"><div><span>Grok 唯一账号</span><strong>{sourceAccounts.length}</strong></div><div><span>{cpa ? 'CPA 凭据文件' : '本地托管文件'}</span><strong>{cpa ? snapshot.cpaDirectoryStats.grokFiles : sourceAccounts.length}</strong></div><div><span>已停用</span><strong>{sourceAccounts.filter((item) => item.disabled).length}</strong></div><div className="library-path"><span>{cpa ? 'CPA 共享目录' : '本地账号目录'}</span><strong title={cpa ? snapshot.grokDirectory : `${snapshot.importDirectory}\\grok`}>{cpa ? snapshot.grokDirectory : `${snapshot.importDirectory}\\grok`}</strong></div></section>
    <StatusFilterStrip value={status} counts={facets.statusCounts} total={sourceAccounts.length} onChange={setStatus} label={`${cpa ? 'CPA ' : ''}Grok 账号状态`} />
    <div className="toolbar">
      <div className="toolbar-group"><button onClick={() => void run(scan, `${cpa ? 'CPA ' : ''}Grok 扫描完成`)} disabled={busy || testing.active}><RefreshCw size={16} />重新扫描</button>{cpa && <button onClick={() => syncToLibrary()} disabled={busy || testing.active}><FolderSync size={16} />同步全部到 aa</button>}</div>
      <div className="toolbar-group"><button onClick={() => void run(() => testAccounts(accounts.map((account) => account.id)), `Grok 当前筛选 ${accounts.length} 个账号检测完成`)} disabled={busy || testing.active || accounts.length === 0}><TestTube2 size={16} />测试当前页面全部</button>{testing.active && <button className="danger-button" onClick={() => void cancelTests()}><Square size={15} />取消</button>}</div>
    </div>
    {selected.size > 0 && <div className="selection-toolbar" aria-label="Grok 选中账号操作">
      <div className="selection-summary"><CheckCircle2 size={15} /><strong>已选择 {selected.size} 个账号</strong><span>批量测试、导出或调整文件状态</span></div>
      <button onClick={() => void run(() => testAccounts(chosen()), 'Grok 选中检测完成')} disabled={busy || testing.active}><Play size={16} />测试选中</button>
      <button onClick={() => setEnabled(true)} disabled={busy || testing.active}><Power size={16} />启用 .json</button>
      <button onClick={() => setEnabled(false)} disabled={busy || testing.active}><PowerOff size={16} />停用 .json.0</button>
      {cpa && <button onClick={() => syncToLibrary(chosen())} disabled={busy || testing.active}><FolderSync size={16} />同步选中到 aa</button>}
      {!cpa && <button onClick={() => void exportToCpa()} disabled={busy || testing.active}><Zap size={16} />导出到 CPA</button>}
      {!cpa && <button onClick={() => void exportAccounts('separate')} disabled={busy || testing.active}><Download size={16} />逐号导出</button>}
      {!cpa && <button onClick={() => void exportAccounts('bundle')} disabled={busy || testing.active}><FileArchive size={16} />合并导出</button>}
      <button onClick={() => onEditMetadata(chosen())} disabled={busy || testing.active}><Tags size={16} />标签与分组</button>
      <button className="danger-button" onClick={() => void remove()} disabled={busy || testing.active}><Trash2 size={16} />删除选中</button>
    </div>}
    {testing.active && <div className="task-progress"><div style={{ width: `${testing.total ? testing.done / testing.total * 100 : 0}%` }} /><span>{testing.done} / {testing.total}</span></div>}
    <div className="filter-row"><label className="search-field"><Search size={16} /><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索 Grok 邮箱、团队或等级" /></label><AccountFacetFilters label={`${cpa ? 'CPA ' : ''}Grok`} facets={availableFacets} value={facetFilters} onChange={setFacetFilters} /><select aria-label={`${cpa ? 'CPA ' : ''}Grok 账号排序`} value={sort} onChange={(event) => setSort(event.target.value as AccountSortMode)}>{ACCOUNT_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><span className="selection-count">显示 {accounts.length} / {sourceAccounts.length} · 已选 {selected.size}</span></div>
    <div className="table-wrap" ref={virtualAccounts.scrollRef}>
      <table>
        <thead><tr><th className="select-column"><input type="checkbox" aria-label="选择全部 Grok 账号" checked={accounts.length > 0 && accounts.every((item) => selected.has(item.id))} onChange={(event) => setSelected(event.target.checked ? new Set(accounts.map((item) => item.id)) : new Set())} /></th><th>账号</th><th>状态</th><th>等级</th><th>额度与重置</th><th>文件状态</th><th>托管文件</th></tr></thead>
        <tbody>
          {virtualAccounts.paddingTop > 0 && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={7} style={{ height: virtualAccounts.paddingTop }} /></tr>}
          {virtualAccounts.rows.map(({ index, item: account }) => (
            <GrokRow
              key={account.id}
              account={account}
              running={runningIds.has(account.id)}
              selected={selected.has(account.id)}
              now={now}
              virtualIndex={index}
              rowRef={virtualAccounts.enabled ? virtualAccounts.measureElement : undefined}
              toggle={() => toggleSelection(setSelected, account.id)}
              cpa={cpa}
              openContextMenu={(event) => {
                event.preventDefault()
                if (!selected.has(account.id)) setSelected(new Set([account.id]))
                setContextMenu({
                  account,
                  x: Math.min(event.clientX, window.innerWidth - 240),
                  y: Math.min(event.clientY, window.innerHeight - 260)
                })
              }}
            />
          ))}
          {virtualAccounts.paddingBottom > 0 && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={7} style={{ height: virtualAccounts.paddingBottom }} /></tr>}
          {!accounts.length && <tr><td colSpan={7} className="empty-state">没有匹配的 Grok 账号</td></tr>}
        </tbody>
      </table>
    </div>
    {contextMenu && <div ref={contextMenuRef} className="account-context-menu" role="menu" aria-label="Grok 账号管理" style={{ left: contextMenu.x, top: contextMenu.y }}><div className="context-account">{contextMenu.account.alias ?? contextMenu.account.email ?? contextMenu.account.subject ?? 'Grok 账号'}</div><button role="menuitem" onClick={() => { const id = contextMenu.account.id; setContextMenu(null); void run(() => testAccounts([id]), 'Grok 账号检测完成') }}><TestTube2 size={15} />检测这个账号</button><button role="menuitem" onClick={() => { const account = contextMenu.account; setContextMenu(null); setEnabled(account.disabled, [account.id]) }}>{contextMenu.account.disabled ? <Power size={15} /> : <PowerOff size={15} />}{contextMenu.account.disabled ? '启用这个文件' : '停用这个文件'}</button><button role="menuitem" onClick={() => { const id = contextMenu.account.id; setContextMenu(null); void run(async () => { const result = await window.codexSwitcher.revealManagedSource(cpa ? 'cpa-grok' : 'grok', id); if (!result.ok) throw new Error(result.message) }, '已打开账号文件位置', false) }}><FolderOpen size={15} />打开文件位置</button>{cpa && <button role="menuitem" onClick={() => { const id = contextMenu.account.id; setContextMenu(null); syncToLibrary([id]) }}><FolderSync size={15} />同步这个账号到 aa</button>}<button role="menuitem" onClick={() => { const id = contextMenu.account.id; setContextMenu(null); onEditMetadata([id]) }}><Tags size={15} />编辑别名与标签</button><button role="menuitem" disabled={!contextMenu.account.email} onClick={() => { if (contextMenu.account.email) void navigator.clipboard.writeText(contextMenu.account.email); setContextMenu(null) }}><Copy size={15} />复制邮箱</button>{!cpa && <button role="menuitem" onClick={() => { const id = contextMenu.account.id; setContextMenu(null); void exportToCpa([id]) }}><Zap size={15} />导出到 CPA</button>}{!cpa && <button role="menuitem" onClick={() => { const id = contextMenu.account.id; setContextMenu(null); void exportAccounts('separate', [id]) }}><Download size={15} />导出这个账号</button>}<button className="context-danger" role="menuitem" onClick={() => { const id = contextMenu.account.id; setContextMenu(null); void remove([id]) }}><Trash2 size={15} />删除这个账号</button></div>}
  </div>
}

function GrokRow({
  account,
  running,
  selected,
  now,
  virtualIndex,
  rowRef,
  cpa,
  toggle,
  openContextMenu
}: {
  account: GrokAccountSummary
  running: boolean
  selected: boolean
  now: number
  virtualIndex: number
  rowRef?: (element: HTMLTableRowElement | null) => void
  cpa: boolean
  toggle: () => void
  openContextMenu: (event: React.MouseEvent<HTMLTableRowElement>) => void
}): React.JSX.Element {
  const status = account.status
  const state = cpaFileState(account.sourcePath)
  return (
    <tr
      ref={rowRef}
      data-index={virtualIndex}
      className={`account-row status-row-${status}${running ? ' testing-row' : ''}${selected ? ' selected-row' : ''}${account.disabled ? ' disabled-file-row' : ''}`}
      tabIndex={0}
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          toggle()
        }
      }}
      onContextMenu={openContextMenu}
    >
      <td><input type="checkbox" aria-label={`选择 Grok ${account.email ?? account.id}`} checked={selected} onClick={(event) => event.stopPropagation()} onChange={toggle} /></td>
      <td><div className="account-title-line"><div className="account-email">{account.alias ?? account.email ?? '邮箱未知'}</div>{account.disabled && <span className="disabled-badge">{cpa ? 'CPA ' : ''}已停用</span>}</div>{account.alias && <div className="account-secondary-email">{account.email ?? '邮箱未知'}</div>}<div className="workspace-id">{account.subject ?? 'subject 未知'}{account.teamId ? ` · team ${account.teamId}` : ''}</div><MetadataChips account={account} /><div className="compact-row-meta">{account.planType ?? '未知'} · {sourceFileName(account.sourcePath)}</div></td>
      <td>{running ? <><span className="status status-testing"><LoaderCircle className="spin" size={13} />检测中</span><div className="status-detail">检测完成后自动调整后缀</div></> : <><span className={`status status-${status}`}>{STATUS_LABELS[status]}</span><div className="status-detail" title={account.detail}>{account.detail}</div></>}</td>
      <td>{account.planType ?? '未知'}</td>
      <td><Quota usage={account.usage} running={running} now={now} /></td>
      <td><strong className={state.className}>{state.label}</strong><div className="muted">检测 {time(account.lastCheckedAt)}</div></td>
      <td><div className="source-path" title={account.sourcePath}>{sourceFileName(account.sourcePath)}</div><div className="source-tags"><span className="provider-label grok"><Zap size={11} />GROK</span><span className="format-label">{cpa ? 'CPA' : 'AA'}</span></div></td>
    </tr>
  )
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
      <button className={provider === 'codex' ? 'active' : ''} aria-pressed={provider === 'codex'} onClick={() => setProvider('codex')}><Code2 size={16} />Codex <span>{props.snapshot.cpaCodexAccounts.length}</span></button>
      <button className={provider === 'grok' ? 'active' : ''} aria-pressed={provider === 'grok'} onClick={() => setProvider('grok')}><Zap size={16} />Grok <span>{props.snapshot.cpaGrokAccounts.length}</span></button>
      <div className="cpa-inventory"><strong>{props.snapshot.cpaDirectoryStats.credentialFiles}</strong> 个凭据文件 · <strong>{props.snapshot.cpaCodexAccounts.length + props.snapshot.cpaGrokAccounts.length}</strong> 个唯一账号 · <strong>{props.snapshot.cpaDirectoryStats.duplicateFiles}</strong> 个重复文件{props.snapshot.cpaDirectoryStats.mixedFiles ? ` · ${props.snapshot.cpaDirectoryStats.mixedFiles} 个混合文件` : ''}{props.snapshot.cpaDirectoryStats.unrecognizedFiles ? ` · ${props.snapshot.cpaDirectoryStats.unrecognizedFiles} 个未识别文件` : ''}</div>
    </nav>
    {provider === 'codex' ? <CpaCodexPanel {...timedProps} /> : <GrokPanel {...timedProps} scope="cpa" />}
  </div>
}

export function GrokLibraryPage(props: Props): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(interval)
  }, [])
  return <GrokPanel {...props} scope="library" now={now} />
}
