import { randomUUID } from 'node:crypto'
import type {
  CredentialSourceInput,
  CredentialSourceProvider
} from '../../shared/api-server'
import type { GrokCredential, NormalizedCredential } from '../../shared/types'
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

interface CredentialProviderLists {
  codex: () => Promise<NormalizedCredential[]>
  cpaCodex: () => Promise<NormalizedCredential[]>
  grok: () => Promise<GrokCredential[]>
  cpaGrok: () => Promise<GrokCredential[]>
}

type AnyCredential = NormalizedCredential | GrokCredential

function providerList(
  providers: CredentialProviderLists,
  provider: CredentialSourceProvider
): () => Promise<AnyCredential[]> {
  switch (provider) {
    case 'codex': return providers.codex
    case 'cpa-codex': return providers.cpaCodex
    case 'grok': return providers.grok
    case 'cpa-grok': return providers.cpaGrok
  }
}

function sourceId(provider: CredentialSourceProvider, credentialId: string): string {
  return `${provider}:${credentialId}`
}

function sourceModels(credential: AnyCredential): string[] {
  const mapping = credential.secretExtensions?.modelMapping ?? {}
  return normalizeModelIds([...Object.keys(mapping), ...Object.values(mapping)])
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

/**
 * Resolves credential references against the live encrypted vault/directory at
 * request time. This object stays in the main process; no method returns a
 * token-bearing value to IPC or persistent API-server storage.
 */
export class CredentialUpstreamRegistry {
  constructor(private readonly providers: CredentialProviderLists) {}

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
      safely(this.providers.cpaGrok).then((credentials) => ['cpa-grok', credentials] as const)
    ])
    const result: CredentialSourceInput[] = []
    const discoveredIds = new Set<string>()
    for (const [provider, credentials] of groups) {
      for (const credential of credentials) {
        const id = sourceId(provider, credential.id)
        if (discoveredIds.has(id)) continue
        discoveredIds.add(id)
        const previous = configuredById.get(id)
        result.push(previous
          ? {
              ...previous,
              // Refresh only provider identity and newly discovered models.
              provider,
              credentialId: credential.id,
              models: previous.models.length > 0 ? [...previous.models] : sourceModels(credential)
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
    const { source, endpoint } = request
    if (source.id !== sourceId(source.provider, source.credentialId)) return null
    const credential = (await providerList(this.providers, source.provider)())
      .find((entry) => entry.id === source.credentialId)
    if (!credential?.accessToken) return null

    if (source.provider === 'codex' || source.provider === 'cpa-codex') {
      const codex = credential as NormalizedCredential
      const compact = endpoint === '/v1/responses/compact'
      return {
        url: compact ? `${CODEX_RESPONSES_URL}/compact` : CODEX_RESPONSES_URL,
        headers: codexHeaders(codex, compact),
        bodyPatch: { store: false }
      }
    }

    if (endpoint !== '/v1/responses') return null
    return {
      url: GROK_RESPONSES_URL,
      headers: grokHeaders(credential as GrokCredential),
      bodyPatch: { store: false }
    }
  }
}
