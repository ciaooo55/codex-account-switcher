import type { InputHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

export function Input({ className, type = 'text', ...props }: InputProps): React.JSX.Element {
  return (
    <input
      type={type}
      className={cn(
        'flex h-8 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-0)] px-2.5 text-[13px] text-[var(--color-text)] shadow-[var(--shadow-sm)] outline-none transition-[border-color,box-shadow] placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent-strong)] focus-visible:ring-2 focus-visible:ring-[var(--ui-focus)] disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
}
