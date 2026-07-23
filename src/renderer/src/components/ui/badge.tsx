import { cva, type VariantProps } from 'class-variance-authority'
import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums leading-none',
  {
    variants: {
      variant: {
        default: 'bg-[var(--color-surface-3)] text-[var(--color-text-secondary)]',
        accent: 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
        grok: 'bg-[rgba(183,169,255,0.16)] text-[var(--color-grok)]',
        warn: 'bg-[rgba(227,179,65,0.16)] text-[var(--color-warn)]',
        danger: 'bg-[rgba(255,123,114,0.16)] text-[var(--color-danger)]'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
)

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
