import { CircleAlert, LoaderCircle, Wrench, X } from 'lucide-react'
import type { RefObject } from 'react'
import type { SessionRepairProgress } from '../../../../shared/ipc'
import type { SessionRepairPreview } from '../../../../shared/types'
import { Button, DialogActions, DialogBackdrop, DialogHeader, DialogPanel, Progress, Select } from '@/components/ui'

export function SessionRepairDialog({
  dialogRef,
  preview,
  progress,
  threadIds,
  busy,
  onClose,
  onChangeProvider,
  onConfirm
}: {
  dialogRef: RefObject<HTMLElement | null>
  preview: SessionRepairPreview
  progress: SessionRepairProgress | null
  threadIds?: string[] | null
  busy: boolean
  onClose: () => void
  onChangeProvider: (provider: string) => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <DialogBackdrop>
      <DialogPanel
        ref={dialogRef}
        className="repair-dialog max-w-[720px]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="repair-title"
        tabIndex={-1}
      >
        <DialogHeader>
          <h2 id="repair-title" className="text-[15px] font-semibold text-[var(--color-text)]">修复历史会话</h2>
          <Button variant="ghost" size="icon" title="关闭" aria-label="关闭会话修复" onClick={onClose} disabled={busy}><X size={18} /></Button>
        </DialogHeader>
        <label className="repair-provider block space-y-1.5 px-4 py-3 text-[13px]">
          目标供应商
          <Select
            aria-label="目标供应商"
            value={preview.targetProvider}
            disabled={busy}
            onChange={(event) => onChangeProvider(event.target.value)}
          >
            {preview.availableProviders.map((provider: string) => (
              <option key={provider} value={provider}>
                {provider}{provider === preview.currentProvider ? '（当前）' : ''}
              </option>
            ))}
          </Select>
        </label>
        <div className="repair-metrics grid grid-cols-2 gap-2 px-4 pb-3 sm:grid-cols-3">
          {[
            ['扫描会话', preview.scannedSessionFiles],
            ['待改文件', preview.changedSessionFiles],
            ['SQLite 供应商', preview.sqliteProviderRows],
            ['可见性', preview.sqliteUserEventRows],
            ['工作区路径', preview.sqliteCwdRows],
            ['全局状态', preview.globalStateKeys]
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2">
              <span className="block text-[11px] text-[var(--color-text-muted)]">{label}</span>
              <strong className="text-[13px] text-[var(--color-text)]">{value}</strong>
            </div>
          ))}
        </div>
        {preview.encryptedContentFiles > 0 && (
          <div className="repair-warning mx-4 mb-2 flex items-start gap-2 rounded-[var(--radius-md)] border border-[rgba(227,179,65,0.28)] bg-[rgba(227,179,65,0.08)] px-3 py-2 text-[12px]">
            <CircleAlert size={17} className="mt-0.5 shrink-0 text-[var(--color-warn)]" />
            <span>
              {preview.encryptedContentFiles} 个会话包含来自{' '}
              {preview.encryptedContentProviders.join('、') || '其他供应商'} 的加密内容，
              跨供应商继续或压缩时可能需要切回原供应商。
            </span>
          </div>
        )}
        {preview.skippedLockedFiles.length > 0 && (
          <div className="repair-warning mx-4 mb-2 flex items-start gap-2 rounded-[var(--radius-md)] border border-[rgba(227,179,65,0.28)] bg-[rgba(227,179,65,0.08)] px-3 py-2 text-[12px]">
            <CircleAlert size={17} className="mt-0.5 shrink-0 text-[var(--color-warn)]" />
            <span>{preview.skippedLockedFiles.length} 个锁定文件将被跳过。</span>
          </div>
        )}
        <div className="repair-note px-4 pb-3 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
          {threadIds?.length
            ? `将深度同步选中的 ${threadIds.length} 个对话，覆盖其中全部会话元数据。`
            : '将快速同步官方状态库引用的历史对话，仅检查每个对话的首条元数据。'}
          应用会自动关闭正在运行的 Codex；写入前会校验快照并创建备份，写入后会再次扫描确认结果。
        </div>
        {progress && (
          <div className="repair-progress px-4 pb-2" aria-live="polite">
            <Progress
              value={Math.round((progress.done / Math.max(1, progress.total)) * 100)}
              label={`${progress.message}（${progress.done}/${progress.total}）`}
            />
          </div>
        )}
        <DialogActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}><X size={16} />取消</Button>
          <Button variant="default" onClick={onConfirm} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Wrench size={16} />}
            确认修复
          </Button>
        </DialogActions>
      </DialogPanel>
    </DialogBackdrop>
  )
}
