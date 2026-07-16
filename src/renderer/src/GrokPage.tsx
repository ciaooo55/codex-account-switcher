import {
  Copy,
  Download,
  FileArchive,
  LoaderCircle,
  Play,
  RefreshCw,
  Search,
  Square,
  TestTube2,
  Trash2,
  Zap
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { AppSnapshot } from '../../shared/ipc'
import type { DisplayAccountStatus, GrokAccountSummary, UsageWindow } from '../../shared/types'

const LABELS: Record<DisplayAccountStatus, string> = {
  untested: '未测试',
  valid: '有效',
  invalid: '已失效',
  quota_exhausted_weekly: '周额度耗尽',
  quota_exhausted_5h: '5 小时额度耗尽',
  unknown_error: '未知错误'
}

function time(value: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function reset(window: UsageWindow): string {
  if (window.resetAt) return time(window.resetAt)
  return '-'
}

function GrokQuota({ account, running }: { account: GrokAccountSummary; running: boolean }): React.JSX.Element {
  if (running) return <span className="testing-inline"><LoaderCircle className="spin" size={14} />正在读取额度</span>
  if (!account.usage?.windows.length) return <span className="muted">-</span>
  return <div className="quota-list">
    {account.usage.windows.slice(0, 3).map((window) => {
      const remaining = window.remainingPercent
      return <div className="quota-item" key={window.id}>
        <div className="quota-label"><span>{window.label}</span><strong>{remaining === null ? '-' : `${Math.round(remaining)}%`}</strong></div>
        <div className="quota-track"><div className={`quota-fill ${remaining !== null && remaining <= 10 ? 'danger' : remaining !== null && remaining <= 30 ? 'warn' : ''}`} style={{ width: `${remaining ?? 0}%` }} /></div>
        <span className="quota-reset">重置 {reset(window)}</span>
      </div>
    })}
  </div>
}

interface Props {
  snapshot: AppSnapshot
  onSnapshot: (snapshot: AppSnapshot) => void
  notify: (kind: 'ok' | 'warn' | 'error', text: string) => void
}

export function GrokPage({ snapshot, onSnapshot, notify }: Props): React.JSX.Element {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState<DisplayAccountStatus | ''>('')
  const [busy, setBusy] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ account: GrokAccountSummary; x: number; y: number } | null>(null)

  const accounts = useMemo(() => snapshot.grokAccounts.filter((account) => {
    if (status && account.status !== status) return false
    const query = keyword.trim().toLowerCase()
    return !query || `${account.email ?? ''} ${account.subject ?? ''} ${account.teamId ?? ''} ${account.planType ?? ''} ${account.detail}`.toLowerCase().includes(query)
  }), [keyword, snapshot.grokAccounts, status])

  const run = async (operation: () => Promise<unknown>, success: string): Promise<void> => {
    setBusy(true)
    try {
      await operation()
      onSnapshot(await window.codexSwitcher.getSnapshot())
      notify('ok', success)
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (ids = [...selected]): Promise<void> => {
    if (!ids.length || !window.confirm(`确定删除选中的 ${ids.length} 个 Grok 账号吗？对应账号文件会同时删除。`)) return
    await run(async () => {
      const result = await window.codexSwitcher.deleteGrokAccounts(ids)
      if (!result.deleted) throw new Error('没有删除任何账号')
      setSelected(new Set())
    }, 'Grok 账号已删除')
  }

  const selectRow = (event: React.MouseEvent, id: string): void => {
    if (event.ctrlKey || event.metaKey) {
      setSelected((current) => {
        const next = new Set(current)
        next.has(id) ? next.delete(id) : next.add(id)
        return next
      })
      return
    }
    setSelected(new Set([id]))
  }

  const exportAccounts = async (layout: 'separate' | 'bundle', chosen?: string[]): Promise<void> => {
    const ids = chosen ?? (selected.size ? [...selected] : accounts.map((account) => account.id))
    if (!ids.length) return
    await run(async () => {
      const paths = await window.codexSwitcher.exportGrokAccounts(ids, layout)
      if (!paths) throw new Error('已取消导出')
    }, layout === 'bundle' ? 'Sub2API 合并文件已导出' : 'CPA 单账号文件已导出')
  }

  const counts = (value: DisplayAccountStatus): number => snapshot.grokAccounts.filter((item) => item.status === value).length

  return <div className="page-view accounts-view grok-view">
    <section className="summary-band grok-summary">
      <div><span>Grok 账号</span><strong>{snapshot.grokAccounts.length}</strong></div>
      <div><span>有效</span><strong className="text-ok">{counts('valid')}</strong></div>
      <div><span>周额度耗尽</span><strong className="text-warn">{counts('quota_exhausted_weekly')}</strong></div>
      <div><span>已失效</span><strong className="text-error">{counts('invalid')}</strong></div>
      <div><span>未知错误</span><strong>{counts('unknown_error')}</strong></div>
      <div><span>账号目录</span><strong title={snapshot.grokDirectory}>{snapshot.grokDirectory}</strong></div>
    </section>

    <div className="toolbar grok-toolbar">
      <div className="toolbar-group">
      <button onClick={() => void run(() => window.codexSwitcher.scanGrokDirectory(), 'Grok 账号目录已重新整理')} disabled={busy}><RefreshCw size={16} />重新扫描</button>
      </div>
      <div className="toolbar-group">
      <button onClick={() => void run(() => window.codexSwitcher.testGrokAccounts(), 'Grok 全部账号检测完成')} disabled={busy || snapshot.grokTesting.active}><TestTube2 size={16} />测试全部</button>
      <button onClick={() => void run(() => window.codexSwitcher.testGrokAccounts([...selected]), 'Grok 选中账号检测完成')} disabled={busy || !selected.size || snapshot.grokTesting.active}><Play size={16} />测试选中</button>
      {snapshot.grokTesting.active && <button className="danger-button" onClick={() => void window.codexSwitcher.cancelGrokTests()}><Square size={15} />取消</button>}
      </div>
      <div className="toolbar-group toolbar-group-end">
      <button onClick={() => void exportAccounts('separate')} disabled={busy || (!selected.size && !accounts.length)} title="导出为 CPA 一账号一文件"><Download size={16} />逐号导出</button>
      <button onClick={() => void exportAccounts('bundle')} disabled={busy || (!selected.size && !accounts.length)} title="导出为 Sub2API 合并文件"><FileArchive size={16} />合并导出</button>
      <button className="danger-button" onClick={() => void remove()} disabled={busy || !selected.size || snapshot.grokTesting.active}><Trash2 size={16} />删除选中</button>
      </div>
    </div>

    {snapshot.grokTesting.active && <div className="task-progress"><div style={{ width: `${snapshot.grokTesting.total ? snapshot.grokTesting.done / snapshot.grokTesting.total * 100 : 0}%` }} /><span>{snapshot.grokTesting.done} / {snapshot.grokTesting.total}</span></div>}
    <div className="filter-row">
      <label className="search-field"><Search size={16} /><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索邮箱、团队、等级或状态" /></label>
      <select value={status} onChange={(event) => setStatus(event.target.value as DisplayAccountStatus | '')}><option value="">全部状态</option>{Object.entries(LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
      <span className="selection-count">显示 {accounts.length} / {snapshot.grokAccounts.length} · 已选 {selected.size}</span>
    </div>

    <div className="table-wrap">
      <table>
        <thead><tr><th className="select-column"><input type="checkbox" aria-label="选择全部 Grok 账号" checked={accounts.length > 0 && accounts.every((item) => selected.has(item.id))} onChange={(event) => setSelected(event.target.checked ? new Set(accounts.map((item) => item.id)) : new Set())} /></th><th>账号</th><th>状态</th><th>等级</th><th>用量与重置</th><th>凭据时间</th><th>托管文件</th></tr></thead>
        <tbody>{accounts.map((account) => {
          const running = snapshot.grokTesting.runningIds.includes(account.id)
          return <tr key={account.id} className={`account-row status-row-${account.status}${running ? ' testing-row' : ''}${selected.has(account.id) ? ' selected-row' : ''}`} onClick={(event) => selectRow(event, account.id)} onContextMenu={(event) => {
            event.preventDefault()
            setSelected(new Set([account.id]))
            setContextMenu({ account, x: Math.min(event.clientX, window.innerWidth - 240), y: Math.min(event.clientY, window.innerHeight - 230) })
          }}>
            <td><input type="checkbox" aria-label={`选择 Grok ${account.email ?? account.id}`} checked={selected.has(account.id)} onClick={(event) => event.stopPropagation()} onChange={() => setSelected((current) => { const next = new Set(current); next.has(account.id) ? next.delete(account.id) : next.add(account.id); return next })} /></td>
            <td><div className="account-title-line"><div className="account-email">{account.email ?? '邮箱未知'}</div></div><div className="workspace-id">{account.subject ?? 'subject 未知'}{account.teamId ? ` · team ${account.teamId}` : ''}</div></td>
            <td>{running ? <><span className="status status-testing"><LoaderCircle className="spin" size={13} />检测中</span><div className="status-detail">正在刷新凭据并读取额度</div></> : <><span className={`status status-${account.status}`}>{LABELS[account.status]}</span><div className="status-detail" title={account.detail}>{account.detail}</div></>}</td>
            <td>{account.planType ?? '未知'}</td>
            <td><GrokQuota account={account} running={running} /></td>
            <td><div>刷新 {time(account.lastRefresh)}</div><div className="muted">到期 {time(account.expiresAt)}</div><div className="muted">检测 {time(account.lastCheckedAt)}</div></td>
            <td><div className="source-path" title={account.sourcePath}>{account.sourcePath}</div><div className="source-tags"><span className="provider-label grok"><Zap size={11} />GROK</span><span className="format-label">{account.sourceDialect.toUpperCase()} · JSON</span></div></td>
          </tr>
        })}{!accounts.length && <tr><td colSpan={7} className="empty-state">没有匹配的 Grok 账号</td></tr>}</tbody>
      </table>
    </div>

    {contextMenu && <div className="account-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onMouseLeave={() => setContextMenu(null)}>
      <div className="context-account">{contextMenu.account.email ?? contextMenu.account.subject ?? 'Grok 账号'}</div>
      <button role="menuitem" onClick={() => { const id = contextMenu.account.id; setContextMenu(null); void run(() => window.codexSwitcher.testGrokAccounts([id]), 'Grok 账号检测完成') }}><TestTube2 size={15} />检测这个账号</button>
      <button role="menuitem" disabled={!contextMenu.account.email} onClick={() => { if (contextMenu.account.email) void navigator.clipboard.writeText(contextMenu.account.email); setContextMenu(null) }}><Copy size={15} />复制邮箱</button>
      <button role="menuitem" onClick={() => { const id = contextMenu.account.id; setContextMenu(null); void exportAccounts('separate', [id]) }}><Download size={15} />导出这个账号</button>
      <button className="context-danger" role="menuitem" onClick={() => { const id = contextMenu.account.id; setContextMenu(null); void remove([id]) }}><Trash2 size={15} />删除这个账号</button>
    </div>}
  </div>
}
