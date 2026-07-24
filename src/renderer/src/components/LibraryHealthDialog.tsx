import { CheckCircle2, CircleAlert, LoaderCircle, RefreshCw, ScanSearch, Wrench, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type {
  LibraryHealthIssue,
  LibraryHealthIssueKind,
  LibraryHealthReport,
  LibraryHealthScope
} from '../../../shared/types'
import { Button, DialogActions, DialogBackdrop, DialogHeader, DialogPanel, Select } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useDialogFocus } from '@/hooks/useDialogFocus'

const SCOPE_LABELS: Record<LibraryHealthScope, string> = {
  'aa-codex': 'AA Codex',
  'aa-grok': 'AA Grok',
  cpa: 'CPA',
  metadata: '本地信息'
}

const KIND_LABELS: Record<LibraryHealthIssueKind, string> = {
  duplicate_identity: '重复账号',
  noncanonical_file: '格式/位置',
  multi_account_file: '多账号文件',
  mixed_provider_file: '混合文件',
  malformed_file: '损坏文件',
  orphan_status: '孤立状态',
  orphan_metadata: '孤立标签'
}

function issueLabel(issue: LibraryHealthIssue): string {
  return issue.paths[0]?.split(/[\\/]/).at(-1) ?? `${issue.accountIds.length} 条记录`
}

export function LibraryHealthDialog({
  report,
  busy,
  onClose,
  onRefresh,
  onRepair
}: {
  report: LibraryHealthReport
  busy: boolean
  onClose: () => void
  onRefresh: () => void
  onRepair: (issueIds: string[]) => void
}): React.JSX.Element {
  const [scope, setScope] = useState<'all' | LibraryHealthScope>('all')
  const [kind, setKind] = useState<'all' | LibraryHealthIssueKind>('all')
  const [selected, setSelected] = useState<Set<string>>(() => new Set(report.issues.filter((issue) => issue.repairable).map((issue) => issue.id)))
  const dialogRef = useDialogFocus<HTMLElement>(true, onClose)

  useEffect(() => {
    setSelected(new Set(report.issues.filter((issue) => issue.repairable).map((issue) => issue.id)))
  }, [report.snapshotId])

  const issues = useMemo(() => report.issues.filter((issue) =>
    (scope === 'all' || issue.scope === scope) && (kind === 'all' || issue.kind === kind)
  ), [kind, report.issues, scope])
  const scopes = useMemo(() => [...new Set(report.issues.map((issue) => issue.scope))], [report.issues])
  const kinds = useMemo(() => [...new Set(report.issues.map((issue) => issue.kind))], [report.issues])
  const visibleRepairable = issues.filter((issue) => issue.repairable)
  const selectedCount = [...selected].filter((id) => report.issues.some((issue) => issue.id === id && issue.repairable)).length

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <DialogBackdrop>
      <DialogPanel ref={dialogRef} className="health-dialog max-w-[860px]" role="dialog" aria-modal="true" aria-label="账号库体检" tabIndex={-1}>
        <DialogHeader>
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--color-text)]">账号库体检</h2>
            <span className="dialog-subtitle text-[12px] text-[var(--color-text-muted)]">先预览，再规范化文件或清理孤立缓存</span>
          </div>
          <Button variant="ghost" size="icon" title="关闭" aria-label="关闭账号库体检" onClick={onClose} disabled={busy}><X size={18} /></Button>
        </DialogHeader>
        <section className="health-summary flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
          <div className="flex min-w-[100px] flex-col rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2"><span className="text-[11px] text-[var(--color-text-muted)]">扫描文件</span><strong className="text-[13px]">{report.scannedFiles}</strong></div>
          <div className="flex min-w-[100px] flex-col rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2"><span className="text-[11px] text-[var(--color-text-muted)]">唯一账号</span><strong className="text-[13px]">{report.healthyAccounts}</strong></div>
          <div className="flex min-w-[100px] flex-col rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2"><span className="text-[11px] text-[var(--color-text-muted)]">发现问题</span><strong className={cn('text-[13px]', report.issues.length ? 'text-warn text-[var(--color-warn)]' : 'text-ok text-[var(--color-accent)]')}>{report.issues.length}</strong></div>
          <Button onClick={onRefresh} disabled={busy} className="ml-auto">{busy ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}重新检查</Button>
        </section>
        {report.issues.length > 0 ? (
          <>
            <div className="health-filters flex flex-wrap items-center gap-2 px-4 py-3">
              <Select aria-label="体检目录范围" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
                <option value="all">全部目录</option>{scopes.map((value) => <option key={value} value={value}>{SCOPE_LABELS[value]}</option>)}
              </Select>
              <Select aria-label="体检问题类型" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
                <option value="all">全部问题</option>{kinds.map((value) => <option key={value} value={value}>{KIND_LABELS[value]}</option>)}
              </Select>
              <Button onClick={() => setSelected((current) => {
                const next = new Set(current)
                for (const issue of visibleRepairable) next.add(issue.id)
                return next
              })}>选择当前结果</Button>
              <Button onClick={() => setSelected((current) => {
                const next = new Set(current)
                for (const issue of issues) next.delete(issue.id)
                return next
              })}>取消当前选择</Button>
              <span>已选 {selectedCount} 项</span>
            </div>
            <div className="health-issue-list max-h-[420px] space-y-2 overflow-auto px-4 pb-3">
              {issues.map((issue) => (
                <label key={issue.id} className={`health-issue severity-${issue.severity}`}>
                  <input type="checkbox" disabled={!issue.repairable || busy} checked={selected.has(issue.id)} onChange={() => toggle(issue.id)} />
                  <span className="health-issue-icon">{issue.severity === 'error' ? <CircleAlert size={17} /> : <ScanSearch size={17} />}</span>
                  <span className="health-issue-main"><strong>{issue.title}</strong><small>{issue.detail}</small><em title={issue.paths.join('\n')}>{issueLabel(issue)}</em></span>
                  <span className="health-issue-kind">{SCOPE_LABELS[issue.scope]} · {KIND_LABELS[issue.kind]}</span>
                  <span className="health-repair-action">{issue.repairAction ?? '仅报告'}</span>
                </label>
              ))}
              {issues.length === 0 && <div className="empty-state">当前筛选没有问题</div>}
            </div>
          </>
        ) : (
          <div className="health-clean-state flex flex-col items-center gap-2 px-4 py-10 text-center"><CheckCircle2 size={30} className="text-[var(--color-accent)]" /><strong className="text-[14px] text-[var(--color-text)]">账号库状态正常</strong><span className="text-[12px] text-[var(--color-text-muted)]">没有发现重复、损坏、混合文件或孤立缓存</span></div>
        )}
        <DialogActions>
          <span className="panel-action-note mr-auto text-[12px] text-[var(--color-text-muted)]">损坏文件会移入应用隔离目录，不会直接永久删除。</span>
          <Button variant="secondary" onClick={onClose} disabled={busy}><X size={16} />关闭</Button>
          {report.issues.length > 0 && <Button variant="default" onClick={() => onRepair([...selected])} disabled={busy || selectedCount === 0}>{busy ? <LoaderCircle className="spin" size={16} /> : <Wrench size={16} />}修复选中</Button>}
        </DialogActions>
      </DialogPanel>
    </DialogBackdrop>
  )
}
