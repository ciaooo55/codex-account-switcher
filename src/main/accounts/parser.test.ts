import { describe, expect, it } from 'vitest'
import { dedupeCredentials, parseCredentialText } from './parser'

function jwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${encoded}.signature`
}

describe('parseCredentialText', () => {
  it('normalizes nested Codex auth and extracts email and organization id from JWT claims', () => {
    const idToken = jwt({
      sub: 'auth0|user-a',
      email: 'person@example.com',
      exp: 1_800_000_000,
      'https://api.openai.com/auth': {
        organizations: [{ id: 'org-default', is_default: true }]
      }
    })
    const accessToken = jwt({
      sub: 'auth0|user-a',
      exp: 1_800_003_600,
      'https://api.openai.com/auth': { poid: 'org-poid' }
    })
    const result = parseCredentialText(
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: idToken,
          access_token: accessToken,
          refresh_token: 'refresh-a',
          account_id: null
        },
        last_refresh: '2026-07-12T11:48:17Z'
      }),
      { sourcePath: 'nested.json', format: 'json' }
    )

    expect(result.errors).toEqual([])
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0]).toMatchObject({
      email: 'person@example.com',
      accountId: 'org-poid',
      subject: 'auth0|user-a',
      refreshToken: 'refresh-a',
      lastRefresh: '2026-07-12T11:48:17Z',
      sourcePath: 'nested.json'
    })
  })

  it('prefers access JWT account claims over nested token account fallbacks', () => {
    const accessToken = jwt({
      sub: 'user-priority',
      'https://api.openai.com/auth': { chatgpt_account_id: 'access-workspace' }
    })
    const result = parseCredentialText(
      JSON.stringify({
        tokens: {
          access_token: accessToken,
          account_id: 'nested-workspace'
        }
      }),
      { sourcePath: 'priority.json', format: 'json' }
    )

    expect(result.credentials[0].accountId).toBe('access-workspace')
  })

  it('normalizes flat CLI Proxy credentials and prefers profile email', () => {
    const accessToken = jwt({
      sub: 'user-b',
      exp: 1_800_000_000,
      'https://api.openai.com/profile': { email: 'profile@example.com' },
      'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-b' }
    })
    const result = parseCredentialText(
      JSON.stringify({
        access_token: accessToken,
        account_id: 'root-account',
        email: 'fallback@example.com',
        plan_type: 'plus',
        last_refresh: '2026-07-14T12:44:48Z',
        type: 'codex'
      }),
      { sourcePath: 'flat.json', format: 'json' }
    )

    expect(result.credentials[0]).toMatchObject({
      email: 'profile@example.com',
      accountId: 'root-account',
      planType: 'plus',
      refreshToken: null,
      canRefresh: false,
      sourceDialect: 'cpa'
    })
  })

  it('parses a native Sub2API file containing many accounts with outer metadata', () => {
    const payload = {
      type: 'sub2api-data',
      version: 1,
      exported_at: '2026-07-15T01:00:00Z',
      proxies: [],
      accounts: [
        {
          name: 'first@example.com',
          platform: 'openai',
          type: 'oauth',
          credentials: {
            access_token: jwt({ sub: 'sub-user-1', exp: 1_900_000_000 }),
            refresh_token: 'refresh-sub-1',
            chatgpt_account_id: 'sub-workspace-1',
            chatgpt_user_id: 'sub-user-1',
            plan_type: 'plus'
          },
          extra: {
            email: 'first@example.com',
            last_refresh: '2026-07-14T08:00:00Z'
          },
          expires_at: 1_900_000_000
        },
        {
          name: 'second@example.com',
          platform: 'openai',
          type: 'oauth',
          credentials: {
            access_token: jwt({ sub: 'sub-user-2' }),
            email: 'second@example.com',
            organization_id: 'sub-workspace-2'
          },
          extra: { last_refresh: '2026-07-14T09:00:00Z' }
        }
      ]
    }

    const result = parseCredentialText(JSON.stringify(payload), {
      sourcePath: 'sub2api-account.json',
      format: 'json'
    })

    expect(result.errors).toEqual([])
    expect(result.credentials).toHaveLength(2)
    expect(result.credentials[0]).toMatchObject({
      email: 'first@example.com',
      accountId: 'sub-workspace-1',
      subject: 'sub-user-1',
      planType: 'plus',
      lastRefresh: '2026-07-14T08:00:00Z',
      accessExpiresAt: '2030-03-17T17:46:40.000Z',
      sourceDialect: 'sub2api'
    })
    expect(result.credentials[1]).toMatchObject({
      email: 'second@example.com',
      accountId: 'sub-workspace-2',
      lastRefresh: '2026-07-14T09:00:00Z',
      sourceDialect: 'sub2api'
    })
  })

  it('parses legacy and API-wrapped Sub2API bundles', () => {
    const result = parseCredentialText(
      JSON.stringify({
        code: 0,
        data: {
          type: 'sub2api-bundle',
          version: 1,
          proxies: [],
          accounts: [
            {
              name: 'wrapped@example.com',
              platform: 'openai',
              type: 'oauth',
              credentials: {
                access_token: jwt({ sub: 'wrapped-user' }),
                chatgpt_account_id: 'wrapped-workspace'
              },
              extra: { email: 'wrapped@example.com' }
            }
          ]
        }
      }),
      { sourcePath: 'wrapped.json', format: 'json' }
    )

    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0]).toMatchObject({
      email: 'wrapped@example.com',
      accountId: 'wrapped-workspace',
      sourceDialect: 'sub2api'
    })
  })

  it('does not mistake a Sub2API display name for an email address', () => {
    const result = parseCredentialText(
      JSON.stringify({
        type: 'sub2api-data',
        version: 1,
        proxies: [],
        accounts: [
          {
            name: 'My Codex Account',
            platform: 'openai',
            type: 'oauth',
            credentials: { access_token: jwt({ sub: 'named-user' }) }
          }
        ]
      }),
      { sourcePath: 'bundle.json', format: 'json' }
    )

    expect(result.credentials[0].email).toBeNull()
  })

  it('cleans fenced and noisy pasted content before extracting credentials', () => {
    const result = parseCredentialText(
      `下面是账号，请导入：\n\`\`\`json\n${JSON.stringify({
        access_token: jwt({ sub: 'paste-user' }),
        email: 'paste@example.com',
        account_id: 'paste-workspace',
        type: 'codex'
      })}\n\`\`\`\n其余文字忽略。`,
      { sourcePath: 'pasted-20260715.json', format: 'paste' }
    )

    expect(result.errors).toEqual([])
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0]).toMatchObject({
      email: 'paste@example.com',
      accountId: 'paste-workspace',
      sourceDialect: 'cpa'
    })
  })

  it('parses static JavaScript exports without executing source code', () => {
    const text = `
      globalThis.__mustNotRun = true;
      export default [{
        access_token: ${JSON.stringify(jwt({ sub: 'user-js', exp: 1_800_000_000 }))},
        email: 'js@example.com',
        account_id: 'workspace-js'
      }];
    `
    const result = parseCredentialText(text, { sourcePath: 'accounts.js', format: 'js' })

    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0].email).toBe('js@example.com')
    expect((globalThis as Record<string, unknown>).__mustNotRun).toBeUndefined()
  })

  it('parses JSONL and key-value text blocks', () => {
    const jsonl = [
      JSON.stringify({ access_token: jwt({ sub: 'one' }), email: 'one@example.com' }),
      JSON.stringify({ access_token: jwt({ sub: 'two' }), email: 'two@example.com' })
    ].join('\n')
    const jsonlResult = parseCredentialText(jsonl, { sourcePath: 'accounts.txt', format: 'txt' })

    const keyValueResult = parseCredentialText(
      `email=three@example.com\naccess_token=${jwt({ sub: 'three' })}\naccount_id=workspace-three`,
      { sourcePath: 'single.txt', format: 'txt' }
    )

    expect(jsonlResult.credentials.map((item) => item.email)).toEqual([
      'one@example.com',
      'two@example.com'
    ])
    expect(keyValueResult.credentials[0]).toMatchObject({
      email: 'three@example.com',
      accountId: 'workspace-three'
    })
  })

  it('returns a parse error instead of accepting executable or malformed input', () => {
    const result = parseCredentialText('while (true) {}', {
      sourcePath: 'bad.js',
      format: 'js'
    })

    expect(result.credentials).toEqual([])
    expect(result.errors[0]).toContain('bad.js')
  })

  it('returns a source error instead of throwing for excessively deep JSON', () => {
    const credential = JSON.stringify({
      access_token: jwt({ sub: 'deep-json' }),
      account_id: 'workspace-deep-json'
    })
    const text = `${'{"nested":'.repeat(200)}${credential}${'}'.repeat(200)}`

    expect(() =>
      parseCredentialText(text, { sourcePath: 'too-deep.json', format: 'json' })
    ).not.toThrow()
    const result = parseCredentialText(text, {
      sourcePath: 'too-deep.json',
      format: 'json'
    })

    expect(result.credentials).toEqual([])
    expect(result.errors[0]).toContain('too-deep.json')
  })

  it('rejects excessively deep static JavaScript literals', () => {
    const credential = JSON.stringify({
      access_token: jwt({ sub: 'deep-js' }),
      account_id: 'workspace-deep-js'
    })
    const text = `export default ${'['.repeat(200)}${credential}${']'.repeat(200)};`
    const result = parseCredentialText(text, {
      sourcePath: 'too-deep.js',
      format: 'js'
    })

    expect(result.credentials).toEqual([])
    expect(result.errors[0]).toContain('too-deep.js')
  })

  it('rejects static JavaScript literals that exceed the AST node limit', () => {
    const credential = JSON.stringify({
      access_token: jwt({ sub: 'large-js' }),
      account_id: 'workspace-large-js'
    })
    const text = `export default [${`${'0,'.repeat(12_000)}${credential}`}];`
    const result = parseCredentialText(text, {
      sourcePath: 'too-large.js',
      format: 'js'
    })

    expect(result.credentials).toEqual([])
    expect(result.errors[0]).toContain('too-large.js')
  })
})

