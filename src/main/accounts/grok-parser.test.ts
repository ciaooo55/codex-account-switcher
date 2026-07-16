import { describe, expect, it } from 'vitest'
import { parseGrokCredentialText } from './grok-parser'

function token(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

describe('parseGrokCredentialText', () => {
  it('parses and deduplicates a Sub2API Grok bundle with nested credentials', () => {
    const access = token({ iss: 'https://auth.x.ai', sub: 'grok-user', team_id: 'team-a', exp: 1_900_000_000 })
    const id = token({ sub: 'grok-user', email: 'grok@example.com' })
    const text = JSON.stringify({
      exported_at: '2026-07-16T00:00:00Z',
      proxies: [],
      accounts: [
        {
          name: 'grok@example.com',
          platform: 'grok',
          type: 'oauth',
          credentials: {
            access_token: access,
            refresh_token: 'refresh-old',
            id_token: id,
            base_url: 'https://api.x.ai/v1',
            expires_at: '2030-03-17T17:46:40Z',
            sub: 'grok-user',
            team_id: 'team-a'
          },
          extra: { grok_billing_snapshot: { plan: 'SuperGrok', usage_percent: 25 } }
        },
        {
          platform: 'grok',
          type: 'oauth',
          credentials: {
            access_token: access,
            refresh_token: 'refresh-new',
            id_token: id,
            sub: 'grok-user',
            team_id: 'team-a',
            last_refresh: '2026-07-16T03:50:10Z'
          }
        }
      ]
    })

    const result = parseGrokCredentialText(text, { sourcePath: 'sub.json', format: 'json' })
    expect(result.errors).toEqual([])
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0]).toMatchObject({
      email: 'grok@example.com',
      subject: 'grok-user',
      teamId: 'team-a',
      refreshToken: 'refresh-new',
      sourceDialect: 'sub2api'
    })
    expect(result.credentials[0].billingSnapshot).toMatchObject({ plan: 'SuperGrok' })
  })

  it('parses flat CPA xAI credentials and ignores OpenAI credentials', () => {
    const grok = token({ iss: 'https://auth.x.ai', sub: 'xai-user', scope: 'grok-cli:access api:access' })
    const result = parseGrokCredentialText(JSON.stringify([
      { type: 'xai', access_token: grok, refresh_token: 'refresh', email: 'xai@example.com' },
      { type: 'codex', access_token: token({ iss: 'https://auth.openai.com', sub: 'openai-user' }) }
    ]), { sourcePath: 'mixed.json', format: 'json' })

    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0]).toMatchObject({ email: 'xai@example.com', subject: 'xai-user', sourceDialect: 'cpa' })
  })

  it('extracts static JavaScript exports without executing code', () => {
    const access = token({ iss: 'https://auth.x.ai', sub: 'js-user' })
    const result = parseGrokCredentialText(
      `export default [{ type: 'xai', access_token: '${access}', email: 'js@example.com' }];`,
      { sourcePath: 'accounts.js', format: 'js' }
    )
    expect(result.credentials[0]).toMatchObject({ email: 'js@example.com', subject: 'js-user' })
  })

  it('keeps one Grok credential per normalized email even when team ids differ', () => {
    const result = parseGrokCredentialText(JSON.stringify([
      { type: 'xai', access_token: token({ iss: 'https://auth.x.ai', sub: 'old', team_id: 'team-a' }), email: 'Same@Example.com' },
      { type: 'xai', access_token: token({ iss: 'https://auth.x.ai', sub: 'new', team_id: 'team-b' }), refresh_token: 'refresh-new', email: 'same@example.com' }
    ]), { sourcePath: 'duplicate-grok.json', format: 'json' })

    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0]).toMatchObject({ email: 'same@example.com', refreshToken: 'refresh-new', teamId: 'team-b' })
  })
})
