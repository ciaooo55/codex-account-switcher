export type CredentialSourceFormat = 'json' | 'jsonl' | 'txt' | 'js' | 'md' | 'zip' | 'paste'
export type CredentialDialect = 'codex' | 'cpa' | 'sub2api' | 'generic'
export type CredentialAuthKind = 'oauth' | 'personal_access_token'
export type RefreshTokenClientMode = 'auto' | 'codex' | 'mobile'

export interface OAuthAuthorizationSession {
  sessionId: string
  authUrl: string
  expiresAt: string
}

export interface NormalizedCredential {
  id: string
  email: string | null
  accountId: string | null
  subject: string | null
  accessToken: string
  refreshToken: string | null
  oauthClientId?: string | null
  isFedRamp?: boolean | null
  idToken: string | null
  authKind: CredentialAuthKind
  planType: string | null
  lastRefresh: string | null
  accessExpiresAt: string | null
  idExpiresAt: string | null
  canRefresh: boolean
  sourcePath: string
  sourceFormat: CredentialSourceFormat
  sourceDialect: CredentialDialect
}

export interface CredentialParseOptions {
  sourcePath: string
  format: CredentialSourceFormat
}

export interface CredentialParseResult {
  credentials: NormalizedCredential[]
  errors: string[]
}

export interface SecretCipher {
  encrypt(plainText: string): string
  decrypt(encryptedText: string): string
}

export interface SwitchResult {
  ok: boolean
  message: string
  backupPath: string | null
  restartResult?: {
    ok: boolean
    message: string
  }
}

export type AccountStatus =
  | 'untested'
  | 'valid'
  | 'quota_exhausted'
  | 'quota_exhausted_5h'
  | 'quota_exhausted_weekly'
  | 'workspace_deactivated'
  | 'no_permission'
  | 'invalid'
  | 'needs_refresh'
  | 'non_refreshable'
  | 'model_unavailable'
  | 'network_error'
  | 'file_error'
  | 'endpoint_incompatible'

export interface UsageWindow {
  id: string
  label: string
  usedPercent: number | null
  remainingPercent: number | null
  resetAt: string | null
  resetInSeconds: number | null
  windowSeconds: number | null
}

export interface UsageCredits {
  hasCredits: boolean
  unlimited: boolean
  balance: string | null
}

export interface UsageSpendLimit {
  limit: string | null
  used: string | null
  remaining: string | null
  remainingPercent: number | null
  resetAt: string | null
}

export interface UsageSummary {
  planType: string | null
  windows: UsageWindow[]
  checkedAt: string
  credits?: UsageCredits | null
  spendLimit?: UsageSpendLimit | null
  resetCreditsAvailable?: number | null
  rateLimitReachedType?: string | null
}

export interface TestResult {
  accountId: string
  status: AccountStatus
  detail: string
  checkedAt: string
  httpStatus: number | null
  stage: 'local' | 'usage' | 'refresh' | 'deep-test'
  refreshed: boolean
  usage: UsageSummary | null
}

export interface AccountSummary {
  id: string
  email: string | null
  workspaceId: string | null
  planType: string | null
  sourcePath: string
  sourceFormat: CredentialSourceFormat
  sourceDialect: CredentialDialect
  canRefresh: boolean
  switchable: boolean
  switchMode?: 'oauth' | 'personal_access_token' | 'external' | 'test-only'
  accessExpiresAt: string | null
  lastRefresh: string | null
  status: AccountStatus
  detail: string
  lastCheckedAt: string | null
  usage: UsageSummary | null
  active: boolean
}

export interface AppSettings {
  accountDirectory: string
  authPath: string
  configPath: string
  concurrency: number
  timeoutMs: number
  backupRetention: number
  deepTestModel: string
  autoSwitchEnabled: boolean
  autoSwitchIntervalSeconds: number
  autoSwitchAccountIds: string[]
  autoSwitchRestartCodex: boolean
  grokDirectory: string
  customApiBaseUrl: string
  customApiModel: string
}

export type DisplayAccountStatus =
  | 'untested'
  | 'valid'
  | 'invalid'
  | 'quota_exhausted_weekly'
  | 'quota_exhausted_5h'
  | 'unknown_error'

