import { z } from 'zod'

const nullableString = z.string().nullable()
const secretExtensionsSchema = z.object({
  schemaVersion: z.literal(1),
  accountType: z.enum([
    'oauth', 'personal_access_token', 'setup_token', 'api_key', 'upstream', 'agent_identity'
  ]),
  credentials: z.record(z.string(), z.unknown()).nullable(),
  extra: z.record(z.string(), z.unknown()).nullable(),
  modelMapping: z.record(z.string(), z.string()),
  concurrency: z.number().nullable(),
  priority: z.number().nullable(),
  rateMultiplier: z.number().nullable(),
  autoPauseOnExpired: z.boolean().nullable(),
  metadata: z.record(z.string(), z.unknown())
})

export const normalizedCredentialSchema = z.object({
  credentialKind: z.literal('access_token').optional().default('access_token'),
  id: z.string().min(1),
  email: nullableString,
  accountId: nullableString,
  subject: nullableString,
  accessToken: z.string().min(1),
  refreshToken: nullableString,
  oauthClientId: nullableString.optional().default(null),
  isFedRamp: z.boolean().nullable().optional().default(null),
  idToken: nullableString,
  authKind: z.enum([
    'oauth', 'personal_access_token', 'setup_token', 'api_key', 'upstream'
  ]).default('oauth'),
  planType: nullableString,
  lastRefresh: nullableString,
  accessExpiresAt: nullableString,
  idExpiresAt: nullableString,
  canRefresh: z.boolean(),
  sourcePath: z.string().min(1),
  sourceFormat: z.enum(['json', 'jsonl', 'txt', 'js', 'md', 'zip', 'paste']),
  sourceDialect: z.enum(['codex', 'cpa', 'sub2api', 'cockpit', 'generic']),
  secretExtensions: secretExtensionsSchema.optional()
})

/**
 * Agent Identity credentials deliberately use a separate schema from bearer
 * credentials.  In particular, accepting an `accessToken` here would make it
 * too easy for a caller to accidentally route the identity through one of the
 * OAuth-only account flows.
 */
export const normalizedAgentIdentityCredentialSchema = z.object({
  credentialKind: z.literal('agent_identity'),
  id: z.string().min(1),
  email: nullableString,
  accountId: z.string().min(1),
  subject: z.string().min(1),
  authKind: z.literal('agent_identity'),
  agentIdentity: z.object({
    runtimeId: z.string().min(1),
    privateKey: z.string().min(1),
    taskId: nullableString,
    accountId: z.string().min(1),
    userId: z.string().min(1)
  }),
  planType: nullableString,
  expiresAt: nullableString,
  sourcePath: z.string().min(1),
  sourceFormat: z.enum(['json', 'jsonl', 'txt', 'js', 'md', 'zip', 'paste']),
  sourceDialect: z.enum(['codex', 'cpa', 'sub2api', 'cockpit', 'generic']),
  secretExtensions: secretExtensionsSchema
})

const usageWindowSchema = z.object({
  id: z.string(),
  label: z.string(),
  usedPercent: z.number().nullable(),
  remainingPercent: z.number().nullable(),
  resetAt: nullableString,
  resetInSeconds: z.number().nullable(),
  windowSeconds: z.number().nullable()
})

const usageSummarySchema = z.object({
  planType: nullableString,
  windows: z.array(usageWindowSchema),
  checkedAt: z.string(),
  credits: z.object({
    hasCredits: z.boolean(),
    unlimited: z.boolean(),
    balance: nullableString
  }).nullable().optional().default(null),
  spendLimit: z.object({
    limit: nullableString,
    used: nullableString,
    remaining: nullableString,
    remainingPercent: z.number().nullable(),
    resetAt: nullableString
  }).nullable().optional().default(null),
  resetCreditsAvailable: z.number().int().nonnegative().nullable().optional().default(null),
  rateLimitReachedType: nullableString.optional().default(null)
})

export const testResultSchema = z.object({
  accountId: z.string().min(1),
  status: z.enum([
    'untested',
    'valid',
    'quota_exhausted',
    'quota_exhausted_5h',
    'quota_exhausted_weekly',
    'workspace_deactivated',
    'no_permission',
    'invalid',
    'needs_refresh',
    'non_refreshable',
    'model_unavailable',
    'network_error',
    'file_error',
    'endpoint_incompatible'
  ]),
  detail: z.string(),
  checkedAt: z.string(),
  httpStatus: z.number().int().nullable(),
  stage: z.enum(['local', 'usage', 'refresh', 'deep-test']),
  refreshed: z.boolean(),
  usage: usageSummarySchema.nullable()
})
