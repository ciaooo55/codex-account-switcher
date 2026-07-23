import { CheckCircle2, CircleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui'
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
  return (
    <div
      className={cn(
        'message fixed right-3 top-[4.5rem] z-50 flex max-w-[min(480px,calc(100vw-1.5rem))] items-start gap-2 rounded-[var(--radius-lg)] border px-3 py-2.5 text-[13px] shadow-[var(--shadow-md)] backdrop-blur-xl',
        message.kind === 'ok' && 'ok border-[rgba(90,212,143,0.35)] bg-[rgba(18,40,28,0.92)] text-[var(--color-accent)]',
        message.kind === 'warn' && 'warn border-[rgba(227,179,65,0.35)] bg-[rgba(42,34,12,0.92)] text-[var(--color-warn)]',
        message.kind === 'error' && 'error border-[rgba(255,123,114,0.35)] bg-[rgba(48,18,16,0.92)] text-[var(--color-danger)]'
      )}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {message.kind === 'ok' ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <CircleAlert size={16} className="mt-0.5 shrink-0" />}
      <span className="min-w-0 flex-1 leading-snug text-[var(--color-text)]">{message.text}</span>
      <Button
        variant="ghost"
        size="icon"
        className="message-close h-6 w-6 shrink-0"
        title="关闭提示"
        aria-label="关闭提示"
        onClick={onClose}
      >
        <X size={14} />
      </Button>
    </div>
  )
}
