import type { HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

export function PageView({ className, ...props }: HTMLAttributes<HTMLElement>): React.JSX.Element {
  return <main className={cn('page-view flex min-h-0 flex-1 flex-col gap-3 p-3', className)} {...props} />
}

export function Toolbar({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        'toolbar flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2',
        className
      )}
      {...props}
    />
  )
}

export function ToolbarGroup({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('toolbar-group flex flex-wrap items-center gap-1.5', className)} {...props} />
}

export function SearchField({
  className,
  icon,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }): React.JSX.Element {
  return (
    <label className={cn('search-field relative flex min-w-[220px] flex-1 items-center', className)}>
      {icon ? <span className="pointer-events-none absolute left-2.5 text-[var(--color-text-muted)]">{icon}</span> : null}
      <input
        className={cn(
          'h-8 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-0)] pr-2.5 text-[13px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent-strong)] focus-visible:ring-2 focus-visible:ring-[var(--ui-focus)]',
          icon ? 'pl-8' : 'px-2.5'
        )}
        {...props}
      />
    </label>
  )
}
