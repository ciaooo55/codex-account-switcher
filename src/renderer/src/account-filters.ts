import type { AccountStatus, DisplayAccountStatus } from '../../shared/types'
import { displayStatus, STATUS_LABELS } from './account-status'

export interface FacetableAccount {
  email: string | null
  planType: string | null
  status: AccountStatus | DisplayAccountStatus
  detail: string
}

export interface AccountFacetFilters {
  plan: string
  domain: string
  reason: string
}

export interface AccountFacetOption {
  value: string
  label: string
  count: number
}

export interface AccountFacets {
  plans: AccountFacetOption[]
  domains: AccountFacetOption[]
  reasons: AccountFacetOption[]
  statusCounts: Record<DisplayAccountStatus, number>
}

const UNKNOWN_PLAN = '__unknown_plan__'
const UNKNOWN_DOMAIN = '__unknown_domain__'

export const EMPTY_ACCOUNT_FACET_FILTERS: AccountFacetFilters = {
  plan: '',
  domain: '',
  reason: ''
}

function statusOf(account: FacetableAccount): DisplayAccountStatus {
  return account.status === 'unknown_error'
    ? 'unknown_error'
    : displayStatus(account.status as AccountStatus)
}

function planValue(account: FacetableAccount): { value: string; label: string } {
  const label = account.planType?.trim()
  return label
    ? { value: label.toLowerCase(), label }
    : { value: UNKNOWN_PLAN, label: '未知类型' }
}

function domainValue(account: FacetableAccount): { value: string; label: string } {
  const email = account.email?.trim().toLowerCase()
  const separator = email?.lastIndexOf('@') ?? -1
  if (!email || separator <= 0 || separator === email.length - 1) {
    return { value: UNKNOWN_DOMAIN, label: '邮箱未知' }
  }
  const domain = email.slice(separator + 1)
  return { value: domain, label: `@${domain}` }
}

function reasonValue(account: FacetableAccount): string | null {
  const status = statusOf(account)
  if (status !== 'invalid' && status !== 'unknown_error') return null
  return account.detail.trim() || STATUS_LABELS[status]
}

function add(
  target: Map<string, { label: string; count: number }>,
  value: string,
  label: string
): void {
  const current = target.get(value)
  if (current) current.count += 1
  else target.set(value, { label, count: 1 })
}

function options(values: Map<string, { label: string; count: number }>): AccountFacetOption[] {
  return [...values].map(([value, item]) => ({ value, ...item })).sort((left, right) =>
    right.count - left.count || left.label.localeCompare(right.label, 'zh-CN')
  )
}

export function buildAccountFacets(accounts: readonly FacetableAccount[]): AccountFacets {
  const plans = new Map<string, { label: string; count: number }>()
  const domains = new Map<string, { label: string; count: number }>()
  const reasons = new Map<string, { label: string; count: number }>()
  const statusCounts: Record<DisplayAccountStatus, number> = {
    untested: 0,
    valid: 0,
    quota_exhausted_5h: 0,
    quota_exhausted_weekly: 0,
    invalid: 0,
    unknown_error: 0
  }

  for (const account of accounts) {
    const plan = planValue(account)
    const domain = domainValue(account)
    const reason = reasonValue(account)
    add(plans, plan.value, plan.label)
    add(domains, domain.value, domain.label)
    if (reason) add(reasons, reason, reason)
    statusCounts[statusOf(account)] += 1
  }

  return {
    plans: options(plans),
    domains: options(domains),
    reasons: options(reasons),
    statusCounts
  }
}

export function matchesAccountFacets(
  account: FacetableAccount,
  filters: AccountFacetFilters
): boolean {
  if (filters.plan && planValue(account).value !== filters.plan) return false
  if (filters.domain && domainValue(account).value !== filters.domain) return false
  if (filters.reason && reasonValue(account) !== filters.reason) return false
  return true
}

export function hasFacetOption(options: readonly AccountFacetOption[], value: string): boolean {
  return !value || options.some((option) => option.value === value)
}

