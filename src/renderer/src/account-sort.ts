import type { AccountStatus, DisplayAccountStatus, UsageSummary } from '../../shared/types'

export type AccountSortMode = 'availability_reset' | 'plan' | 'status' | 'email'

export interface SortableAccount {
  email: string | null
  planType: string | null
  status: AccountStatus | DisplayAccountStatus
  usage: UsageSummary | null
  disabled?: boolean
}

function availabilityRank(account: SortableAccount): number {
  if (!account.disabled && account.status === 'valid') return 0
  if (
    account.status === 'quota_exhausted_weekly' ||
    account.status === 'quota_exhausted_5h' ||
    account.status === 'quota_exhausted'
  ) return 1
  return 2
}

function recoveryTime(account: SortableAccount): number {
  const windows = account.usage?.windows ?? []
  const status = account.status
  const target = status === 'quota_exhausted_weekly'
    ? windows.find((item) => item.windowSeconds === 604_800 || /周|week/i.test(item.label))
    : status === 'quota_exhausted_5h' || status === 'quota_exhausted'
      ? windows.find((item) => item.windowSeconds === 18_000 || /5\s*(?:小时|h(?:our)?s?)/i.test(item.label))
      : windows.filter((item) => item.remainingPercent === 0).sort((left, right) => resetTimestamp(left.resetAt) - resetTimestamp(right.resetAt))[0]
  return resetTimestamp(target?.resetAt ?? null)
}

function resetTimestamp(value: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY
}

function text(value: string | null): string {
  return value?.trim().toLowerCase() ?? ''
}

export function compareAccounts(mode: AccountSortMode): (left: SortableAccount, right: SortableAccount) => number {
  return (left, right) => {
    if (mode === 'availability_reset') {
      const rankOrder = availabilityRank(left) - availabilityRank(right)
      if (rankOrder) return rankOrder
      if (availabilityRank(left) === 1) {
        const recoveryOrder = recoveryTime(left) - recoveryTime(right)
        if (recoveryOrder) return recoveryOrder
      }
    }
    if (mode === 'plan') {
      const planOrder = text(left.planType).localeCompare(text(right.planType))
      if (planOrder) return planOrder
    }
    if (mode === 'status') {
      const statusOrder = String(left.status).localeCompare(String(right.status))
      if (statusOrder) return statusOrder
    }
    return text(left.email).localeCompare(text(right.email))
  }
}

export const ACCOUNT_SORT_OPTIONS: Array<{ value: AccountSortMode; label: string }> = [
  { value: 'availability_reset', label: '可用优先 / 最早恢复' },
  { value: 'plan', label: '账号类型 / 等级' },
  { value: 'status', label: '账号状态' },
  { value: 'email', label: '邮箱' }
]
