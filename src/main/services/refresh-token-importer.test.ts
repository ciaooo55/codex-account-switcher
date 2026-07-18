import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_OAUTH_CLIENT_ID,
  extractOpenAIRefreshTokens,
  MOBILE_OAUTH_CLIENT_ID,
  OpenAIRefreshTokenImporter
} from './refresh-token-importer'

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

function successResponse(): Response {
  const accessToken = jwt({
    sub: 'user-team',
    exp: 1_900_000_000,
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'workspace-team',
      chatgpt_user_id: 'user-team',
      chatgpt_plan_type: 'team'
    },
    'https://api.openai.com/profile': { email: 'team@example.com' }
  })
  const idToken = jwt({ sub: 'user-team', email: 'team@example.com', exp: 1_900_000_000 })
  return new Response(JSON.stringify({
    access_token: accessToken,
    refresh_token: 'rt.1.rotated-refresh-token-value',
    id_token: idToken,
    expires_in: 3600
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('OpenAIRefreshTokenImporter', () => {
  it('extracts labelled, escaped and duplicate RT values without retaining markdown artifacts', () => {
    expect(extractOpenAIRefreshTokens([
      'plus  rt.1.ABCDEF_1234567890',
      'go rt.1.ABCDEF\\_1234567890',
      'rt.1.ABC*DEF_1234567890'
    ].join('\n'))).toEqual([
      'rt.1.ABCDEF_1234567890'
    ])
  })

  it('repairs typographic dashes and zero-width characters introduced while copying RT values', () => {
    expect(extractOpenAIRefreshTokens([
      'plus rt.1.ABCDEF\u20131234\u200B567890',
      'plus rt.1.ABCDEF\u22121234567890',
      'plus rt.1.ABCDEF-1234567890'
    ].join('\n'))).toEqual([
      'rt.1.ABCDEF-1234567890'
    ])
  })

  it('exchanges a Codex CLI RT and stores rotated tokens, identity and client id', async () => {
    const fetchImpl = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(async () => successResponse())
    const importer = new OpenAIRefreshTokenImporter({
      fetchImpl,
      now: () => new Date('2026-07-16T00:00:00Z')
    })

    const result = await importer.resolve('rt.1.original-refresh-token-value', 'codex')

    expect(result.errors).toEqual([])
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0]).toMatchObject({
      email: 'team@example.com',
      accountId: 'workspace-team',
      subject: 'user-team',
      planType: 'team',
      refreshToken: 'rt.1.rotated-refresh-token-value',
      oauthClientId: CODEX_OAUTH_CLIENT_ID,
      canRefresh: true,
      lastRefresh: '2026-07-16T00:00:00.000Z'
    })
    const request = fetchImpl.mock.calls[0]
    expect(String(request[0])).toBe('https://auth.openai.com/oauth/token')
    const body = request[1]?.body as URLSearchParams
    expect(body.get('client_id')).toBe(CODEX_OAUTH_CLIENT_ID)
    expect(body.get('scope')).toBe('openid profile email')
  })

  it('auto-detects a mobile RT by falling back to the mobile client id', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      }))
      .mockImplementationOnce(async () => successResponse())
    const importer = new OpenAIRefreshTokenImporter({ fetchImpl })

    const result = await importer.resolve('rt.1.mobile-refresh-token-value', 'auto')

    expect(result.credentials[0].oauthClientId).toBe(MOBILE_OAUTH_CLIENT_ID)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const secondBody = fetchImpl.mock.calls[1][1]?.body as URLSearchParams
    expect(secondBody.get('client_id')).toBe(MOBILE_OAUTH_CLIENT_ID)
  })

  it('reports both client failures and stops retrying a rejected OAuth client', async () => {
    const invalidRefresh = () => new Response(JSON.stringify({
      error: { code: 'invalid_refresh_token', message: 'Invalid refresh token.' }
    }), { status: 401, headers: { 'Content-Type': 'application/json' } })
    const fetchImpl = vi.fn()
      .mockImplementationOnce(async () => invalidRefresh())
      .mockImplementationOnce(async () => new Response(JSON.stringify({
        error: { code: 'invalid_client', message: 'Invalid client specified.' }
      }), { status: 401, headers: { 'Content-Type': 'application/json' } }))
      .mockImplementationOnce(async () => invalidRefresh())
    const importer = new OpenAIRefreshTokenImporter({ fetchImpl })

    const result = await importer.resolve([
      'rt.1.first-invalid-refresh-token-value',
      'rt.1.second-invalid-refresh-token-value'
    ].join('\n'), 'auto')

    expect(result.total).toBe(2)
    expect(result.credentials).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(result.errors[0]).toContain('Codex RT：invalid_refresh_token')
    expect(result.errors[0]).toContain('Mobile RT：invalid_client')
    expect(result.errors[1]).toContain('Codex RT：invalid_refresh_token')
    expect(result.errors[1]).toContain('Mobile RT：invalid_client')
  })

  it('reports partial failures without exposing a submitted RT', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: 'invalid_grant',
      error_description: 'refresh token rt.1.failed-refresh-token-value is invalid'
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }))
    const importer = new OpenAIRefreshTokenImporter({ fetchImpl })

    const result = await importer.resolve('rt.1.failed-refresh-token-value', 'codex')

    expect(result.credentials).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(JSON.stringify(result.errors)).not.toContain('failed-refresh-token-value')
    expect(result.errors[0]).toContain('[redacted]')
  })

  it('does not retry a second OAuth client after a network failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('offline')
    })
    const importer = new OpenAIRefreshTokenImporter({ fetchImpl })

    const result = await importer.resolve('rt.1.offline-refresh-token-value', 'auto')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result.credentials).toEqual([])
    expect(result.errors[0]).toContain('无法连接')
  })
})
