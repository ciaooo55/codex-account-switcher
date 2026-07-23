import {
  BadgeCheck,
  CheckCircle2,
  CircleAlert,
  ShieldAlert,
  Trash2,
  X
} from 'lucide-react'
import { Button } from '@/components/ui'
import { cn } from '@/lib/cn'
import { useDialogFocus } from '@/hooks/useDialogFocus'

export type ConfirmationTone = 'default' | 'warning' | 'danger'

export interface ConfirmationOptions {
  title: string
  message: string
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: ConfirmationTone
}

interface Props extends ConfirmationOptions {
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmationDialog({
  title,
  message,
  detail,
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'default',
  onCancel,
  onConfirm
}: Props): React.JSX.Element {
  const dialogRef = useDialogFocus<HTMLElement>(true, onCancel)
  const HeaderIcon = tone === 'danger' ? CircleAlert : tone === 'warning' ? ShieldAlert : BadgeCheck
  const ConfirmIcon = tone === 'danger' ? Trash2 : CheckCircle2

  return (
    <div className="confirmation-backdrop fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]" role="presentation">
      <section
        ref={dialogRef}
        className={cn(
          'confirmation-dialog w-full max-w-[440px] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-0)] shadow-[var(--shadow-lg)]',
          'confirmation-' + tone
        )}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirmation-title"
        aria-describedby="confirmation-message"
        tabIndex={-1}
      >
        <header className="confirmation-header flex items-start gap-3 border-b border-[var(--color-border)] px-4 py-3">
          <span
            className={cn(
              'confirmation-symbol mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)]',
              tone === 'danger' && 'bg-[rgba(255,123,114,0.14)] text-[var(--color-danger)]',
              tone === 'warning' && 'bg-[rgba(227,179,65,0.14)] text-[var(--color-warn)]',
              tone === 'default' && 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
            )}
            aria-hidden="true"
          >
            <HeaderIcon size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="confirmation-title" className="text-[15px] font-semibold text-[var(--color-text)]">{title}</h2>
            <span className="text-[12px] text-[var(--color-text-muted)]">请确认本次操作</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="dialog-close-button"
            title="关闭"
            aria-label="关闭确认弹窗"
            onClick={onCancel}
          >
            <X size={18} />
          </Button>
        </header>
        <div className="confirmation-content space-y-2 px-4 py-3">
          <p id="confirmation-message" className="text-[13px] leading-relaxed text-[var(--color-text)]">{message}</p>
          {detail ? (
            <div className="confirmation-detail rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
              {detail}
            </div>
          ) : null}
        </div>
        <footer className="panel-actions confirmation-actions flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
          <Button variant="secondary" onClick={onCancel}>
            <X size={16} />{cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'default'} onClick={onConfirm}>
            <ConfirmIcon size={16} />{confirmLabel}
          </Button>
        </footer>
      </section>
    </div>
  )
}
