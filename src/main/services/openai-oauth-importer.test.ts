import { describe, expect, it, vi } from 'vitest'
import { CODEX_OAUTH_CLIENT_ID } from './refresh-token-importer'
import { OpenAIOAuthImporter } from './openai-oauth-importer'

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

describe('OpenAIOAuthImporter', () => {
  it('generates the same PKCE authorization parameters as Sub2API', () => {
    const importer = new OpenAIOAuthImporter({
      now: () => new Date('2026-07-16T00:00:00Z')
    })

    const session = importer.start()
    const url = new URL(session.authUrl)

    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe(CODEX_OAUTH_CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback')
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('id_token_add_organizations')).toBe('true')
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true')
    expect(session.expiresAt).toBe('2026-07-16T00:30:00.000Z')
  })

  it('exchanges a pasted callback URL without exposing tokens to the caller', async () => {
    const accessToken = jwt({
      sub: 'oauth-user',
      'https://api.openai.com/profile': { email: 'oauth@example.com' },
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'oauth-workspace',
        chatgpt_plan_type: 'plus'
      }
    })
    const fetchImpl = vi.fn<
      (input: string | URL | Request, init?: RequestInit) => Promise<Response>
    >(async () => new Response(JSON.stringify({
      access_token: accessToken,
      refresh_token: 'rotated-refresh-token',
      id_token: jwt({ sub: 'oauth-user', email: 'oauth@example.com' }),
      expires_in: 3600
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const importer = new OpenAIOAuthImporter({ fetchImpl })
    const session = importer.start()
    const state = new URL(session.authUrl).searchParams.get('state')!

    const result = await importer.complete(
      session.sessionId,
      `http://localhost:1455/auth/callback?code=authorization-code&state=${state}`
    )

    expect(result.errors).toEqual([])
    expect(result.credentials[0]).toMatchObject({
      email: 'oauth@example.com',
      accountId: 'oauth-workspace',
      planType: 'plus',
      refreshToken: 'rotated-refresh-token',
      oauthClientId: CODEX_OAUTH_CLIENT_ID
    })
    const body = fetchImpl.mock.calls[0][1]?.body as URLSearchParams
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('client_id')).toBe(CODEX_OAUTH_CLIENT_ID)
    expect(body.get('code')).toBe('authorization-code')
    expect(body.get('code_verifier')).toHaveLength(128)
  })

  it('rejects a mismatched callback state before sending a token request', async () => {
    const fetchImpl = vi.fn()
    const importer = new OpenAIOAuthImporter({ fetchImpl })
    const session = importer.start()

    const result = await importer.complete(
      session.sessionId,
      'http://localhost:1455/auth/callback?code=code&state=wrong-state'
    )

    expect(result.credentials).toEqual([])
    expect(result.errors[0]).toContain('state')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
