import { createPrivateKey, randomUUID, sign } from 'node:crypto'
import type {
  CredentialSourceInput,
  CredentialSourceProvider
} from '../../shared/api-server'
import type {
  GrokCredential,
  NormalizedAgentIdentityCredential,
  NormalizedCredential
} from '../../shared/types'
import {
  normalizeModelIds
} from '../../shared/api-server'
import type {
  CredentialUpstreamResolution,
  CredentialUpstreamResolveRequest
} from './local-api-server'

const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const CODEX_VERSION = '0.135.0'
const CODEX_USER_AGENT = `codex-tui/${CODEX_VERSION} (Windows 10.0.0; x86_64) codex-account-switcher/${CODEX_VERSION}`
const GROK_RESPONSES_URL = 'https://cli-chat-proxy.grok.com/v1/responses'
const GROK_CLIENT_VERSION = '0.2.93'
const AGENT_IDENTITY_AUTH_API_BASE_URL = 'https://auth.openai.com/api/accounts'

interface CredentialProviderLists {
  codex: () => Promise<NormalizedCredential[]>
  cpaCodex: () => Promise<NormalizedCredential[]>
  grok: () => Promise<GrokCredential[]>
  cpaGrok: () => Promise<GrokCredential[]>
  /** Stored separately because an Agent Identity is not a bearer credential. */
  agentIdentity: () => Promise<NormalizedAgentIdentityCredential[]>
  /** Persists a newly registered/recovered task in the encrypted identity vault. */
  updateAgentIdentity?: (credential: NormalizedAgentIdentityCredential) => Promise<void>
}

type AnyCredential = NormalizedCredential | GrokCredential | NormalizedAgentIdentityCredential

function providerList(
  providers: CredentialProviderLists,
  provider: CredentialSourceProvider
): () => Promise<AnyCredential[]> {
  switch (provider) {
    case 'codex': return providers.codex
    case 'cpa-codex': return providers.cpaCodex
    case 'grok': return providers.grok
    case 'cpa-grok': return providers.cpaGrok
    case 'agent-identity': return providers.agentIdentity
  }
}

function sourceId(provider: CredentialSourceProvider, credentialId: string): string {
  return `${provider}:${credentialId}`
}

/**
 * model_mapping uses the Sub2API/Cockpit direction: public alias -> actual
 * provider model.  Expose aliases to the local model directory, but keep a
 * mapping's values private to request-time resolution.  Unmapped manual model
 * entries remain supported through the saved credential source.
 */
function sourceModels(credential: AnyCredential): string[] {
  const mapping = credential.secretExtensions?.modelMapping ?? {}
  return normalizeModelIds(Object.keys(mapping))
}

function mappedSourceModel(credential: AnyCredential, sourceModel: string): string {
  const mapping = credential.secretExtensions?.modelMapping ?? {}
  return mapping[sourceModel]?.trim() || sourceModel
}

function sourceLabel(credential: AnyCredential): string {
  return (
    credential.email?.trim() ||
    credential.subject?.trim() ||
    `账号 ${credential.id.slice(0, 10)}`
  ).slice(0, 128)
}

function sourcePriority(credential: AnyCredential): number {
  const priority = credential.secretExtensions?.priority
  return priority !== null && priority !== undefined && Number.isFinite(priority)
    ? Math.trunc(priority)
    : 100
}

/** Only bearer credentials known to work with the official Codex endpoint may enter that pool. */
function supportsCredentialSource(
  provider: CredentialSourceProvider,
  credential: AnyCredential
): boolean {
  if (provider === 'agent-identity') return isAgentIdentity(credential)
  if (provider === 'grok' || provider === 'cpa-grok') return 'accessToken' in credential && Boolean(credential.accessToken)
  if (!('accessToken' in credential) || !credential.accessToken) return false
  // Legacy records without authKind predate this distinction and remain
  // compatible. Imported setup/api/upstream records are deliberately kept in
  // the library but must be configured as a third-party API instead of being
  // sent as fake Codex Bearer tokens.
  return credential.authKind === undefined
    || credential.authKind === 'oauth'
    || credential.authKind === 'personal_access_token'
}

function isAgentIdentity(
  credential: AnyCredential
): credential is NormalizedAgentIdentityCredential {
  return 'credentialKind' in credential &&
    credential.credentialKind === 'agent_identity' &&
    credential.authKind === 'agent_identity'
}

