import { z } from 'zod'

const nullableString = z.string().nullable()

export const normalizedCredentialSchema = z.object({
  id: z.string().min(1),
  email: nullableString,
  accountId: nullableString,
  subject: nullableString,
  accessToken: z.string().min(1),
  refreshToken: nullableString,
  idToken: nullableString,
  planType: nullableString,
  lastRefresh: nullableString,
  accessExpiresAt: nullableString,
  idExpiresAt: nullableString,
  canRefresh: z.boolean(),
  sourcePath: z.string().min(1),
  sourceFormat: z.enum(['json', 'jsonl', 'txt', 'js', 'md', 'zip', 'paste']),
  sourceDialect: z.enum(['codex', 'cpa', 'sub2api', 'generic'])
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
  checkedAt: z.string()
})

export const testResultSchema = z.object({
  accountId: z.string().min(1),
  status: z.enum([
    'untested',
    'valid',
    'quota_exhausted',
    'quota_exhausted_5h',
    'quota_exhausted_weekly',
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
