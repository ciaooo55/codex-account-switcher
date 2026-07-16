import { describe, expect, it, vi } from 'vitest'
import type { GrokCredential } from '../../shared/types'
import { GrokCredentialTester } from './grok-detector'

function token(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

function credential(overrides: Partial<GrokCredential> = {}): GrokCredential {
  return {
    id: 'a'.repeat(64), email: 'grok@example.com', subject: 'grok-user', teamId: 'team-a',
    accessToken: token({ iss: 'https://auth.x.ai', sub: 'grok-user', exp: 1_900_000_000 }),
    refreshToken: 'refresh-old', idToken: null, tokenType: 'Bearer',
    clientId: 'client-id', baseUrl: 'https://api.x.ai/v1',
    tokenEndpoint: 'https://auth.x.ai/oauth2/token', scope: null, planType: null,
    lastRefresh: null, expiresAt: '2030-03-17T17:46:40Z', sourcePath: 'grok.json',
    sourceFormat: 'json', sourceDialect: 'cpa', billingSnapshot: null, usageSnapshot: null,
    ...overrides
  }
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('GrokCredentialTester', () => {
  it('reads weekly and monthly billing and verifies a real Responses request', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, { config: { currentPeriod: { type: 'weekly', end: '2026-07-23T00:00:00Z' }, creditUsagePercent: 25 } }))
      .mockResolvedValueOnce(response(200, { config: { monthlyLimit: { val: 15000 }, used: { val: 3000 }, billingPeriodEnd: '2026-08-01T00:00:00Z' } }))
      .mockResolvedValueOnce(response(200, { id: 'resp-ok' }))
    const tester = new GrokCredentialTester({ timeoutMs: 5_000, fetch: request, cliBaseUrl: 'https://grok.test/v1' })

    const result = await tester.test(credential())

    expect(result.status).toBe('valid')
    expect(result.usage?.planType).toBe('SuperGrok')
    expect(result.usage?.windows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'weekly', remainingPercent: 75 }),
      expect.objectContaining({ id: 'monthly', remainingPercent: 80 })
    ]))
    expect(request).toHaveBeenLastCalledWith('https://grok.test/v1/responses', expect.objectContaining({ method: 'POST' }))
    const probeInit = request.mock.calls[2][1]
    const headers = probeInit?.headers as Record<string, string>
    expect(headers['X-XAI-Token-Auth']).toBe('xai-grok-cli')
    expect(headers.Accept).toBe('text/event-stream')
    expect(JSON.parse(String(probeInit?.body))).toMatchObject({
      model: 'grok-4.5',
      stream: true,
      store: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply OK.' }] }],
      tools: [{ type: 'x_search' }]
    })
  })

  it('refreshes expired credentials and persists rotated tokens before testing', async () => {
    const updated = vi.fn()
    const freshAccess = token({ iss: 'https://auth.x.ai', sub: 'grok-user', exp: 1_950_000_000 })
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, { access_token: freshAccess, refresh_token: 'refresh-new', expires_in: 21600 }))
      .mockResolvedValueOnce(response(200, { config: { creditUsagePercent: 10 } }))
      .mockResolvedValueOnce(response(200, { config: { monthlyLimit: 15000, used: 0 } }))
      .mockResolvedValueOnce(response(200, { id: 'resp-ok' }))
    const tester = new GrokCredentialTester({ timeoutMs: 5_000, fetch: request, cliBaseUrl: 'https://grok.test/v1', onCredentialUpdated: updated })

    const result = await tester.test(credential({ expiresAt: '2020-01-01T00:00:00Z' }))

    expect(result).toMatchObject({ status: 'valid', refreshed: true })
    expect(updated).toHaveBeenCalledWith(expect.objectContaining({ accessToken: freshAccess, refreshToken: 'refresh-new' }))
    const refreshInit = request.mock.calls[0][1]
    expect(String(refreshInit?.body)).toContain('grant_type=refresh_token')
  })

  it('only marks confirmed authorization failures as invalid and network failures as unknown', async () => {
    const denied = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(401, {}))
      .mockResolvedValueOnce(response(401, {}))
      .mockResolvedValueOnce(response(400, { error: 'invalid_grant' }))
    const invalid = await new GrokCredentialTester({ timeoutMs: 5_000, fetch: denied, cliBaseUrl: 'https://grok.test/v1' }).test(credential())
    expect(invalid.status).toBe('invalid')

    const network = vi.fn<typeof fetch>().mockRejectedValue(new Error('socket timeout'))
    const unknown = await new GrokCredentialTester({ timeoutMs: 5_000, fetch: network, cliBaseUrl: 'https://grok.test/v1' }).test(credential())
    expect(unknown.status).toBe('unknown_error')
  })

  it('retries CPA-style transient 503 responses without invalidating the credential', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, { config: { creditUsagePercent: 20 } }))
      .mockResolvedValueOnce(response(200, { config: { monthlyLimit: 15000, used: 0 } }))
      .mockResolvedValueOnce(response(503, { error: { message: 'temporarily unavailable' } }))
      .mockResolvedValueOnce(response(200, { id: 'resp-after-retry' }))
    const tester = new GrokCredentialTester({ timeoutMs: 5_000, fetch: request, cliBaseUrl: 'https://grok.test/v1' })

    const tested = await tester.test(credential())

    expect(tested).toMatchObject({ status: 'valid', httpStatus: 200 })
    expect(request).toHaveBeenCalledTimes(4)
  })

  it('keeps repeated generic 503 responses as an upstream error with the HTTP status', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, { config: { creditUsagePercent: 20 } }))
      .mockResolvedValueOnce(response(200, { config: { monthlyLimit: 15000, used: 0 } }))
      .mockResolvedValueOnce(response(503, { error: { message: 'temporarily unavailable' } }))
      .mockResolvedValueOnce(response(503, { error: { message: 'temporarily unavailable' } }))
    const tester = new GrokCredentialTester({ timeoutMs: 5_000, fetch: request, cliBaseUrl: 'https://grok.test/v1' })

    const tested = await tester.test(credential())

    expect(tested).toMatchObject({ status: 'unknown_error', httpStatus: 503 })
    expect(tested.detail).toContain('凭据未判失效')
  })

  it('recognizes free-usage exhaustion from a streamed CPA error event', async () => {
    const streamed = new Response(
      'event: error\ndata: {"type":"error","status":429,"error":{"code":"subscription:free-usage-exhausted","message":"included free usage exhausted"}}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    )
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, { config: { creditUsagePercent: 20 } }))
      .mockResolvedValueOnce(response(200, { config: { monthlyLimit: 15000, used: 0 } }))
      .mockResolvedValueOnce(streamed)
    const tester = new GrokCredentialTester({ timeoutMs: 5_000, fetch: request, cliBaseUrl: 'https://grok.test/v1' })

    const tested = await tester.test(credential())

    expect(tested).toMatchObject({ status: 'quota_exhausted_weekly', httpStatus: 429 })
  })

  it('skips the probe when billing already reports exhausted included usage', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, { config: { creditUsagePercent: 100 } }))
      .mockResolvedValueOnce(response(200, { config: { monthlyLimit: { val: 15000 }, used: { val: 15000 } } }))
    const tester = new GrokCredentialTester({ timeoutMs: 5_000, fetch: request, cliBaseUrl: 'https://grok.test/v1' })

    const tested = await tester.test(credential())

    expect(tested.status).toBe('quota_exhausted_weekly')
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not send imported refresh tokens to an untrusted endpoint', async () => {
    const request = vi.fn<typeof fetch>()
    const tested = await new GrokCredentialTester({ timeoutMs: 5_000, fetch: request }).test(
      credential({ expiresAt: '2020-01-01T00:00:00Z', tokenEndpoint: 'https://evil.example/token' })
    )

    expect(tested.status).toBe('unknown_error')
    expect(request).not.toHaveBeenCalled()
  })
})
