import {
  BadgeCheck,
  CheckCircle2,
  CircleAlert,
  ShieldAlert,
  Trash2,
  X
} from 'lucide-react'
import { useDialogFocus } from '../hooks/useDialogFocus'

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
    <div className="confirmation-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className={`confirmation-dialog confirmation-${tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirmation-title"
        aria-describedby="confirmation-message"
        tabIndex={-1}
      >
        <header className="confirmation-header">
          <span className="confirmation-symbol" aria-hidden="true"><HeaderIcon size={20} /></span>
          <div>
            <h2 id="confirmation-title">{title}</h2>
            <span>请确认本次操作</span>
          </div>
          <button className="icon-button dialog-close-button" title="关闭" aria-label="关闭确认弹窗" onClick={onCancel}>
            <X size={18} />
          </button>
        </header>
        <div className="confirmation-content">
          <p id="confirmation-message">{message}</p>
          {detail && <div className="confirmation-detail">{detail}</div>}
        </div>
        <footer className="panel-actions confirmation-actions">
          <button className="secondary-button" onClick={onCancel}>
            <X size={16} />{cancelLabel}
          </button>
          <button className={tone === 'danger' ? 'danger-button' : 'primary-button'} onClick={onConfirm}>
            <ConfirmIcon size={16} />{confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  )
}
