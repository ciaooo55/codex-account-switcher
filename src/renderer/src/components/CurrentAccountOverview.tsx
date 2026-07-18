import { BadgeCheck, LoaderCircle, RefreshCw } from 'lucide-react'
import type { AccountSummary, UsageWindow } from '../../../shared/types'

function sourceName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1)?.replace(/\.json$/i, '') ?? '当前账号'
}

function dateTime(value: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function resetSeconds(window: UsageWindow, checkedAt: string, now: number): number | null {
  if (window.resetAt) {
    const resetAt = Date.parse(window.resetAt)
    return Number.isFinite(resetAt) ? Math.max(0, Math.ceil((resetAt - now) / 1_000)) : null
  }
  if (window.resetInSeconds === null) return null
  const checked = Date.parse(checkedAt)
  const elapsed = Number.isFinite(checked) ? Math.max(0, Math.floor((now - checked) / 1_000)) : 0
  return Math.max(0, window.resetInSeconds - elapsed)
}

function quotaText(window: UsageWindow | undefined, checkedAt: string, now: number, weekly: boolean): string {
  if (!window) return '-'
  const remaining = window.remainingPercent === null ? '-' : `${Math.round(window.remainingPercent)}%`
  const seconds = resetSeconds(window, checkedAt, now)
  if (seconds === null) return remaining
  const countdown = weekly ? `${Math.ceil(seconds / 3_600)} 小时` : `${Math.ceil(seconds / 60)} 分钟`
  return `${remaining} · ${countdown}`
}

export function CurrentAccountOverview({
  account,
  running,
  now,
  disabled,
  onRefresh
}: {
  account: AccountSummary | null
  running: boolean
  now: number
  disabled: boolean
  onRefresh: () => void
}): React.JSX.Element {
  if (!account) {
    return (
      <div className="current-account-overview current-summary">
        <div className="current-account-identity">
          <span>当前正在使用</span>
          <strong>未知 / API 模式</strong>
          <small>当前 auth.json 未匹配到账号库</small>
        </div>
      </div>
    )
  }

  const windows = account.usage?.windows ?? []
  const fiveHour = windows.find((item) => item.windowSeconds === 18_000 || /5\s*(?:小时|h(?:our)?s?)/i.test(item.label))
  const weekly = windows.find((item) => item.windowSeconds === 604_800 || /周|week/i.test(item.label))
  const checkedAt = account.usage?.checkedAt ?? account.lastCheckedAt ?? new Date(now).toISOString()

  return (
    <div className="current-account-overview current-summary">
      <div className="current-account-identity">
        <span>当前正在使用</span>
        <strong title={account.email ?? account.sourcePath}>
          <BadgeCheck size={14} />{account.email ?? sourceName(account.sourcePath)}
          <em>{account.planType ?? '未知类型'}</em>
        </strong>
        <small>额度检测 {dateTime(account.lastCheckedAt)}</small>
      </div>
      <div className="current-quota" title={fiveHour?.resetAt ? `重置 ${dateTime(fiveHour.resetAt)}` : undefined}>
        <span>5 小时</span><strong>{quotaText(fiveHour, checkedAt, now, false)}</strong>
      </div>
      <div className="current-quota" title={weekly?.resetAt ? `重置 ${dateTime(weekly.resetAt)}` : undefined}>
        <span>周额度</span><strong>{quotaText(weekly, checkedAt, now, true)}</strong>
      </div>
      <button
        className="current-refresh-button"
        disabled={disabled || running}
        onClick={onRefresh}
      >
        {running ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
        {running ? '刷新中' : '刷新额度'}
      </button>
    </div>
  )
}
