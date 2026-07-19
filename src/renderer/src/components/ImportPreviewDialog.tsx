import {
  CheckCircle2,
  CircleAlert,
  Code2,
  LoaderCircle,
  RotateCcw,
  Search,
  Square,
  SquareCheckBig,
  TestTube2,
  X,
  Zap
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ImportPreviewTestProgress } from '../../../shared/ipc'
import type {
  DisplayAccountStatus,
  ImportPreviewDecision,
  ImportPreviewDisposition,
  ImportPreviewItem,
  ImportPreviewManualMode,
  ImportPreviewResult,
  UsageSummary
} from '../../../shared/types'
import { STATUS_LABELS } from '../account-status'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useVirtualTableRows } from '../hooks/useVirtualTableRows'

const DISPOSITION_LABELS: Record<ImportPreviewDisposition, string> = {
  new: '新增',
  duplicate: '完全重复',
  update: '可更新',
  conflict: '身份冲突'
}

const DECISION_LABELS: Record<ImportPreviewDecision, string> = {
  add: '新增',
  replace: '合并更新',
  skip: '跳过'
}

const TEST_STATUS_ORDER: DisplayAccountStatus[] = [
  'untested',
  'valid',
  'quota_exhausted_5h',
  'quota_exhausted_weekly',
  'invalid',
  'unknown_error'
]

function selectedDecision(item: ImportPreviewItem): ImportPreviewDecision {
  return item.disposition === 'new' ? 'add' : 'replace'
}

function compactUsage(usage: UsageSummary | null): React.JSX.Element | null {
  if (!usage) return null
  const windows = usage.windows.slice(0, 2)
  if (windows.length === 0) return null
  return (
    <div className="preview-test-usage">
      {windows.map((window) => (
        <span key={window.id} title={window.resetAt ? `重置 ${new Date(window.resetAt).toLocaleString('zh-CN', { hour12: false })}` : undefined}>
          {window.label.replace(/^Codex\s*/i, '')} {window.remainingPercent === null ? '-' : `${Math.round(window.remainingPercent)}%`}
        </span>
      ))}
    </div>
  )
}

