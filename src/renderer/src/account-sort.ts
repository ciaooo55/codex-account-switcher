import type { AccountStatus, DisplayAccountStatus, UsageSummary } from '../../shared/types'

export type AccountSortMode = 'quota_desc' | 'quota_asc' | 'plan' | 'status' | 'email'

export interface SortableAccount {
  email: string | null
  planType: string | null
  status: AccountStatus | DisplayAccountStatus
  usage: UsageSummary | null
  disabled?: boolean
}

function quota(account: SortableAccount): number {
  const windows = account.usage?.windows ?? []
  const weekly = windows.find((item) => item.windowSeconds === 604_800 || /周|week/i.test(item.label))
  const candidates = (weekly ? [weekly] : windows)
    .map((item) => item.remainingPercent)
    .filter((value): value is number => value !== null)
  return candidates.length ? Math.min(...candidates) : -1
}

function available(account: SortableAccount): number {
  if (account.disabled || account.status === 'quota_exhausted_weekly' || account.status === 'quota_exhausted_5h' || account.status === 'quota_exhausted') return 0
  return quota(account) > 0 || account.status === 'valid' ? 1 : 0
}

function text(value: string | null): string {
  return value?.trim().toLowerCase() ?? ''
}

export function compareAccounts(mode: AccountSortMode): (left: SortableAccount, right: SortableAccount) => number {
  return (left, right) => {
    if (mode === 'quota_desc' || mode === 'quota_asc') {
      const availableOrder = available(right) - available(left)
      if (availableOrder) return availableOrder
      const quotaOrder = mode === 'quota_desc' ? quota(right) - quota(left) : quota(left) - quota(right)
      if (quotaOrder) return quotaOrder
    }
    if (mode === 'plan') {
      const planOrder = text(left.planType).localeCompare(text(right.planType))
      if (planOrder) return planOrder
      const quotaOrder = quota(right) - quota(left)
      if (quotaOrder) return quotaOrder
    }
    if (mode === 'status') {
      const statusOrder = String(left.status).localeCompare(String(right.status))
      if (statusOrder) return statusOrder
    }
    return text(left.email).localeCompare(text(right.email))
  }
}

export const ACCOUNT_SORT_OPTIONS: Array<{ value: AccountSortMode; label: string }> = [
  { value: 'quota_desc', label: '有额度优先（高到低）' },
  { value: 'quota_asc', label: '有额度优先（低到高）' },
  { value: 'plan', label: '账号类型 / 等级' },
  { value: 'status', label: '账号状态' },
  { value: 'email', label: '邮箱' }
]