export interface GrokCredential {
  id: string
  email: string | null
  subject: string | null
  teamId: string | null
  accessToken: string
  refreshToken: string | null
  idToken: string | null
  tokenType: string
  clientId: string
  baseUrl: string
  tokenEndpoint: string
  scope: string | null
  planType: string | null
  lastRefresh: string | null
  expiresAt: string | null
  sourcePath: string
  sourceFormat: CredentialSourceFormat
  sourceDialect: CredentialDialect
  billingSnapshot: Record<string, unknown> | null
  usageSnapshot: Record<string, unknown> | null
}

export interface GrokAccountSummary {
  id: string
  email: string | null
  subject: string | null
  teamId: string | null
  planType: string | null
  sourcePath: string
  sourceFormat: CredentialSourceFormat
  sourceDialect: CredentialDialect
  canRefresh: boolean
  expiresAt: string | null
  lastRefresh: string | null
  status: DisplayAccountStatus
  detail: string
  lastCheckedAt: string | null
  usage: UsageSummary | null
  disabled: boolean
}

export interface CpaCodexAccountSummary {
  id: string
  email: string | null
  workspaceId: string | null
  planType: string | null
  sourcePath: string
  sourceDialect: CredentialDialect
  canRefresh: boolean
  accessExpiresAt: string | null
  lastRefresh: string | null
  status: AccountStatus
  detail: string
  lastCheckedAt: string | null
  usage: UsageSummary | null
  disabled: boolean
}

export interface CpaCodexScanResult {
  imported: number
  skipped: number
  errors: string[]
  accounts: CpaCodexAccountSummary[]
}

export interface CpaDirectoryStats {
  credentialFiles: number
  codexFiles: number
  grokFiles: number
  duplicateFiles: number
  unrecognizedFiles: number
  mixedFiles?: number
}

export interface ManagedFileStateResult {
  changed: number
  skipped: number
  message: string
}

export interface GrokTestResult {
  accountId: string
  status: DisplayAccountStatus
  detail: string
  checkedAt: string
  httpStatus: number | null
  refreshed: boolean
  usage: UsageSummary | null
}

export interface GrokScanResult {
  imported: number
  skipped: number
  errors: string[]
  accounts: GrokAccountSummary[]
}

export interface GrokBatchTestResult {
  tested: number
  results: GrokTestResult[]
  cancelled: boolean
}

export interface CustomApiProfileInput {
  baseUrl: string
  model: string
  apiKey?: string
}

export interface CustomApiProfileSummary {
  baseUrl: string
  model: string
  hasApiKey: boolean
}

export interface AutoSwitchState {
  enabled: boolean
  running: boolean
  nextCheckAt: string | null
  lastCheckAt: string | null
  lastMessage: string
  lastSwitchedAccountId: string | null
}

export interface AutoSwitchRunResult {
  ok: boolean
  switched: boolean
  message: string
  checkedAccountIds: string[]
  switchedAccountId: string | null
}

export interface ScanResult {
  imported: number
  skipped: number
  errors: string[]
  accounts: AccountSummary[]
}

export interface LibraryImportResult {
  imported: number
  skipped: number
  errors: string[]
  codexImported: number
  codexSkipped: number
  grokImported: number
  grokSkipped: number
  accounts: AccountSummary[]
  grokAccounts: GrokAccountSummary[]
}

export interface DeleteAccountsResult {
  deleted: number
  message: string
}

export interface BatchTestResult {
  tested: number
  results: TestResult[]
  cancelled: boolean
}

export type CredentialExportFormat = 'cpa' | 'sub2api' | 'codex'
export type CredentialExportLayout = 'separate' | 'bundle'

export interface CredentialExportRequest {
  accountIds: string[]
  format: CredentialExportFormat
  layout: CredentialExportLayout
}

export interface CredentialExportResult {
  ok: boolean
  cancelled: boolean
  exported: number
  files: string[]
  errors: string[]
  message: string
}

export interface SessionRepairPreview {
  snapshotId: string
  currentProvider: string
  targetProvider: string
  availableProviders: string[]
  scannedSessionFiles: number
  changedSessionFiles: number
  skippedLockedFiles: string[]
  encryptedContentFiles: number
  encryptedContentProviders: string[]
  sqliteProviderRows: number
  sqliteUserEventRows: number
  sqliteCwdRows: number
  globalStateKeys: number
}

export interface SessionRepairResult {
  ok: boolean
  message: string
  targetProvider: string
  changedSessionFiles: number
  sqliteRowsUpdated: number
  globalStateKeysUpdated: number
  backupPath: string | null
}
