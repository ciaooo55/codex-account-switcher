import { describe, expect, it, vi } from 'vitest'
import type { NormalizedCredential } from '../../shared/types'
import { CredentialTester, parseResetCreditCount, parseUsageResponse } from './detector'
import { MOBILE_OAUTH_CLIENT_ID } from './refresh-token-importer'

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
    authKind: 'oauth',
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

  it('parses credits, spend controls and reset-credit counts from current Codex usage', () => {
    const usage = parseUsageResponse({
      plan_type: 'pro',
      rate_limit: {},
      credits: { has_credits: true, unlimited: false, balance: '9.99' },
      spend_control: {
        reached: false,
        individual_limit: {
          limit: '25000',
          used: '8000',
          remaining: '17000',
          remaining_percent: 68,
          reset_at: 1_784_735_851
        }
      },
      rate_limit_reset_credits: { available_count: 3 },
      rate_limit_reached_type: { type: 'workspace_member_usage_limit_reached' }
    })

    expect(usage).toMatchObject({
      credits: { hasCredits: true, unlimited: false, balance: '9.99' },
      spendLimit: {
        limit: '25000',
        used: '8000',
        remaining: '17000',
        remainingPercent: 68,
        resetAt: '2026-07-22T15:57:31.000Z'
      },
      resetCreditsAvailable: 3,
      rateLimitReachedType: 'workspace_member_usage_limit_reached'
    })
  })

  it('derives spend percentage and accepts a scalar reached type', () => {
    const usage = parseUsageResponse({
      spendControl: {
        individualLimit: { limit: '200', used: '150', remaining: '50' }
      },
      rateLimitReachedType: 'workspace_member_usage_limit_reached'
    })

    expect(usage.spendLimit?.remainingPercent).toBe(25)
    expect(usage.rateLimitReachedType).toBe('workspace_member_usage_limit_reached')
  })

  it('keeps CPA five-hour and weekly windows distinct regardless of slot names', () => {
    const usage = parseUsageResponse(
      {
        plan_type: 'k12',
        rate_limit: {
          primary_window: {
            used_percent: 100,
            limit_window_seconds: 18_000,
            reset_at: 1_784_149_051
          },
          secondary_window: {
            used_percent: 19,
            limit_window_seconds: 604_800,
            reset_at: 1_784_735_851
          }
        }
      },
      '2026-07-16T00:00:00.000Z'
    )

    expect(usage.planType).toBe('k12')
    expect(usage.windows).toEqual([
      expect.objectContaining({ label: 'Codex 5 小时', usedPercent: 100 }),
      expect.objectContaining({ label: 'Codex 周额度', usedPercent: 19 })
    ])
  })

  it('uses the Sub2API legacy mapping when the backend omits window durations', () => {
    const usage = parseUsageResponse({
      rate_limit: {
        primary_window: { used_percent: 12 },
        secondary_window: { used_percent: 34 }
      }
    })

    expect(usage.windows.map((window) => window.label)).toEqual([
      'Codex 周额度',
      'Codex 5 小时'
    ])
  })

  it('parses reset-credit detail payload variants without counting spent credits', () => {
    expect(parseResetCreditCount({ availableCount: '3' })).toBe(3)
    expect(parseResetCreditCount({
      items: [
        { resetType: 'codex_rate_limits', status: 'available' },
        { reset_type: 'codex_rate_limits', status: 'consumed' },
        { reset_type: 'other', status: 'available' }
      ]
    })).toBe(1)
  })
})

