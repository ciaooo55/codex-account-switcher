import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from '@/lib/cn'

export function ContextMenu({
  className,
  style,
  menuRef,
  label,
  children
}: {
  className?: string
  style?: React.CSSProperties
  menuRef?: Ref<HTMLDivElement>
  label: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div
      ref={menuRef}
      className={cn(
        'account-context-menu fixed z-50 min-w-[220px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-0)] p-1 shadow-[var(--shadow-lg)]',
        className
      )}
      role="menu"
      aria-label={label}
      style={style}
    >
      {children}
    </div>
  )
}

export function ContextMenuLabel({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        'context-account border-b border-[var(--color-border)] px-2.5 py-2 text-[12px] font-medium text-[var(--color-text)]',
        className
      )}
      {...props}
    />
  )
}

export function ContextMenuItem({
  className,
  danger,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      className={cn(
        'flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-left text-[12.5px] text-[var(--color-text)] hover:bg-[var(--color-surface-2)] disabled:opacity-50',
        danger && 'context-danger text-[var(--color-danger)] hover:bg-[rgba(255,123,114,0.12)]',
        className
      )}
      {...props}
    />
  )
}
