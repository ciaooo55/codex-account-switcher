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

  it('parses a trailing-comma Sub2API Team bundle and keeps workspace members distinct', () => {
    const workspace = 'shared-team-workspace'
    const account = (index: number) => {
      const email = `team-${index}@example.com`
      const userId = `user-team-${index}`
      return {
        name: `${email}--noRT`,
        platform: 'openai',
        type: 'oauth',
        credentials: {
          access_token: jwt({
            sub: `auth0|team-${index}`,
            exp: 1_900_000_000,
            'https://api.openai.com/profile': { email },
            'https://api.openai.com/auth': {
              chatgpt_account_id: workspace,
              chatgpt_user_id: userId,
              chatgpt_plan_type: 'k12'
            }
          }),
          id_token: jwt({
            email,
            exp: 1_900_000_000,
            'https://api.openai.com/auth': {
              chatgpt_account_id: workspace,
              chatgpt_user_id: userId,
              chatgpt_plan_type: 'k12'
            }
          }),
          chatgpt_account_id: workspace,
          chatgpt_user_id: userId,
          email,
          plan_type: 'k12'
        },
        extra: { no_rt: true }
      }
    }
    const text = `${JSON.stringify({
      exported_at: '2026-07-16T08:39:12.946Z',
      proxies: [],
      accounts: [account(1), account(2)]
    }, null, 2).replace(/\n  ]\n}/, '\n  ],\n}')}`
    const result = parseCredentialText(text, { sourcePath: 'team-bundle.txt', format: 'txt' })

    expect(result.errors).toEqual([])
    expect(result.credentials).toHaveLength(2)
    expect(new Set(result.credentials.map((item) => item.id))).toHaveLength(2)
    expect(result.credentials).toEqual(expect.arrayContaining([
      expect.objectContaining({
        email: 'team-1@example.com',
        accountId: workspace,
        subject: 'auth0|team-1',
        planType: 'k12',
        refreshToken: null,
        canRefresh: false,
        sourceDialect: 'sub2api'
      }),
      expect.objectContaining({ email: 'team-2@example.com', accountId: workspace })
    ]))
  })

  it('does not misclassify direct xAI credentials as Codex accounts', () => {
    const result = parseCredentialText(
      JSON.stringify({
        type: 'xai',
        base_url: 'https://api.x.ai/v1',
        access_token: jwt({
          iss: 'https://auth.x.ai',
          sub: 'xai-user',
          scope: 'openid offline_access grok-cli:access'
        }),
        email: 'grok@example.com'
      }),
      { sourcePath: 'grok.json', format: 'json' }
    )

    expect(result.credentials).toEqual([])
    expect(result.errors[0]).toContain('grok.json')
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

  it('supports current Sub2API token aliases and nested account identity fields', () => {
    const accessToken = jwt({
      sub: 'nested-user-claim',
      'https://api.openai.com/auth': { chatgpt_plan_type: 'team' }
    })
    const result = parseCredentialText(
      JSON.stringify({
        accounts: [
          {
            name: 'Nested OpenAI',
            platform: 'openai',
            type: 'oauth',
            credentials: {
              token: accessToken,
              chatgptAccountId: 'nested-workspace',
              user: { id: 'nested-user', email: 'nested@example.com' },
              account: { chatgptPlanType: 'team' }
            }
          }
        ]
      }),
      { sourcePath: 'sub2api-current.json', format: 'json' }
    )

    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0]).toMatchObject({
      accessToken,
      email: 'nested@example.com',
      accountId: 'nested-workspace',
      subject: 'nested-user-claim',
      planType: 'team',
      sourceDialect: 'sub2api'
    })
  })

  it('rejects non-OpenAI Sub2API accounts even when their type is oauth', () => {
    const result = parseCredentialText(
      JSON.stringify({
        accounts: [
          {
            platform: 'anthropic',
            type: 'oauth',
            credentials: { access_token: jwt({ sub: 'anthropic-user' }) }
          }
        ]
      }),
      { sourcePath: 'mixed-platforms.json', format: 'json' }
    )

    expect(result.credentials).toEqual([])
  })

  it('parses a Sub2API Team personal access token without treating it as an OAuth JWT', () => {
    const result = parseCredentialText(
      JSON.stringify({
        exported_at: '2026-07-16T13:32:05Z',
        accounts: [{
          name: 'team account',
          platform: 'openai',
          type: 'oauth',
          credentials: {
            email: 'team@example.com',
            auth_mode: 'personalAccessToken',
            openai_auth_mode: 'personal_access_token',
            plan_type: 'team',
            access_token: 'at-personal-token',
            chatgpt_user_id: 'user-team',
            chatgpt_account_id: 'workspace-team'
          }
        }]
      }),
      { sourcePath: 'sub-team.json', format: 'json' }
    )

    expect(result.errors).toEqual([])
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0]).toMatchObject({
      email: 'team@example.com',
      authKind: 'personal_access_token',
      accessToken: 'at-personal-token',
      accountId: 'workspace-team',
      subject: 'user-team',
      planType: 'team',
      canRefresh: false,
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

  it('repairs a token value that accidentally contains its JSON field label', () => {
    const accessToken = jwt({ sub: 'labelled-user', email: 'labelled@example.com' })
    const result = parseCredentialText(JSON.stringify({
      type: 'codex',
      email: 'labelled@example.com',
      access_token: `"access_token": "${accessToken}"`,
      account_id: 'labelled-workspace',
      plan_type: 'k12'
    }), { sourcePath: 'broken-cleaning.json', format: 'json' })

    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0]).toMatchObject({
      email: 'labelled@example.com',
      accessToken,
      accountId: 'labelled-workspace',
      planType: 'k12'
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

  it('cleans noisy TXT content and accepts UTF-8 BOM JSON files', () => {
    const noisy = parseCredentialText(
      `账号一：\n${JSON.stringify({
        access_token: jwt({ sub: 'noisy-txt' }),
        email: 'noisy@example.com'
      })}\n以上是账号。`,
      { sourcePath: 'noisy.txt', format: 'txt' }
    )
    const bom = parseCredentialText(
      `\uFEFF${JSON.stringify({
        access_token: jwt({ sub: 'bom-json' }),
        email: 'bom@example.com'
      })}`,
      { sourcePath: 'bom.json', format: 'json' }
    )

    expect(noisy.credentials.map((credential) => credential.email)).toEqual(['noisy@example.com'])
    expect(bom.credentials.map((credential) => credential.email)).toEqual(['bom@example.com'])
  })

  it('parses bare access tokens from text, paste and JSON arrays', () => {
    const first = jwt({ sub: 'bare-one' })
    const second = jwt({ sub: 'bare-two' })
    const text = parseCredentialText(`${first}\nBearer ${second}`, {
      sourcePath: 'tokens.txt',
      format: 'txt'
    })
    const pasted = parseCredentialText(`账号如下：\n${first}`, {
      sourcePath: 'pasted-credential.json',
      format: 'paste'
    })
    const array = parseCredentialText(JSON.stringify([first, second]), {
      sourcePath: 'tokens.json',
      format: 'json'
    })

    expect(text.credentials).toHaveLength(2)
    expect(text.credentials.every((item) => item.sourceDialect === 'sub2api')).toBe(true)
    expect(pasted.credentials).toHaveLength(1)
    expect(array.credentials).toHaveLength(2)
  })

  it('parses bare Sub2API personal access tokens and preserves an OAuth client id', () => {
    const personal = parseCredentialText('at-first-personal-token\nat-second-personal-token', {
      sourcePath: 'personal-tokens.txt',
      format: 'txt'
    })
    const oauth = parseCredentialText(JSON.stringify({
      access_token: jwt({ sub: 'mobile-user' }),
      refresh_token: 'mobile-refresh',
      client_id: 'mobile-client-id'
    }), { sourcePath: 'mobile.json', format: 'json' })

    expect(personal.credentials).toHaveLength(2)
    expect(personal.credentials.every((item) => item.authKind === 'personal_access_token')).toBe(true)
    expect(oauth.credentials[0]).toMatchObject({
      refreshToken: 'mobile-refresh',
      oauthClientId: 'mobile-client-id'
    })
  })

  it('extracts an email from a Markdown filename', () => {
    const result = parseCredentialText(
      `\`\`\`json\n${JSON.stringify({ access_token: jwt({ sub: 'md-name' }) })}\n\`\`\``,
      { sourcePath: 'person@example.com.md', format: 'md' }
    )

    expect(result.credentials[0].email).toBe('person@example.com')
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

  it('extracts one or many accounts from Markdown code blocks', () => {
    const result = parseCredentialText(
      `# Accounts\n\n\`\`\`json\n${JSON.stringify([
        {
          access_token: jwt({ sub: 'markdown-one' }),
          email: 'markdown-one@example.com'
        },
        {
          access_token: jwt({ sub: 'markdown-two' }),
          email: 'markdown-two@example.com'
        }
      ])}\n\`\`\``,
      { sourcePath: 'accounts.md', format: 'md' }
    )

    expect(result.credentials.map((credential) => credential.email)).toEqual([
      'markdown-one@example.com',
      'markdown-two@example.com'
    ])
    expect(result.credentials.every((credential) => credential.sourceFormat === 'md')).toBe(true)
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

  it('merges an incomplete identity after exactly one workspace is known', () => {
    const withoutWorkspace = parseCredentialText(
      JSON.stringify({
        access_token: jwt({ sub: 'enriched-user' }),
        email: 'enriched@example.com'
      }),
      { sourcePath: 'incomplete.json', format: 'json' }
    ).credentials[0]
    const withWorkspace = parseCredentialText(
      JSON.stringify({
        access_token: jwt({ sub: 'enriched-user' }),
        refresh_token: 'refresh-enriched',
        email: 'enriched@example.com',
        account_id: 'enriched-workspace'
      }),
      { sourcePath: 'complete.json', format: 'json' }
    ).credentials[0]

    const deduped = dedupeCredentials([withoutWorkspace, withWorkspace])

    expect(deduped).toHaveLength(1)
    expect(deduped[0]).toMatchObject({
      accountId: 'enriched-workspace',
      refreshToken: 'refresh-enriched',
      canRefresh: true
    })
    expect(deduped[0].id).toBe(withWorkspace.id)
  })

  it('keeps only one preferred credential per email across multiple workspaces', () => {
    const records = [null, 'workspace-a', 'workspace-b'].map((accountId, index) =>
      parseCredentialText(
        JSON.stringify({
          access_token: jwt({ sub: 'multi-workspace-user', nonce: index }),
          email: 'multi@example.com',
          account_id: accountId
        }),
        { sourcePath: `${index}.json`, format: 'json' }
      ).credentials[0]
    )

    expect(dedupeCredentials(records)).toHaveLength(1)
  })
})
