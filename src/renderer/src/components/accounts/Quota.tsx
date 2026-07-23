import { LoaderCircle } from 'lucide-react'
import type { AccountSummary } from '../../../../shared/types'
import { dateTime, resetCountdown, resetMoment } from '../../lib/format'

export function Quota({
  account,
  running = false,
  now
}: {
  account: AccountSummary
  running?: boolean
  now: number
}): React.JSX.Element {
  if (running) {
    return (
      <span className="testing-inline">
        <LoaderCircle className="spin" size={14} />正在刷新额度
      </span>
    )
  }
  if (!account.usage) return <span className="muted">-</span>
  const { windows, credits, spendLimit, resetCreditsAvailable } = account.usage
  if (
    windows.length === 0 &&
    !credits &&
    !spendLimit &&
    resetCreditsAvailable == null
  ) return <span className="muted">-</span>
  return (
    <div className="quota-list">
      {windows.slice(0, 3).map((window) => {
        const remaining = window.remainingPercent
        const className = remaining !== null && remaining <= 10 ? 'danger' : remaining !== null && remaining <= 30 ? 'warn' : ''
        const countdown = resetCountdown(window, account.usage!.checkedAt, now)
        return (
          <div className="quota-item" key={window.id}>
            <div className="quota-label">
              <span>{window.label}</span>
              <span className="quota-values"><strong>{remaining === null ? '-' : `${Math.round(remaining)}%`}</strong>{countdown && <em>{countdown}</em>}</span>
            </div>
            <div className="quota-track">
              <div className={`quota-fill ${className}`} style={{ width: `${remaining ?? 0}%` }} />
            </div>
            <span className="quota-reset">重置 {resetMoment(window, account.usage!.checkedAt)}</span>
          </div>
        )
      })}
      {credits && (
        <div className="quota-meta">
          <span>额外余额</span>
          <strong>{credits.unlimited ? '无限' : credits.balance ?? (credits.hasCredits ? '可用' : '0')}</strong>
        </div>
      )}
      {spendLimit && (
        <div className="quota-meta" title={spendLimit.resetAt ? `重置 ${dateTime(spendLimit.resetAt)}` : undefined}>
          <span>支出限额</span>
          <strong>{spendLimit.remainingPercent !== null ? `${Math.round(spendLimit.remainingPercent)}%` : spendLimit.remaining ?? '-'}</strong>
        </div>
      )}
      {resetCreditsAvailable != null && (
        <div className="quota-meta"><span>重置券</span><strong>{resetCreditsAvailable}</strong></div>
      )}
    </div>
  )
}