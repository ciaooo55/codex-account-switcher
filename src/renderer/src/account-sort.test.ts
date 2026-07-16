import { describe, expect, it } from 'vitest'
import type { SortableAccount } from './account-sort'
import { compareAccounts } from './account-sort'

function account(email: string, planType: string, remaining: number | null, status: SortableAccount['status'] = 'valid', disabled = false, resetAt: string | null = null): SortableAccount {
  return {
    email,
    planType,
    status,
    disabled,
    usage: remaining === null ? null : {
      planType,
      checkedAt: '2026-07-16T00:00:00Z',
      windows: [{ id: 'weekly', label: '周额度', usedPercent: 100 - remaining, remainingPercent: remaining, resetAt, resetInSeconds: null, windowSeconds: 604_800 }]
    }
  }
}

describe('account sorting', () => {
  it('groups usable accounts first and orders exhausted accounts by recovery time', () => {
    const values = [
      account('later@example.com', 'plus', 0, 'quota_exhausted_weekly', true, '2026-07-20T00:00:00Z'),
      account('sooner@example.com', 'plus', 0, 'quota_exhausted_weekly', true, '2026-07-18T00:00:00Z'),
      account('medium@example.com', 'team', 45),
      account('high@example.com', 'plus', 90),
      account('unknown@example.com', 'free', null, 'untested')
    ].sort(compareAccounts('availability_reset'))

    expect(values.map((item) => item.email)).toEqual([
      'high@example.com',
      'medium@example.com',
      'sooner@example.com',
      'later@example.com',
      'unknown@example.com'
    ])
  })

  it('sorts account plans first and email second', () => {
    const values = [
      account('team@example.com', 'team', 80),
      account('plus-low@example.com', 'plus', 20),
      account('plus-high@example.com', 'plus', 90)
    ].sort(compareAccounts('plan'))

    expect(values.map((item) => item.email)).toEqual([
      'plus-high@example.com',
      'plus-low@example.com',
      'team@example.com'
    ])
  })
})
