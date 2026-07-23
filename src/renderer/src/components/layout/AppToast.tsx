import { CheckCircle2, CircleAlert, X } from 'lucide-react'

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
  return (
    <div className={`message ${message.kind}`} role="status" aria-live="polite" aria-atomic="true">
      {message.kind === 'ok' ? <CheckCircle2 size={16} /> : <CircleAlert size={16} />}
      <span>{message.text}</span>
      <button className="message-close" title="关闭提示" aria-label="关闭提示" onClick={onClose}><X size={14} /></button>
    </div>
  )
}