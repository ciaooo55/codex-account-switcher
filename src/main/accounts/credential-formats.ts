import type { NormalizedCredential } from '../../shared/types'

export type CodexAuthDocumentMode = 'oauth' | 'personal_access_token' | 'external'

export interface CodexAuthDocument {
  mode: CodexAuthDocumentMode
  value: Record<string, unknown>
}

export function serializeCpaCredential(
  credential: NormalizedCredential,
  priority?: number
): Record<string, string | number | boolean> {
  const personalAccessToken =
    credential.authKind === 'personal_access_token' || credential.accessToken.startsWith('at-')

  return {
    type: 'codex',
    ...(priority !== undefined ? { priority } : {}),
    ...(credential.email ? { email: credential.email } : {}),
    auth_mode: personalAccessToken ? 'personalAccessToken' : 'chatgpt',
    ...(personalAccessToken
      ? {
          openai_auth_mode: 'personal_access_token',
          personal_access_token: credential.accessToken
        }
      : {}),
    access_token: credential.accessToken,
    ...(credential.refreshToken ? { refresh_token: credential.refreshToken } : {}),
    ...(credential.oauthClientId ? { client_id: credential.oauthClientId } : {}),
    ...(credential.isFedRamp !== null && credential.isFedRamp !== undefined
      ? { chatgpt_account_is_fedramp: credential.isFedRamp }
      : {}),
    ...(credential.idToken ? { id_token: credential.idToken } : {}),
    ...(credential.accountId
      ? {
          account_id: credential.accountId,
          chatgpt_account_id: credential.accountId
        }
      : {}),
    ...(credential.subject
      ? {
          subject: credential.subject,
          chatgpt_user_id: credential.subject
        }
      : {}),
    ...(credential.planType
      ? {
          plan_type: credential.planType,
          chatgpt_plan_type: credential.planType
        }
      : {}),
    ...(credential.lastRefresh ? { last_refresh: credential.lastRefresh } : {}),
    ...(credential.accessExpiresAt ? { expired: credential.accessExpiresAt } : {})
  }
}

export function serializeCodexCredential(
  credential: NormalizedCredential,
  now = new Date()
): CodexAuthDocument {
  if (
    credential.authKind === 'personal_access_token' ||
    credential.accessToken.startsWith('at-')
  ) {
    return {
      mode: 'personal_access_token',
      value: {
        OPENAI_API_KEY: null,
        personal_access_token: credential.accessToken
      }
    }
  }

  const externallyManaged = !credential.idToken || !credential.refreshToken
  if (externallyManaged && !credential.accountId) {
    throw new Error(
      '该账号只有 access token 且缺少 Team/K12 workspace ID，无法生成 Codex 文件认证配置'
    )
  }

  return {
    mode: externallyManaged ? 'external' : 'oauth',
    value: {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: externallyManaged ? credential.accessToken : credential.idToken,
        access_token: credential.accessToken,
        refresh_token: externallyManaged ? '' : credential.refreshToken,
        account_id: credential.accountId
      },
      last_refresh: credential.lastRefresh ?? now.toISOString()
    }
  }
}