export function ImportPreviewDialog({
  preview,
  busy,
  testing,
  onBack,
  onClose,
  onCommit,
  onRefine,
  onTest,
  onCancelTest
}: {
  preview: ImportPreviewResult
  busy: boolean
  testing: ImportPreviewTestProgress | null
  onBack: () => void
  onClose: () => void
  onCommit: (decisions: Record<string, ImportPreviewDecision>, skipUnrecognized: boolean) => void
  onRefine: (sourceKey: string, mode: ImportPreviewManualMode) => Promise<void>
  onTest: (itemKeys?: string[]) => Promise<void>
  onCancelTest: () => void
}): React.JSX.Element {
  const [keyword, setKeyword] = useState('')
  const [provider, setProvider] = useState<'all' | 'codex' | 'grok'>('all')
  const [disposition, setDisposition] = useState<'all' | ImportPreviewDisposition>('all')
  const [testStatus, setTestStatus] = useState<'all' | DisplayAccountStatus>('all')
  const [skipUnrecognized, setSkipUnrecognized] = useState(false)
  const [manualModes, setManualModes] = useState<Record<string, ImportPreviewManualMode | ''>>({})
  const [refiningKey, setRefiningKey] = useState<string | null>(null)
  const [decisions, setDecisions] = useState<Record<string, ImportPreviewDecision>>(() =>
    Object.fromEntries(preview.items.map((item) => [item.key, item.suggestedDecision]))
  )
  const interactionLocked = busy || Boolean(testing?.active)
  const dialogRef = useDialogFocus<HTMLElement>(true, onClose)

  useEffect(() => {
    setDecisions((current) => {
      const next: Record<string, ImportPreviewDecision> = {}
      for (const item of preview.items) {
        const decision = current[item.key] ?? item.suggestedDecision
        next[item.key] = decision === 'add' && item.disposition !== 'new' ? 'replace' : decision
      }
      return next
    })
    setManualModes((current) => {
      const next: Record<string, ImportPreviewManualMode | ''> = {}
      for (const source of preview.unrecognized) next[source.key] = current[source.key] ?? ''
      return next
    })
    if (preview.unrecognized.length === 0) setSkipUnrecognized(false)
  }, [preview.items, preview.sessionId, preview.unrecognized])

  const items = useMemo(() => {
    const query = keyword.trim().toLocaleLowerCase('zh-CN')
    return preview.items.filter((item) => {
      if (provider !== 'all' && item.provider !== provider) return false
      if (disposition !== 'all' && item.disposition !== disposition) return false
      if (testStatus !== 'all' && (item.test?.status ?? 'untested') !== testStatus) return false
      if (!query) return true
      return `${item.email ?? ''} ${item.planType ?? ''} ${item.identity} ${item.sourcePath} ${item.detail} ${item.test?.detail ?? ''}`
        .toLocaleLowerCase('zh-CN')
        .includes(query)
    })
  }, [disposition, keyword, preview.items, provider, testStatus])
  const virtualItems = useVirtualTableRows(items, (item) => item.key, 88)
  const selectedKeys = useMemo(() => preview.items
    .filter((item) => (decisions[item.key] ?? item.suggestedDecision) !== 'skip')
    .map((item) => item.key), [decisions, preview.items])
  const selectedSet = useMemo(() => new Set(selectedKeys), [selectedKeys])
  const selectedCount = selectedKeys.length
  const selectedFilteredCount = items.filter((item) => selectedSet.has(item.key)).length
  const allFilteredSelected = items.length > 0 && selectedFilteredCount === items.length
  const someFilteredSelected = selectedFilteredCount > 0 && !allFilteredSelected
  const runningKeys = useMemo(() => new Set(testing?.runningKeys ?? []), [testing?.runningKeys])
  const hasUnrecognized = preview.unrecognized.length > 0
  const canCommit = selectedCount > 0 || (hasUnrecognized && skipUnrecognized)
  const counts = useMemo(() => ({
    new: preview.items.filter((item) => item.disposition === 'new').length,
    update: preview.items.filter((item) => item.disposition === 'update').length,
    duplicate: preview.items.filter((item) => item.disposition === 'duplicate').length,
    conflict: preview.items.filter((item) => item.disposition === 'conflict').length
  }), [preview.items])
  const testStatusCounts = useMemo(() => {
    const result = new Map<DisplayAccountStatus, number>()
    for (const item of preview.items) {
      const status = item.test?.status ?? 'untested'
      result.set(status, (result.get(status) ?? 0) + 1)
    }
    return result
  }, [preview.items])

  const setItemSelected = (item: ImportPreviewItem, selected: boolean): void => {
    if (interactionLocked) return
    setDecisions((current) => ({
      ...current,
      [item.key]: selected ? selectedDecision(item) : 'skip'
    }))
  }
  const setFilteredSelected = (selected: boolean): void => {
    if (interactionLocked) return
    setDecisions((current) => {
      const next = { ...current }
      for (const item of items) next[item.key] = selected ? selectedDecision(item) : 'skip'
      return next
    })
  }
  const applySuggestions = (): void => {
    setDecisions(Object.fromEntries(preview.items.map((item) => [item.key, item.suggestedDecision])))
  }
  const importUseful = (): void => {
    setDecisions(Object.fromEntries(preview.items.map((item) => [
      item.key,
      item.disposition === 'new' ? 'add' : item.disposition === 'update' ? 'replace' : 'skip'
    ])))
  }

  return (
    <section
      ref={dialogRef}
      className={`compact-dialog import-dialog import-preview-dialog${preview.items.length > 4 || hasUnrecognized ? ' import-preview-dialog-tall' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="导入预检"
      tabIndex={-1}
    >
      <div className="panel-header">
        <div>
          <h2>确认导入账号</h2>
          <div className="provider-detection">
            <span>识别 {preview.recognized} 条</span>
            <span className="preview-count new">新增 {counts.new}</span>
            <span className="preview-count update">更新 {counts.update}</span>
            <span className="preview-count duplicate">重复 {counts.duplicate}</span>
            {counts.conflict > 0 && <span className="preview-count conflict">冲突 {counts.conflict}</span>}
          </div>
        </div>
        <button className="icon-button" title="关闭" aria-label="关闭导入预检" onClick={onClose} disabled={interactionLocked}><X size={18} /></button>
      </div>

      <div className="preview-toolbar">
        <label className="search-field"><Search size={16} /><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="搜索邮箱、等级或来源" /></label>
        <select aria-label="导入账号类型" value={provider} onChange={(event) => setProvider(event.target.value as typeof provider)} disabled={interactionLocked}>
          <option value="all">全部类型</option><option value="codex">Codex</option><option value="grok">Grok</option>
        </select>
        <select aria-label="导入处理状态" value={disposition} onChange={(event) => setDisposition(event.target.value as typeof disposition)} disabled={interactionLocked}>
          <option value="all">全部结果</option>
          {Object.entries(DISPOSITION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select aria-label="凭证检测结果" value={testStatus} onChange={(event) => setTestStatus(event.target.value as typeof testStatus)} disabled={interactionLocked}>
          <option value="all">全部检测状态</option>
          {TEST_STATUS_ORDER.filter((status) => testStatusCounts.has(status)).map((status) => (
            <option key={status} value={status}>{STATUS_LABELS[status]} {testStatusCounts.get(status)}</option>
          ))}
        </select>
        <button onClick={applySuggestions} disabled={interactionLocked}><RotateCcw size={15} />采用建议</button>
        <button onClick={importUseful} disabled={interactionLocked}><CheckCircle2 size={15} />新增/更新</button>
      </div>

      <div className="preview-selection-bar">
        <div className="preview-selection-actions">
          <button onClick={() => setFilteredSelected(true)} disabled={interactionLocked || items.length === 0}><SquareCheckBig size={15} />全选当前</button>
          <button onClick={() => setFilteredSelected(false)} disabled={interactionLocked || selectedFilteredCount === 0}><Square size={15} />清空当前</button>
          <span>已选 {selectedCount} / {preview.items.length}</span>
        </div>
        <div className="preview-test-actions">
          {testing?.active ? (
            <>
              <div className="preview-test-progress" aria-label={`导入凭证检测进度 ${testing.done}/${testing.total}`}>
                <span><LoaderCircle className="spin" size={14} />检测中 {testing.done}/{testing.total}</span>
                <progress max={Math.max(1, testing.total)} value={testing.done} />
              </div>
              <button className="secondary-button" onClick={onCancelTest}><X size={15} />取消检测</button>
            </>
          ) : (
            <>
              <button onClick={() => void onTest(selectedKeys)} disabled={busy || selectedCount === 0}><TestTube2 size={15} />检测选中</button>
              <button onClick={() => void onTest()} disabled={busy || preview.items.length === 0}><TestTube2 size={15} />一键检测全部</button>
            </>
          )}
        </div>
      </div>

      {preview.errors.length > 0 && (
        <details className="preview-errors">
          <summary><CircleAlert size={15} />{preview.errors.length} 项未识别或读取异常</summary>
          <div>{preview.errors.slice(0, 100).map((error, index) => <p key={`${index}-${error}`}>{error}</p>)}</div>
        </details>
      )}

      {hasUnrecognized && (
        <section className="preview-unrecognized" aria-label="未识别来源">
          <div className="preview-unrecognized-heading">
            <CircleAlert size={17} />
            <div>
              <strong>发现 {preview.unrecognized.length} 个无法识别的来源</strong>
              <span>这些内容不会自动导入。请选择一种明确的解析方式，成功后才会加入下方列表。</span>
            </div>
          </div>
          <div className="preview-unrecognized-list">
            {preview.unrecognized.map((source) => (
              <div key={source.key} className="preview-unrecognized-item">
                <div className="preview-unrecognized-main">
                  <strong title={source.sourcePath}>{source.sourcePath.split(/[\\/]/).at(-1) ?? source.sourcePath}</strong>
                  <span>{source.detail}</span>
                  <em>{source.sourceFormat.toUpperCase()}</em>
                </div>
                <div className="preview-unrecognized-refine">
                  <select
                    aria-label={`${source.key} 的手动识别方式`}
                    value={manualModes[source.key] ?? ''}
                    onChange={(event) => setManualModes((current) => ({
                      ...current,
                      [source.key]: event.target.value as ImportPreviewManualMode | ''
                    }))}
                    disabled={interactionLocked}
                  >
                    <option value="">选择识别方式</option>
                    <option value="codex">Codex JSON / AT</option>
                    <option value="grok">Grok JSON / AT</option>
                    <option value="codex_rt">Codex RT</option>
                    <option value="mobile_rt">移动端 RT</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => {
                      const mode = manualModes[source.key]
                      if (!mode) return
                      setRefiningKey(source.key)
                      void onRefine(source.key, mode).finally(() => setRefiningKey(null))
                    }}
                    disabled={interactionLocked || !manualModes[source.key]}
                  >
                    {refiningKey === source.key ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}
                    重新识别
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="preview-unrecognized-actions">
            <button onClick={onBack} disabled={interactionLocked}><RotateCcw size={15} />返回重新选择</button>
            <label><input type="checkbox" checked={skipUnrecognized} onChange={(event) => setSkipUnrecognized(event.target.checked)} disabled={interactionLocked} />我确认跳过以上未识别内容</label>
          </div>
        </section>
      )}

      <div className="import-preview-table" ref={virtualItems.scrollRef}>
        <table>
          <thead>
            <tr>
              <th className="preview-select-column">
                <input
                  type="checkbox"
                  aria-label="选择当前筛选的导入账号"
                  checked={allFilteredSelected}
                  ref={(node) => { if (node) node.indeterminate = someFilteredSelected }}
                  onChange={(event) => setFilteredSelected(event.target.checked)}
                  disabled={interactionLocked || items.length === 0}
                />
              </th>
              <th>账号</th><th>识别结果</th><th>账号检测</th><th>来源</th><th>处理方式</th>
            </tr>
          </thead>
          <tbody>
            {virtualItems.paddingTop > 0 && <tr className="virtual-spacer"><td colSpan={6} style={{ height: virtualItems.paddingTop }} /></tr>}
            {virtualItems.rows.map(({ index, item }) => {
              const selected = selectedSet.has(item.key)
              const running = runningKeys.has(item.key)
              return (
                <tr
                  key={item.key}
                  data-index={index}
                  ref={virtualItems.enabled ? virtualItems.measureElement : undefined}
                  className={`preview-row disposition-${item.disposition}${selected ? ' selected-row' : ''}${running ? ' testing-row' : ''}`}
                  tabIndex={interactionLocked ? -1 : 0}
                  onClick={() => setItemSelected(item, !selected)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    setItemSelected(item, !selected)
                  }}
                >
                  <td className="preview-select-column">
                    <input
                      type="checkbox"
                      aria-label={`选择导入 ${item.email ?? item.identity}`}
                      checked={selected}
                      disabled={interactionLocked}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setItemSelected(item, event.target.checked)}
                    />
                  </td>
                  <td>
                    <div className="preview-account-title">{item.provider === 'codex' ? <Code2 size={14} /> : <Zap size={14} />}<strong>{item.email ?? '邮箱未知'}</strong></div>
                    <div className="muted">{item.planType ?? '未知等级'} · {item.canRefresh ? '可刷新' : '不可刷新'}</div>
                  </td>
                  <td><span className={`preview-disposition ${item.disposition}`}>{DISPOSITION_LABELS[item.disposition]}</span><div className="status-detail" title={item.detail}>{item.detail}</div></td>
                  <td>
                    {running ? (
                      <span className="preview-test-status status-testing"><LoaderCircle className="spin" size={13} />检测中</span>
                    ) : item.test ? (
                      <>
                        <span className={`preview-test-status status-${item.test.status}`}>{STATUS_LABELS[item.test.status]}</span>
                        <div className="status-detail" title={item.test.detail}>{item.test.detail}</div>
                        {compactUsage(item.test.usage)}
                      </>
                    ) : <span className="preview-test-status status-untested">未检测</span>}
                  </td>
                  <td><div className="source-path" title={item.sourcePath}>{item.sourcePath.split(/[\\/]/).at(-1)}</div><div className="muted">{item.sourceDialect.toUpperCase()} · {item.sourceFormat.toUpperCase()}</div></td>
                  <td>
                    <select
                      aria-label={`${item.email ?? item.identity} 的导入方式`}
                      value={decisions[item.key] ?? item.suggestedDecision}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setDecisions((current) => ({ ...current, [item.key]: event.target.value as ImportPreviewDecision }))}
                      disabled={interactionLocked}
                    >
                      <option value="add" disabled={item.disposition !== 'new'}>{DECISION_LABELS.add}</option>
                      <option value="replace">{DECISION_LABELS.replace}</option>
                      <option value="skip">{DECISION_LABELS.skip}</option>
                    </select>
                  </td>
                </tr>
              )
            })}
            {virtualItems.paddingBottom > 0 && <tr className="virtual-spacer"><td colSpan={6} style={{ height: virtualItems.paddingBottom }} /></tr>}
            {items.length === 0 && <tr><td colSpan={6} className="empty-state">当前筛选没有账号</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="panel-actions import-preview-actions">
        <span>将处理 <strong>{selectedCount}</strong> 个账号，跳过 {preview.items.length - selectedCount} 个{hasUnrecognized ? `，另有 ${preview.unrecognized.length} 个来源待处理` : ''}</span>
        <button className="secondary-button" onClick={onBack} disabled={interactionLocked}><RotateCcw size={16} />返回修改</button>
        <button className="primary-button" onClick={() => onCommit(decisions, skipUnrecognized)} disabled={interactionLocked || !canCommit || (hasUnrecognized && !skipUnrecognized)}>
          {busy ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}确认写入 aa
        </button>
      </div>
    </section>
  )
}
