import type { DisplayAccountStatus } from '../../../shared/types'
import { STATUS_LABELS } from '../account-status'

export function StatusFilterStrip({
  value,
  counts,
  total,
  onChange,
  label
}: {
  value: DisplayAccountStatus | ''
  counts: Readonly<Partial<Record<DisplayAccountStatus, number>>>
  total: number
  onChange: (status: DisplayAccountStatus | '') => void
  label: string
}): React.JSX.Element {
  return (
    <div className="status-filter-strip" aria-label={label}>
      <button
        className={value === '' ? 'active' : ''}
        aria-pressed={value === ''}
        onClick={() => onChange('')}
      >
        <span>全部</span><strong>{total}</strong>
      </button>
      {Object.entries(STATUS_LABELS).filter(([status]) =>
        (counts[status as DisplayAccountStatus] ?? 0) > 0 || value === status
      ).map(([status, statusLabel]) => (
        <button
          key={status}
          className={`${value === status ? 'active ' : ''}filter-${status}`}
          aria-pressed={value === status}
          onClick={() => onChange(status as DisplayAccountStatus)}
        >
          <span>{statusLabel}</span><strong>{counts[status as DisplayAccountStatus] ?? 0}</strong>
        </button>
      ))}
    </div>
  )
}
