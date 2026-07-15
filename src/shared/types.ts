export type CredentialSourceFormat = 'json' | 'jsonl' | 'txt' | 'js' | 'zip' | 'paste'
export type CredentialDialect = 'codex' | 'cpa' | 'sub2api' | 'generic'

export interface NormalizedCredential {
  id: string
  email: string | null
  accountId: string | null
  subject: string | null
  accessToken: string
  refreshToken: string | null
  idToken: string | null
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
}

export type AccountStatus =
  | 'untested'
  | 'valid'
  | 'quota_exhausted'
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

export interface UsageSummary {
  planType: string | null
  windows: UsageWindow[]
  checkedAt: string
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
}

export interface ScanResult {
  imported: number
  skipped: number
  errors: string[]
  accounts: AccountSummary[]
}

export interface BatchTestResult {
  tested: number
  results: TestResult[]
  cancelled: boolean
}

export type CredentialExportFormat = 'cpa' | 'sub2api'
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
