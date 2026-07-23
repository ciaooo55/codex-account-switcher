import type { SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {}

export function Select({ className, children, ...props }: SelectProps): React.JSX.Element {
  return (
    <select
      className={cn(
        'h-8 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-0)] px-2 text-[12.5px] text-[var(--color-text)] outline-none focus-visible:border-[var(--color-accent-strong)] focus-visible:ring-2 focus-visible:ring-[var(--ui-focus)] disabled:opacity-50',
        className
      )}
      {...props}
    >
      {children}
    </select>
  )
}
