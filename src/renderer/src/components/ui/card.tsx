import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        'rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-1)] shadow-[var(--shadow-sm)]',
        className
      )}
      {...props}
    />
  )
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-3 py-2.5', className)} {...props} />
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>): React.JSX.Element {
  return <h2 className={cn('text-[14px] font-semibold tracking-tight text-[var(--color-text)]', className)} {...props} />
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  return <p className={cn('text-[12px] text-[var(--color-text-muted)]', className)} {...props} />
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('p-3', className)} {...props} />
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-3 py-2.5', className)} {...props} />
}
