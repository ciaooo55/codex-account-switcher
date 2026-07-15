import { describe, expect, it, vi } from 'vitest'
import type { NormalizedCredential } from '../../shared/types'
import { CredentialTester, parseUsageResponse } from './detector'

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

function credential(overrides: Partial<NormalizedCredential> = {}): NormalizedCredential {
  return {
    id: 'account-a',
    email: 'person@example.com',
    accountId: 'workspace-a',
    subject: 'user-a',
    accessToken: jwt({ sub: 'user-a', exp: 1_900_000_000 }),
    refreshToken: 'refresh-a',
    idToken: jwt({ sub: 'user-a', email: 'person@example.com', exp: 1_900_000_000 }),
    planType: null,
    lastRefresh: null,
    accessExpiresAt: '2030-03-17T17:46:40.000Z',
    idExpiresAt: '2030-03-17T17:46:40.000Z',
    canRefresh: true,
    sourcePath: 'account.json',
    sourceFormat: 'json',
    sourceDialect: 'cpa',
    ...overrides
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain' }
  })
}

describe('parseUsageResponse', () => {
  it('normalizes snake_case quota windows and reset information', () => {
    const usage = parseUsageResponse(
      {
        plan_type: 'plus',
        rate_limit: {
          primary_window: {
            used_percent: 25,
            limit_window_seconds: 604_800,
            reset_at: 1_784_695_475,
            reset_after_seconds: 603_792
          },
          secondary_window: {
            used_percent: 60,
            limit_window_seconds: 18_000,
            resets_in_seconds: 14_400
          }
        },
        code_review_rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 604_800 }
        }
      },
      '2026-07-15T00:00:00.000Z'
    )

    expect(usage.planType).toBe('plus')
    expect(usage.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'codex-primary',
          label: 'Codex 周额度',
          usedPercent: 25,
          remainingPercent: 75,
          resetAt: '2026-07-22T04:44:35.000Z',
          resetInSeconds: 603_792
        }),
        expect.objectContaining({
          id: 'codex-secondary',
          label: 'Codex 5 小时',
          usedPercent: 60,
          remainingPercent: 40
        }),
        expect.objectContaining({
          id: 'review-primary',
          label: '代码审查 周额度',
          usedPercent: 10
        })
      ])
    )
  })

  it('normalizes camelCase and additional limits', () => {
    const usage = parseUsageResponse({
      planType: 'team',
      rateLimit: {
        primaryWindow: { usedPercent: 20, limitWindowSeconds: 18_000, resetsInSeconds: 300 }
      },
      additionalRateLimits: [
        {
          limitName: 'Spark',
          rateLimit: { primaryWindow: { usedPercent: 5, limitWindowSeconds: 604_800 } }
        }
      ]
    })

    expect(usage.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'codex-primary', label: 'Codex 5 小时', usedPercent: 20 }),
        expect.objectContaining({ id: 'additional-1-primary', label: 'Spark 周额度' })
      ])
    )
  })

  it('uses neutral labels when the backend omits the window duration', () => {
    const usage = parseUsageResponse({
      rate_limit: {
        primary_window: { used_percent: 12 },
        secondary_window: { used_percent: 34 }
      }
    })

    expect(usage.windows.map((window) => window.label)).toEqual([
      'Codex 主窗口',
      'Codex 次窗口'
    ])
  })
})

