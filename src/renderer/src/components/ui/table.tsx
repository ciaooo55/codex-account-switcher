import type { HTMLAttributes, ReactNode, TableHTMLAttributes } from 'react'
import { forwardRef } from 'react'
import { cn } from '@/lib/cn'

export const TableWrap = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function TableWrap(
  { className, ...props },
  ref
) {
  return (
    <div
      ref={ref}
      className={cn(
        'table-wrap min-h-0 flex-1 overflow-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-0)]',
        className
      )}
      {...props}
    />
  )
})

export function DataTable({ className, ...props }: TableHTMLAttributes<HTMLTableElement>): React.JSX.Element {
  return <table className={cn('w-full border-collapse text-left text-[13px]', className)} {...props} />
}

export function EmptyTableRow({
  colSpan,
  children = '没有匹配的账号'
}: {
  colSpan: number
  children?: ReactNode
}): React.JSX.Element {
  return (
    <tr>
      <td colSpan={colSpan} className="empty-state px-3 py-10 text-center text-[13px] text-[var(--color-text-muted)]">
        {children}
      </td>
    </tr>
  )
}
