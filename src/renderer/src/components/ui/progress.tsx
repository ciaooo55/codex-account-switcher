import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export function Progress({
  value,
  className,
  label,
  action
}: {
  value: number
  className?: string
  label?: ReactNode
  action?: ReactNode
}): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, value))
  return (
    <div className={cn('task-progress relative overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-2)]', className)}>
      <div
        className="absolute inset-y-0 left-0 bg-[var(--color-accent-soft)] transition-[width] duration-200"
        style={{ width: pct + '%' }}
      />
      <div className="relative z-[1] flex items-center justify-between gap-2 px-2.5 py-1.5 text-[12px] text-[var(--color-text-secondary)]">
        <span className="min-w-0 truncate">{label}</span>
        {action}
      </div>
    </div>
  )
}