describe('dedupeCredentials', () => {
  it('does not collapse different users that share a workspace id', () => {
    const first = parseCredentialText(
      JSON.stringify({
        access_token: jwt({ sub: 'user-1' }),
        email: 'one@example.com',
        account_id: 'shared-workspace'
      }),
      { sourcePath: 'one.json', format: 'json' }
    ).credentials[0]
    const second = parseCredentialText(
      JSON.stringify({
        access_token: jwt({ sub: 'user-2' }),
        email: 'two@example.com',
        account_id: 'shared-workspace'
      }),
      { sourcePath: 'two.json', format: 'json' }
    ).credentials[0]

    expect(dedupeCredentials([first, second])).toHaveLength(2)
    expect(dedupeCredentials([first, { ...first, sourcePath: 'copy.json' }])).toHaveLength(1)
  })

  it('uses subject and account id as the stable identity when email changes', () => {
    const first = parseCredentialText(
      JSON.stringify({
        access_token: jwt({ sub: 'stable-user' }),
        email: 'old@example.com',
        account_id: 'stable-workspace'
      }),
      { sourcePath: 'old.json', format: 'json' }
    ).credentials[0]
    const second = parseCredentialText(
      JSON.stringify({
        access_token: jwt({ sub: 'stable-user' }),
        email: 'new@example.com',
        account_id: 'stable-workspace'
      }),
      { sourcePath: 'new.json', format: 'json' }
    ).credentials[0]

    expect(first.id).toBe(second.id)
    expect(dedupeCredentials([first, second])).toHaveLength(1)
  })

  it('deduplicates the same identity imported from CPA and Sub2API', () => {
    const accessToken = jwt({ sub: 'cross-user' })
    const cpa = parseCredentialText(
      JSON.stringify({
        type: 'codex',
        access_token: accessToken,
        email: 'cross@example.com',
        account_id: 'cross-workspace'
      }),
      { sourcePath: 'cpa.json', format: 'json' }
    ).credentials[0]
    const sub2api = parseCredentialText(
      JSON.stringify({
        type: 'sub2api-data',
        version: 1,
        proxies: [],
        accounts: [
          {
            name: 'cross@example.com',
            platform: 'openai',
            type: 'oauth',
            credentials: {
              access_token: accessToken,
              email: 'cross@example.com',
              chatgpt_account_id: 'cross-workspace'
            }
          }
        ]
      }),
      { sourcePath: 'sub2api.json', format: 'json' }
    ).credentials[0]

    const deduped = dedupeCredentials([cpa, sub2api])
    expect(deduped).toHaveLength(1)
    expect(deduped[0].sourceDialect).toBe('sub2api')
  })
})