function codexHeaders(credential: NormalizedCredential, compact: boolean): Record<string, string> {
  const sessionId = randomUUID()
  return {
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${credential.accessToken}`,
    'content-type': 'application/json',
    originator: 'codex-tui',
    session_id: sessionId,
    'user-agent': CODEX_USER_AGENT,
    version: CODEX_VERSION,
    ...(credential.accountId ? { 'chatgpt-account-id': credential.accountId } : {}),
    ...(credential.isFedRamp ? { 'x-openai-fedramp': 'true' } : {}),
    ...(compact
      ? {
          conversation_id: sessionId,
          'openai-beta': 'responses=experimental'
        }
      : {})
  }
}

function grokHeaders(credential: GrokCredential): Record<string, string> {
  return {
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${credential.accessToken}`,
    'content-type': 'application/json',
    connection: 'Keep-Alive',
    'x-xai-token-auth': 'xai-grok-cli',
    'x-grok-client-version': GROK_CLIENT_VERSION,
    'user-agent': `xai-grok-workspace/${GROK_CLIENT_VERSION}`
  }
}

function rfc3339Seconds(now = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function agentIdentitySignature(
  credential: NormalizedAgentIdentityCredential,
  payload: string
): string {
  let key: ReturnType<typeof createPrivateKey>
  try {
    key = createPrivateKey({
      key: Buffer.from(credential.agentIdentity.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8'
    })
  } catch {
    throw new Error('Agent Identity 私钥无效')
  }
  try {
    return sign(null, Buffer.from(payload, 'utf8'), key).toString('base64')
  } catch {
    throw new Error('Agent Identity 签名失败')
  }
}

function agentAssertion(
  credential: NormalizedAgentIdentityCredential,
  timestamp = rfc3339Seconds()
): string {
  const { runtimeId, taskId } = credential.agentIdentity
  if (!runtimeId || !taskId) throw new Error('Agent Identity runtime 或 task_id 为空')
  const signature = agentIdentitySignature(credential, `${runtimeId}:${taskId}:${timestamp}`)
  const envelope = Buffer.from(JSON.stringify({
    agent_runtime_id: runtimeId,
    task_id: taskId,
    timestamp,
    signature
  }), 'utf8').toString('base64url')
  return `AgentAssertion ${envelope}`
}

function agentIdentityHeaders(
  credential: NormalizedAgentIdentityCredential,
  compact: boolean
): Record<string, string> {
  const sessionId = randomUUID()
  return {
    accept: 'application/json, text/event-stream',
    authorization: agentAssertion(credential),
    'content-type': 'application/json',
    originator: 'codex-tui',
    session_id: sessionId,
    'user-agent': CODEX_USER_AGENT,
    version: CODEX_VERSION,
    'chatgpt-account-id': credential.accountId,
    ...(compact
      ? {
          conversation_id: sessionId,
          'openai-beta': 'responses=experimental'
        }
      : {})
  }
}

/**
 * Resolves credential references against the live encrypted vault/directory at
 * request time. This object stays in the main process; no method returns a
 * token-bearing value to IPC or persistent API-server storage.
 */
export class CredentialUpstreamRegistry {
  private readonly agentTaskRegistrations = new Map<string, Promise<NormalizedAgentIdentityCredential>>()

  constructor(
    private readonly providers: CredentialProviderLists,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async discover(configured: readonly CredentialSourceInput[] = []): Promise<CredentialSourceInput[]> {
    const configuredById = new Map(configured.map((source) => [source.id, source]))
    const safely = async <T>(operation: () => Promise<T[]>): Promise<T[]> => {
      try {
        return await operation()
      } catch {
        // One corrupt or temporarily unavailable account directory must not
        // prevent the API-server page from showing the other providers.
        return []
      }
    }
    const groups = await Promise.all([
      safely(this.providers.codex).then((credentials) => ['codex', credentials] as const),
      safely(this.providers.cpaCodex).then((credentials) => ['cpa-codex', credentials] as const),
      safely(this.providers.grok).then((credentials) => ['grok', credentials] as const),
      safely(this.providers.cpaGrok).then((credentials) => ['cpa-grok', credentials] as const),
      safely(this.providers.agentIdentity).then((credentials) => ['agent-identity', credentials] as const)
    ])
    const result: CredentialSourceInput[] = []
    const discoveredIds = new Set<string>()
    for (const [provider, credentials] of groups) {
      for (const credential of credentials) {
        if (!supportsCredentialSource(provider, credential)) continue
        const id = sourceId(provider, credential.id)
        if (discoveredIds.has(id)) continue
        discoveredIds.add(id)
        const previous = configuredById.get(id)
        result.push(previous
          ? {
              ...previous,
              // Preserve any manual entries while incorporating newly imported
              // Sub2API/CPA mappings on every refresh.
              provider,
              credentialId: credential.id,
              models: normalizeModelIds([...previous.models, ...sourceModels(credential)])
            }
          : {
              id,
              provider,
              credentialId: credential.id,
              label: sourceLabel(credential),
              models: sourceModels(credential),
              priority: sourcePriority(credential),
              enabled: false
            })
      }
    }
    // Keep missing configured references visible so the UI can explain and
    // remove them; the dynamic resolver will treat them as unavailable.
    for (const source of configured) {
      if (!discoveredIds.has(source.id)) result.push({ ...source, models: [...source.models] })
    }
    return result.sort((left, right) =>
      left.provider.localeCompare(right.provider) || left.label.localeCompare(right.label)
    )
  }

  async resolve(request: CredentialUpstreamResolveRequest): Promise<CredentialUpstreamResolution | null> {
    const { source, endpoint, upstreamModel } = request
    if (source.id !== sourceId(source.provider, source.credentialId)) return null
    const credential = (await providerList(this.providers, source.provider)())
      .find((entry) => entry.id === source.credentialId)
    if (!credential || !supportsCredentialSource(source.provider, credential)) return null

    if (source.provider === 'agent-identity') {
      if (!isAgentIdentity(credential)) return null
      const identity = await this.ensureAgentTask(credential)
      const compact = endpoint === '/v1/responses/compact'
      return {
        url: compact ? `${CODEX_RESPONSES_URL}/compact` : CODEX_RESPONSES_URL,
        headers: agentIdentityHeaders(identity, compact),
        bodyPatch: { store: false },
        upstreamModel: mappedSourceModel(identity, upstreamModel)
      }
    }

    if (!('accessToken' in credential) || !credential.accessToken) return null

    if (source.provider === 'codex' || source.provider === 'cpa-codex') {
      const codex = credential as NormalizedCredential
      const compact = endpoint === '/v1/responses/compact'
      return {
        url: compact ? `${CODEX_RESPONSES_URL}/compact` : CODEX_RESPONSES_URL,
        headers: codexHeaders(codex, compact),
        bodyPatch: { store: false },
        upstreamModel: mappedSourceModel(codex, upstreamModel)
      }
    }

    if (endpoint !== '/v1/responses') return null
    return {
      url: GROK_RESPONSES_URL,
      headers: grokHeaders(credential as GrokCredential),
      bodyPatch: { store: false },
      upstreamModel: mappedSourceModel(credential, upstreamModel)
    }
  }

  /**
   * A task id may be absent in a freshly exported identity.  Register it in
   * the main process, serialize concurrent callers per credential, and save
   * the result only through the encrypted identity vault callback.
   */
  private async ensureAgentTask(
    credential: NormalizedAgentIdentityCredential
  ): Promise<NormalizedAgentIdentityCredential> {
    if (credential.agentIdentity.taskId?.trim()) return credential
    const existing = this.agentTaskRegistrations.get(credential.id)
    if (existing) return existing
    const registration = this.registerAgentTask(credential)
      .finally(() => this.agentTaskRegistrations.delete(credential.id))
    this.agentTaskRegistrations.set(credential.id, registration)
    return registration
  }

  private async registerAgentTask(
    credential: NormalizedAgentIdentityCredential
  ): Promise<NormalizedAgentIdentityCredential> {
    const runtimeId = credential.agentIdentity.runtimeId.trim()
    if (!runtimeId) throw new Error('Agent Identity runtime_id 为空')
    const timestamp = rfc3339Seconds()
    const signature = agentIdentitySignature(credential, `${runtimeId}:${timestamp}`)
    let response: Response
    try {
      response = await this.fetchImpl(
        `${AGENT_IDENTITY_AUTH_API_BASE_URL}/v1/agent/${encodeURIComponent(runtimeId)}/task/register`,
        {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ timestamp, signature })
        }
      )
    } catch {
      throw new Error('Agent Identity task 注册请求失败')
    }
    if (!response.ok) throw new Error(`Agent Identity task 注册返回 HTTP ${response.status}`)
    let body: Record<string, unknown>
    try {
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > 64 * 1024) throw new Error('too_large')
      const parsed: unknown = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
      body = parsed as Record<string, unknown>
    } catch {
      throw new Error('Agent Identity task 注册响应格式无效')
    }
    const taskId = [body.task_id, body.taskId]
      .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
      ?.trim()
    // The official service normally sends task_id directly.  Some older
    // deployments send encrypted_task_id; do not attempt a lossy or unsafe
    // pseudo-decryption here, because that would result in invalid assertions.
    if (!taskId) throw new Error('Agent Identity task 注册响应缺少可用 task_id')
    const updated: NormalizedAgentIdentityCredential = {
      ...credential,
      agentIdentity: { ...credential.agentIdentity, taskId }
    }
    await this.providers.updateAgentIdentity?.(updated)
    return updated
  }
}