describe('CredentialTester', () => {
  it('matches CPA by loading quota before verifying compact', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          plan_type: 'plus',
          rate_limit: { primary_window: { used_percent: 20 } }
        })
      )
      .mockResolvedValueOnce(jsonResponse(200, { output: [] }))
    const tester = new CredentialTester({ fetchImpl, now: () => new Date('2026-07-14T12:00:00Z') })

    const result = await tester.test(credential())

    expect(result.status).toBe('valid')
    expect(result.usage?.planType).toBe('plus')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://chatgpt.com/backend-api/wham/usage')
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://chatgpt.com/backend-api/codex/responses/compact'
    )
    expect(fetchImpl.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Originator: 'Codex Desktop',
          'Chatgpt-Account-Id': 'workspace-a',
          'OpenAI-Beta': 'codex-1',
          'Oai-Language': 'zh-CN',
          'Sec-Fetch-Mode': 'no-cors'
        })
      })
    )
    expect(fetchImpl.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Conversation_ID: expect.any(String),
          'OpenAI-Beta': 'responses=experimental'
        })
      })
    )
    expect(JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))).toEqual({
      model: 'gpt-5.4',
      instructions: 'You are a helpful coding assistant.',
      input: [
        { type: 'message', role: 'user', content: 'Respond with OK.' }
      ]
    })
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
      .mockResolvedValueOnce(jsonResponse(200, { plan_type: 'plus', rate_limit: {} }))
      .mockResolvedValueOnce(jsonResponse(200, { output: [] }))
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

  it('keeps a mobile OAuth client id when refreshing an imported mobile RT', async () => {
    const refreshedAccess = jwt({ sub: 'mobile-user', exp: 1_910_000_000 })
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(401, { error: { message: 'expired' } }))
      .mockResolvedValueOnce(jsonResponse(200, {
        access_token: refreshedAccess,
        refresh_token: 'mobile-refresh-rotated'
      }))
      .mockResolvedValueOnce(jsonResponse(200, { plan_type: 'plus', rate_limit: {} }))
      .mockResolvedValueOnce(jsonResponse(200, { output: [] }))
    const onCredentialUpdated = vi.fn()
    const tester = new CredentialTester({ fetchImpl, onCredentialUpdated })

    await expect(tester.test(credential({
      oauthClientId: MOBILE_OAUTH_CLIENT_ID,
      refreshToken: 'mobile-refresh-original'
    }))).resolves.toMatchObject({ status: 'valid', refreshed: true })

    const refreshBody = fetchImpl.mock.calls[1][1]?.body as URLSearchParams
    expect(refreshBody.get('client_id')).toBe(MOBILE_OAUTH_CLIENT_ID)
    expect(onCredentialUpdated).toHaveBeenCalledWith(expect.objectContaining({
      oauthClientId: MOBILE_OAUTH_CLIENT_ID,
      refreshToken: 'mobile-refresh-rotated'
    }))
  })

  it('marks a reused refresh token as invalid instead of an incompatible endpoint', async () => {
    const tester = new CredentialTester({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(401, { error: { message: 'expired' } }))
        .mockResolvedValueOnce(
          jsonResponse(400, {
            error: 'invalid_grant',
            code: 'refresh_token_reused',
            error_description: 'Refresh token has already been used'
          })
        )
    })

    await expect(tester.test(credential())).resolves.toMatchObject({
      status: 'invalid',
      stage: 'refresh',
      httpStatus: 400
    })
  })

  it('distinguishes exhausted quota and missing permission', async () => {
    const quotaTester = new CredentialTester({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(200, { plan_type: 'k12', rate_limit: {} }))
        .mockResolvedValueOnce(
          jsonResponse(429, {
            error: { type: 'usage_limit_reached', message: 'usage limit reached' }
          })
        )
    })
    const permissionTester = new CredentialTester({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(200, { plan_type: 'k12', rate_limit: {} }))
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
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(200, { plan_type: 'k12', rate_limit: {} }))
        .mockResolvedValueOnce(textResponse(429, 'usage limit reached; retry later'))
    })

    await expect(tester.test(credential())).resolves.toMatchObject({
      status: 'quota_exhausted',
      detail: 'usage limit reached; retry later'
    })
  })

  it('does not treat a transient 429 as exhausted quota', async () => {
    const tester = new CredentialTester({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(200, { plan_type: 'k12', rate_limit: {} }))
        .mockResolvedValueOnce(
          jsonResponse(429, { error: { type: 'rate_limit_error', message: 'retry later' } })
        )
    })

    await expect(tester.test(credential())).resolves.toMatchObject({
      status: 'network_error',
      httpStatus: 429,
      stage: 'deep-test'
    })
  })

  it('reports model capacity 429 separately from account rate limits', async () => {
    const tester = new CredentialTester({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(200, { plan_type: 'plus', rate_limit: {} }))
        .mockResolvedValueOnce(
          jsonResponse(429, { error: { message: 'The selected model is currently experiencing high demand' } })
        )
    })

    await expect(tester.test(credential())).resolves.toMatchObject({
      status: 'model_unavailable',
      httpStatus: 429
    })
  })

  it('distinguishes five-hour exhaustion from weekly exhaustion using window duration', async () => {
    const fiveHourFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(200, {
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 100, limit_window_seconds: 18_000 },
            secondary_window: { used_percent: 20, limit_window_seconds: 604_800 }
          }
        }))
    const fiveHourTester = new CredentialTester({ fetchImpl: fiveHourFetch })
    const weeklyFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(200, {
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: 20, limit_window_seconds: 18_000 },
            secondary_window: { used_percent: 100, limit_window_seconds: 604_800 }
          }
        }))
    const weeklyTester = new CredentialTester({ fetchImpl: weeklyFetch })

    await expect(fiveHourTester.test(credential())).resolves.toMatchObject({
      status: 'quota_exhausted_5h',
      detail: '5 小时额度已耗尽'
    })
    await expect(weeklyTester.test(credential())).resolves.toMatchObject({
      status: 'quota_exhausted_weekly',
      detail: '周额度已耗尽'
    })
    expect(fiveHourFetch).toHaveBeenCalledTimes(1)
    expect(weeklyFetch).toHaveBeenCalledTimes(1)
  })

  it('does not invalidate a usage-authenticated Team account when compact rejects the request format', async () => {
    const tester = new CredentialTester({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(200, { plan_type: 'k12', rate_limit: {} }))
        .mockResolvedValueOnce(jsonResponse(401, {
          error: { message: 'Could not parse your authentication token. Please try signing in again.' }
        }))
    })

    await expect(tester.test(credential({ refreshToken: null, canRefresh: false }))).resolves.toMatchObject({
      status: 'endpoint_incompatible',
      stage: 'deep-test',
      httpStatus: 401,
      usage: expect.objectContaining({ planType: 'k12' })
    })
  })

  it('keeps a compact-verified account valid when only the quota endpoint is incompatible', async () => {
    const tester = new CredentialTester({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(404, { error: { message: 'route changed' } }))
        .mockResolvedValueOnce(jsonResponse(200, { output: [] }))
    })

    await expect(tester.test(credential())).resolves.toMatchObject({
      status: 'valid',
      stage: 'deep-test',
      usage: null,
      detail: expect.stringContaining('额度接口 HTTP 404')
    })
  })

  it('keeps a compact-verified account valid when the usage endpoint alone returns 402', async () => {
    const tester = new CredentialTester({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse(402, { error: { code: 'payment_required', message: 'usage unavailable' } })
        )
        .mockResolvedValueOnce(jsonResponse(200, { output: [] }))
    })

    await expect(tester.test(credential())).resolves.toMatchObject({
      status: 'valid',
      stage: 'deep-test',
      usage: null,
      detail: expect.stringContaining('额度查询返回 HTTP 402')
    })
  })

  it('classifies payment-required responses as exhausted quota', async () => {
    const tester = new CredentialTester({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(200, { plan_type: 'k12', rate_limit: {} }))
        .mockResolvedValueOnce(
          jsonResponse(402, { error: { code: 'payment_required', message: 'insufficient credits' } })
        )
    })

    await expect(tester.test(credential())).resolves.toMatchObject({
      status: 'quota_exhausted',
      httpStatus: 402
    })
  })

  it('reports a deactivated Team/K12 workspace separately from exhausted quota', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(402, { detail: { code: 'deactivated_workspace' } }))
    const tester = new CredentialTester({ fetchImpl })

    await expect(tester.test(credential({ planType: 'k12' }))).resolves.toMatchObject({
      status: 'workspace_deactivated',
      detail: 'Team/K12 工作区已停用',
      httpStatus: 402,
      stage: 'usage'
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('reports model errors separately from credential failures', async () => {
    const tester = new CredentialTester({
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(200, { plan_type: 'k12', rate_limit: {} }))
        .mockResolvedValueOnce(
          jsonResponse(400, { error: { code: 'model_not_found', message: 'model unavailable' } })
        )
    })

    await expect(tester.test(credential())).resolves.toMatchObject({
      status: 'model_unavailable'
    })
  })

  it('validates and hydrates personal access tokens through the official whoami endpoint', async () => {
    const onCredentialUpdated = vi.fn()
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, {
        email: 'team@example.com',
        chatgpt_user_id: 'user-team',
        chatgpt_account_id: 'workspace-team',
        chatgpt_plan_type: 'team',
        chatgpt_account_is_fedramp: false
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        plan_type: 'team',
        rate_limit: {
          primary_window: { used_percent: 20, limit_window_seconds: 18_000 },
          secondary_window: { used_percent: 40, limit_window_seconds: 604_800 }
        }
      }))
      .mockResolvedValueOnce(jsonResponse(200, { output: [] }))
    const tester = new CredentialTester({ fetchImpl, onCredentialUpdated })

    await expect(tester.test(credential({
      email: null,
      accountId: null,
      subject: null,
      accessToken: 'at-personal-token',
      authKind: 'personal_access_token',
      refreshToken: null,
      idToken: null,
      canRefresh: false,
      accessExpiresAt: '2020-01-01T00:00:00Z',
      idExpiresAt: null
    }))).resolves.toMatchObject({
      status: 'valid',
      usage: expect.objectContaining({ planType: 'team' })
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(fetchImpl.mock.calls[0][0]).toContain('/v1/user-auth-credential/whoami')
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
      Originator: 'codex_cli_rs',
      'User-Agent': expect.stringContaining('codex_cli_rs/0.144.1')
    })
    expect(fetchImpl.mock.calls[1][1]?.headers).toMatchObject({
      Authorization: 'Bearer at-personal-token',
      'Chatgpt-Account-Id': 'workspace-team'
    })
    expect(onCredentialUpdated).toHaveBeenCalledWith(expect.objectContaining({
      email: 'team@example.com',
      accountId: 'workspace-team',
      subject: 'user-team',
      planType: 'team',
      authKind: 'personal_access_token',
      isFedRamp: false
    }))
  })

  it('queries the Sub2API reset-credit endpoint and merges its fresher count', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, {
        plan_type: 'plus',
        rate_limit: {},
        rate_limit_reset_credits: { available_count: 1 }
      }))
      .mockResolvedValueOnce(jsonResponse(200, {
        available_count: 4,
        credits: []
      }))
      .mockResolvedValueOnce(jsonResponse(200, { output: [] }))
    const tester = new CredentialTester({ fetchImpl, queryResetCredits: true })

    await expect(tester.test(credential({ isFedRamp: true }))).resolves.toMatchObject({
      status: 'valid',
      usage: expect.objectContaining({ resetCreditsAvailable: 4 })
    })
    expect(fetchImpl.mock.calls[1][0]).toBe(
      'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
    )
    expect(fetchImpl.mock.calls[1][1]?.headers).toMatchObject({
      Originator: 'Codex Desktop',
      'X-OpenAI-FedRAMP': 'true'
    })
  })

  it('marks a rejected personal access token invalid without querying usage', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(401, { error: { message: 'invalid token' } }))
    const tester = new CredentialTester({ fetchImpl })

    await expect(tester.test(credential({
      accessToken: 'at-invalid',
      authKind: 'personal_access_token',
      refreshToken: null,
      idToken: null,
      canRefresh: false
    }))).resolves.toMatchObject({ status: 'invalid', httpStatus: 401, stage: 'local' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
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
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(200, { plan_type: 'k12', rate_limit: {} }))
        .mockRejectedValueOnce(new Error('socket closed bearer-secret'))
    })

    const result = await tester.test(credential({ accessToken: 'bearer-secret' }))

    expect(result.status).toBe('network_error')
    expect(result.detail).not.toContain('bearer-secret')
  })
})
