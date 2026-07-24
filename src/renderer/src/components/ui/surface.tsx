import type { ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { forwardRef } from 'react'
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

export function DialogBackdrop({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        'repair-backdrop fixed inset-0 z-[70] flex items-start justify-center overflow-auto bg-black/50 p-4 backdrop-blur-[2px]',
        className
      )}
      role="presentation"
      {...props}
    />
  )
}

export const DialogPanel = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(function DialogPanel(
  { className, ...props },
  ref
) {
  return (
    <section
      ref={ref}
      className={cn(
        'compact-dialog my-6 w-full max-w-[720px] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface-0)] shadow-[var(--shadow-lg)]',
        className
      )}
      {...props}
    />
  )
})

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        'panel-header flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3',
        className
      )}
      {...props}
    />
  )
}

export function DialogActions({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        'panel-actions flex flex-wrap items-center justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3',
        className
      )}
      {...props}
    />
  )
}

export function SegmentedControl({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        'segmented-control inline-flex flex-wrap items-center gap-0.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-0)] p-0.5',
        className
      )}
      {...props}
    />
  )
}

export function SegmentedButton({
  selected,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'h-8 rounded-[calc(var(--radius-md)-2px)] px-2.5 text-[12px] font-medium transition-colors',
        selected
          ? 'selected bg-[var(--color-surface-2)] text-[var(--color-text)] shadow-[var(--shadow-sm)]'
          : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-1)] hover:text-[var(--color-text)]',
        className
      )}
      aria-pressed={selected}
      {...props}
    />
  )
}