describe('CredentialTester', () => {
  it('matches CPA by verifying compact before loading quota', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { output: [] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          plan_type: 'plus',
          rate_limit: { primary_window: { used_percent: 20 } }
        })
      )
    const tester = new CredentialTester({ fetchImpl, now: () => new Date('2026-07-14T12:00:00Z') })

    const result = await tester.test(credential())

    expect(result.status).toBe('valid')
    expect(result.usage?.planType).toBe('plus')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://chatgpt.com/backend-api/codex/responses/compact'
    )
    expect(fetchImpl.mock.calls[1][0]).toBe('https://chatgpt.com/backend-api/wham/usage')
    expect(fetchImpl.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Originator: 'codex_cli_rs',
          'Chatgpt-Account-Id': 'workspace-a',
          Session_id: expect.any(String)
        })
      })
    )
  })

  it('refreshes after 401 and reruns the complete two-stage check', async () => {
    const refreshedAccess = jwt({ sub: 'user-a', exp: 1_910_000_000 })
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(401, { error: { message: 'expired' } }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          access_token: refreshedAccess,
          refresh_token: 'refresh-b',
          id_token: jwt({ sub: 'user-a', email: 'person@example.com', exp: 1_910_000_000 })
        })
      )
      .mockResolvedValueOnce(jsonResponse(200, { output: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { plan_type: 'plus', rate_limit: {} }))
    const onCredentialUpdated = vi.fn()
    const tester = new CredentialTester({
      fetchImpl,
      onCredentialUpdated,
      now: () => new Date('2026-07-14T12:00:00Z')
    })

    const result = await tester.test(credential())

    expect(result.status).toBe('valid')
    expect(result.refreshed).toBe(true)
    expect(onCredentialUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: refreshedAccess, refreshToken: 'refresh-b' })
    )
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('distinguishes exhausted quota and missing permission', async () => {
    const quotaTester = new CredentialTester({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse(429, {
            error: { type: 'usage_limit_reached', message: 'usage limit reached' }
          })
        )
    })
    const permissionTester = new CredentialTester({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(403, { error: { message: 'forbidden' } }))
    })

    await expect(quotaTester.test(credential())).resolves.toMatchObject({
      status: 'quota_exhausted'
    })
    await expect(permissionTester.test(credential())).resolves.toMatchObject({
      status: 'no_permission'
    })
  })

  it('preserves plain-text backend errors for an accurate test result', async () => {
    const tester = new CredentialTester({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(
        textResponse(429, 'usage limit reached; retry later')
      )
    })

    await expect(tester.test(credential())).resolves.toMatchObject({
      status: 'quota_exhausted',
      detail: 'usage limit reached; retry later'
    })
  })

  it('does not treat a transient 429 as exhausted quota', async () => {
    const tester = new CredentialTester({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(
        jsonResponse(429, { error: { type: 'rate_limit_error', message: 'retry later' } })
      )
    })

    await expect(tester.test(credential())).resolves.toMatchObject({
      status: 'network_error',
      httpStatus: 429,
      stage: 'deep-test'
    })
  })

  it('keeps a compact-verified account valid when only the quota endpoint is incompatible', async () => {
    const tester = new CredentialTester({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(200, { output: [] }))
        .mockResolvedValueOnce(jsonResponse(404, { error: { message: 'route changed' } }))
    })

    await expect(tester.test(credential())).resolves.toMatchObject({
      status: 'valid',
      stage: 'usage',
      usage: null,
      detail: expect.stringContaining('额度接口 HTTP 404')
    })
  })

  it('classifies payment-required responses as exhausted quota', async () => {
    const tester = new CredentialTester({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValueOnce(
        jsonResponse(402, { error: { code: 'payment_required', message: 'insufficient credits' } })
      )
    })

    await expect(tester.test(credential())).resolves.toMatchObject({
      status: 'quota_exhausted',
      httpStatus: 402
    })
  })

  it('reports model errors separately from credential failures', async () => {
    const tester = new CredentialTester({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse(400, { error: { code: 'model_not_found', message: 'model unavailable' } })
        )
    })

    await expect(tester.test(credential())).resolves.toMatchObject({
      status: 'model_unavailable'
    })
  })

  it('marks expired access-only credentials as non-refreshable without a network call', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const tester = new CredentialTester({
      fetchImpl,
      now: () => new Date('2026-07-14T12:00:00Z')
    })

    const result = await tester.test(
      credential({
        accessExpiresAt: '2026-07-13T12:00:00Z',
        refreshToken: null,
        canRefresh: false
      })
    )

    expect(result.status).toBe('non_refreshable')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('maps transport failures to network_error without leaking token text', async () => {
    const tester = new CredentialTester({
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error('socket closed bearer-secret'))
    })

    const result = await tester.test(credential({ accessToken: 'bearer-secret' }))

    expect(result.status).toBe('network_error')
    expect(result.detail).not.toContain('bearer-secret')
  })
})
