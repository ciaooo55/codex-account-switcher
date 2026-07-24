import { CircleAlert, FolderOpen, LoaderCircle, X, Zap } from 'lucide-react'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { AccountSummary, CredentialExportFormat, CredentialExportLayout } from '../../../../shared/types'
import {
  Button,
  DialogActions,
  DialogBackdrop,
  DialogHeader,
  DialogPanel,
  SegmentedButton,
  SegmentedControl
} from '@/components/ui'

export type ExportDialogState = {
  accountIds: string[]
  format: CredentialExportFormat
  layout: CredentialExportLayout
  defaultPriority: number
  individualPriorities: boolean
  priorities: Record<string, number>
}

export function ExportAccountsDialog({
  dialogRef,
  exportDialog,
  setExportDialog,
  accountById,
  busy,
  onClose,
  onExport,
  onExportToCpa
}: {
  dialogRef: RefObject<HTMLElement | null>
  exportDialog: ExportDialogState
  setExportDialog: Dispatch<SetStateAction<ExportDialogState | null>>
  accountById: Map<string, AccountSummary>
  busy: boolean
  onClose: () => void
  onExport: () => void
  onExportToCpa: () => void
}): React.JSX.Element {
  return (
    <DialogBackdrop>
      <DialogPanel ref={dialogRef} className="max-w-[720px]" role="dialog" aria-modal="true" aria-label="导出账号" tabIndex={-1}>
        <DialogHeader>
          <h2 className="text-[15px] font-semibold text-[var(--color-text)]">导出 {exportDialog.accountIds.length} 个账号</h2>
          <Button variant="ghost" size="icon" title="关闭" aria-label="关闭账号导出" onClick={onClose} disabled={busy}><X size={18} /></Button>
        </DialogHeader>
        <div className="option-group space-y-2 px-4 py-3">
          <span className="text-[12px] text-[var(--color-text-secondary)]">目标格式</span>
          <SegmentedControl className="format-control">
            <SegmentedButton selected={exportDialog.format === 'cpa'} onClick={() => setExportDialog({ ...exportDialog, format: 'cpa' })}>CPA</SegmentedButton>
            <SegmentedButton selected={exportDialog.format === 'sub2api'} onClick={() => setExportDialog({ ...exportDialog, format: 'sub2api' })}>SubAPI</SegmentedButton>
            <SegmentedButton selected={exportDialog.format === 'codex'} onClick={() => setExportDialog({ ...exportDialog, format: 'codex' })}>Codex auth.json</SegmentedButton>
          </SegmentedControl>
        </div>
        <div className="option-group space-y-2 px-4 pb-3">
          <span className="text-[12px] text-[var(--color-text-secondary)]">文件布局</span>
          <SegmentedControl>
            <SegmentedButton selected={exportDialog.layout === 'separate'} onClick={() => setExportDialog({ ...exportDialog, layout: 'separate' })}>每账号一文件</SegmentedButton>
            <SegmentedButton selected={exportDialog.layout === 'bundle'} onClick={() => setExportDialog({ ...exportDialog, layout: 'bundle' })}>
              {exportDialog.format === 'sub2api' ? '合并单文件' : '合并 ZIP'}
            </SegmentedButton>
          </SegmentedControl>
        </div>
        {exportDialog.format !== 'codex' && (
          <div className="priority-editor space-y-2 border-t border-[var(--color-border)] px-4 py-3">
            <label className="priority-batch flex items-center gap-2 text-[13px]">
              <span>统一优先级</span>
              <input
                aria-label="统一优先级"
                type="number"
                min={0}
                max={1_000_000}
                step={1}
                className="h-8 w-28 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-0)] px-2 text-[13px]"
                value={exportDialog.defaultPriority}
                onChange={(event) => {
                  const value = Math.max(0, Math.min(1_000_000, Math.trunc(Number(event.target.value) || 0)))
                  setExportDialog((current) => current ? {
                    ...current,
                    defaultPriority: value,
                    priorities: Object.fromEntries(current.accountIds.map((id) => [id, value]))
                  } : null)
                }}
              />
            </label>
            <span className="priority-hint block text-[12px] text-[var(--color-text-muted)]">
              {exportDialog.format === 'cpa' ? 'CPA 数值越大越优先，未设置时默认为 0。' : 'Sub2API 数值越小越优先，项目默认值为 50。'}
            </span>
            {exportDialog.accountIds.length > 1 && (
              <label className="priority-toggle flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={exportDialog.individualPriorities}
                  onChange={(event) => setExportDialog({ ...exportDialog, individualPriorities: event.target.checked })}
                />
                <span>分别设置每个账号</span>
              </label>
            )}
            {exportDialog.individualPriorities && (
              <div className="priority-account-list max-h-[220px] space-y-1 overflow-auto" aria-label="逐账号优先级">
                {exportDialog.accountIds.map((id) => {
                  const account = accountById.get(id)
                  const label = account?.email ?? account?.workspaceId ?? id
                  return (
                    <label key={id} className="priority-account-row grid grid-cols-[1fr_auto_88px] items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] px-2 py-1.5 text-[12px]">
                      <span className="truncate" title={label}>{label}</span>
                      <small className="text-[var(--color-text-muted)]">{account?.planType ?? '未知'}</small>
                      <input
                        aria-label={`${label} 的优先级`}
                        type="number"
                        min={0}
                        max={1_000_000}
                        step={1}
                        className="h-7 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-0)] px-1.5"
                        value={exportDialog.priorities[id] ?? exportDialog.defaultPriority}
                        onChange={(event) => {
                          const value = Math.max(0, Math.min(1_000_000, Math.trunc(Number(event.target.value) || 0)))
                          setExportDialog((current) => current ? {
                            ...current,
                            priorities: { ...current.priorities, [id]: value }
                          } : null)
                        }}
                      />
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        )}
        <div className="export-warning mx-4 mb-3 flex items-start gap-2 rounded-[var(--radius-md)] border border-[rgba(227,179,65,0.28)] bg-[rgba(227,179,65,0.08)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
          <CircleAlert size={17} className="mt-0.5 shrink-0 text-[var(--color-warn)]" />
          <span>
            {exportDialog.format === 'codex'
              ? 'Codex auth.json 没有优先级字段；多账号只能打包为 ZIP。'
              : '普通导出可选择任意目录；直接导出到 CPA 时，同账号不会重复创建文件，只更新凭证和优先级。'}
          </span>
        </div>
        <DialogActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}><X size={16} />取消</Button>
          {exportDialog.format === 'cpa' && (
            <Button onClick={onExportToCpa} disabled={busy}><Zap size={16} />直接导出到 CPA</Button>
          )}
          <Button variant="default" onClick={onExport} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={16} />}
            选择目录并导出
          </Button>
        </DialogActions>
      </DialogPanel>
    </DialogBackdrop>
  )
}
