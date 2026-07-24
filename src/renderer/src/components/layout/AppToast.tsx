import { CheckCircle2, CircleAlert, TriangleAlert, X } from 'lucide-react'
import { cn } from '@/lib/cn'

export type AppToastMessage = {
  kind: 'ok' | 'warn' | 'error'
  text: string
}

export function AppToast({
  message,
  onClose
}: {
  message: AppToastMessage
  onClose: () => void
}): React.JSX.Element {
  const isError = message.kind === 'error'
  const Icon = message.kind === 'ok'
    ? CheckCircle2
    : message.kind === 'warn'
      ? TriangleAlert
      : CircleAlert

  return (
    <div
      className={cn(
        'app-toast',
        `app-toast--${message.kind}`
      )}
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <span className="app-toast__icon" aria-hidden="true">
        <Icon size={17} />
      </span>
      <span className="app-toast__text">{message.text}</span>
      <button
        type="button"
        className="app-toast__close"
        title="关闭提示"
        aria-label="关闭提示"
        onClick={onClose}
      >
        <X size={15} />
      </button>
    </div>
  )
}
