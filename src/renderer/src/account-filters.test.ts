import { describe, expect, it } from 'vitest'
import type { FacetableAccount } from './account-filters'
import {
  buildAccountFacets,
  matchesAccountFacets
} from './account-filters'

function account(overrides: Partial<FacetableAccount> = {}): FacetableAccount {
  return {
    email: 'person@example.com',
    planType: 'plus',
    status: 'valid',
    detail: '正常可用',
    ...overrides
  }
}

describe('account facets', () => {
  it('derives only plan types, domains, reasons and statuses that exist in the data', () => {
    const facets = buildAccountFacets([
      account({ group: '日常', tags: ['稳定'] }),
      account({ email: 'team@outlook.com', planType: 'team', status: 'invalid', detail: 'Refresh token 已失效', group: '工作', tags: ['高优先级', '稳定'] }),
      account({ email: 'other@outlook.com', planType: 'team', status: 'network_error', detail: 'CPA 请求超时' }),
      account({ email: null, planType: null, status: 'quota_exhausted_weekly', detail: '周额度耗尽' })
    ])

    expect(facets.plans).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'team', count: 2 }),
      expect.objectContaining({ value: 'plus', count: 1 }),
      expect.objectContaining({ label: '未知类型', count: 1 })
    ]))
    expect(facets.domains).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'outlook.com', count: 2 }),
      expect.objectContaining({ value: 'example.com', count: 1 }),
      expect.objectContaining({ label: '邮箱未知', count: 1 })
    ]))
    expect(facets.reasons.map((item) => item.value)).toEqual(expect.arrayContaining([
      'Refresh token 已失效',
      'CPA 请求超时'
    ]))
    expect(facets.reasons).toHaveLength(2)
    expect(facets.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: '__unknown_group__', count: 2 }),
      expect.objectContaining({ value: '日常', count: 1 }),
      expect.objectContaining({ value: '工作', count: 1 })
    ]))
    expect(facets.tags).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: '稳定', count: 2 }),
      expect.objectContaining({ value: '高优先级', count: 1 })
    ]))
    expect(facets.statusCounts).toMatchObject({
      valid: 1,
      invalid: 1,
      unknown_error: 1,
      quota_exhausted: 0,
      quota_exhausted_weekly: 1,
      quota_exhausted_5h: 0,
      untested: 0
    })
  })

  it('combines dynamically selected plan, email domain and failure reason', () => {
    const invalidTeam = account({
      email: 'team@outlook.com',
      planType: 'Team',
      status: 'invalid',
      detail: '凭据被撤销',
      group: '工作',
      tags: ['待刷新']
    })

    expect(matchesAccountFacets(invalidTeam, {
      plan: 'team',
      domain: 'outlook.com',
      reason: '凭据被撤销',
      group: '工作',
      tag: '待刷新'
    })).toBe(true)
    expect(matchesAccountFacets(invalidTeam, {
      plan: 'plus',
      domain: 'outlook.com',
      reason: '凭据被撤销',
      group: '',
      tag: ''
    })).toBe(false)
  })

  it('builds facets for a large account library without changing the input', () => {
    const accounts = Array.from({ length: 10_000 }, (_, index) => account({
      email: `person-${index}@${index % 2 ? 'example.com' : 'outlook.com'}`,
      planType: index % 3 ? 'plus' : 'team',
      status: index % 5 ? 'valid' : 'quota_exhausted_5h'
    }))
    const first = accounts[0]

    const facets = buildAccountFacets(accounts)

    expect(facets.plans.reduce((total, item) => total + item.count, 0)).toBe(10_000)
    expect(facets.domains).toHaveLength(2)
    expect(facets.statusCounts.quota_exhausted_5h).toBe(2_000)
    expect(accounts[0]).toBe(first)
  })
})
