import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-md)] text-[13px] font-medium transition-[background,border-color,box-shadow,transform,opacity] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ui-focus)] disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]',
  {
    variants: {
      variant: {
        default:
          'primary-button bg-[var(--color-accent-strong)] text-[#04140c] shadow-[var(--shadow-sm)] hover:bg-[var(--color-accent)]',
        secondary:
          'secondary-button bg-[var(--color-surface-2)] text-[var(--color-text)] border border-[var(--color-border)] hover:bg-[var(--color-surface-3)]',
        outline:
          'border border-[var(--color-border-strong)] bg-transparent text-[var(--color-text)] hover:bg-[var(--color-surface-2)]',
        ghost:
          'icon-button bg-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]',
        danger:
          'danger-button bg-[rgba(255,123,114,0.14)] text-[var(--color-danger)] border border-[rgba(255,123,114,0.28)] hover:bg-[rgba(255,123,114,0.22)]',
        soft:
          'bg-[var(--color-accent-soft)] text-[var(--color-accent)] hover:bg-[rgba(90,212,143,0.22)]'
      },
      size: {
        default: 'h-8 px-3 py-0',
        sm: 'h-7 rounded-[var(--radius-sm)] px-2.5 text-xs',
        lg: 'h-9 px-4 text-sm',
        icon: 'h-8 w-8 p-0'
      }
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'default'
    }
  }
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps): React.JSX.Element {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export { buttonVariants }
