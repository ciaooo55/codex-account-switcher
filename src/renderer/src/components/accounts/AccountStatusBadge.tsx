import { LoaderCircle } from 'lucide-react'
import type { DisplayAccountStatus } from '../../../../shared/types'
import { STATUS_LABELS } from '../../account-status'
import { cn } from '@/lib/cn'

export function AccountStatusBadge({
  status,
  running,
  runningLabel = '检测中'
}: {
  status: DisplayAccountStatus
  running?: boolean
  runningLabel?: string
}): React.JSX.Element {
  if (running) {
    return (
      <span className="status status-testing inline-flex items-center gap-1 rounded-full bg-[rgba(90,212,143,0.12)] px-2 py-0.5 text-[12px] font-medium text-[var(--color-accent)]">
        <LoaderCircle className="spin" size={13} />
        {runningLabel}
      </span>
    )
  }
  return (
    <span className={cn('status', 'status-' + status, 'inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-medium')}>
      {STATUS_LABELS[status]}
    </span>
  )
}
