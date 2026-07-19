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

export type CodexTestMode = 'usage' | 'full' | 'refresh'

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

export interface AccountMetadataFields {
  alias?: string | null
  group?: string | null
  tags?: string[]
  note?: string | null
}

export interface AccountMetadata {
  accountId: string
  alias: string | null
  group: string | null
  tags: string[]
  note: string | null
  updatedAt: string
}

export type AccountMetadataTagMode = 'replace' | 'add' | 'remove'

export interface AccountMetadataUpdateRequest {
  accountIds: string[]
  alias?: string | null
  group?: string | null
  tags?: string[]
  tagMode?: AccountMetadataTagMode
  note?: string | null
}

export interface AccountSummary extends AccountMetadataFields {
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

export interface GrokAccountSummary extends AccountMetadataFields {
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

export interface CpaCodexAccountSummary extends AccountMetadataFields {
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
  recognized?: number
  errors: string[]
  accounts: AccountSummary[]
}

export interface LibraryImportResult {
  imported: number
  skipped: number
  recognized?: number
  errors: string[]
  codexImported: number
  codexSkipped: number
  grokImported: number
  grokSkipped: number
  accounts: AccountSummary[]
  grokAccounts: GrokAccountSummary[]
}

export type ImportAccountProvider = 'codex' | 'grok'
export type ImportPreviewDisposition = 'new' | 'duplicate' | 'update' | 'conflict'
export type ImportPreviewDecision = 'add' | 'replace' | 'skip'

/** A source that produced no safe credential and must be explicitly handled. */
export interface ImportSourceIssue {
  sourcePath: string
  sourceFormat: CredentialSourceFormat
  detail: string
}

export interface ImportPreviewItem {
  key: string
  provider: ImportAccountProvider
  credentialId: string
  existingCredentialId: string | null
  email: string | null
  planType: string | null
  identity: string
  sourcePath: string
  sourceFormat: CredentialSourceFormat
  sourceDialect: CredentialDialect
  canRefresh: boolean
  switchable: boolean
  disposition: ImportPreviewDisposition
  detail: string
  suggestedDecision: ImportPreviewDecision
}

export interface ImportPreviewUnrecognized extends ImportSourceIssue {
  key: string
}

export type ImportPreviewManualMode = 'codex' | 'grok' | 'codex_rt' | 'mobile_rt'

export interface ImportPreviewRefineRequest {
  sessionId: string
  sourceKey: string
  mode: ImportPreviewManualMode
}

export interface ImportPreviewResult {
  sessionId: string
  createdAt: string
  expiresAt: string
  sourceCount: number
  recognized: number
  errors: string[]
  items: ImportPreviewItem[]
  unrecognized: ImportPreviewUnrecognized[]
}

export interface ImportPreviewCommitRequest {
  sessionId: string
  decisions: Record<string, ImportPreviewDecision>
  /** Required when the user deliberately chooses to ignore unknown sources. */
  skipUnrecognized?: boolean
}

export interface ImportPreviewCommitResult extends LibraryImportResult {
  added: number
  updated: number
  ignored: number
}

export type LibraryHealthScope = 'aa-codex' | 'aa-grok' | 'cpa' | 'metadata'
export type LibraryHealthSeverity = 'info' | 'warning' | 'error'
export type LibraryHealthIssueKind =
  | 'duplicate_identity'
  | 'noncanonical_file'
  | 'multi_account_file'
  | 'mixed_provider_file'
  | 'malformed_file'
  | 'orphan_status'
  | 'orphan_metadata'

export interface LibraryHealthIssue {
  id: string
  scope: LibraryHealthScope
  severity: LibraryHealthSeverity
  kind: LibraryHealthIssueKind
  title: string
  detail: string
  paths: string[]
  accountIds: string[]
  repairable: boolean
  repairAction: string | null
}

export interface LibraryHealthReport {
  snapshotId: string
  generatedAt: string
  scannedFiles: number
  healthyAccounts: number
  issues: LibraryHealthIssue[]
}

export interface LibraryHealthRepairResult {
  repaired: number
  skipped: number
  errors: string[]
  message: string
  report: LibraryHealthReport
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

export interface CredentialPriorityRequest {
  accountIds: string[]
  defaultPriority: number
  priorities?: Record<string, number>
}

export interface CredentialExportRequest {
  accountIds: string[]
  format: CredentialExportFormat
  layout: CredentialExportLayout
  defaultPriority?: number
  priorities?: Record<string, number>
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

export type ConversationKind = 'main' | 'subagent' | 'internal' | 'unknown'

export type ConversationSubagentKind =
  | 'thread_spawn'
  | 'review'
  | 'compact'
  | 'memory_consolidation'
  | 'other'
  | null

export type ConversationLifecycleStatus = 'open' | 'closed' | 'unknown'
export type ConversationSearchScope = 'metadata' | 'content'
export type ConversationArchiveFilter = 'all' | 'active' | 'archived'
export type ConversationSortMode = 'updated' | 'hierarchy'

export interface ConversationListQuery {
  query?: string
  searchScope?: ConversationSearchScope
  kind?: 'all' | ConversationKind
  subagentKind?: 'all' | Exclude<ConversationSubagentKind, null>
  lifecycleStatus?: 'all' | ConversationLifecycleStatus
  archive?: ConversationArchiveFilter
  provider?: string
  workspace?: string
  updatedWithinDays?: number | null
  sort?: ConversationSortMode
  offset?: number
  limit?: number
  force?: boolean
}

export interface ConversationFacetOption {
  value: string
  label: string
  count: number
}

export interface ConversationFacets {
  kinds: ConversationFacetOption[]
  subagentKinds: ConversationFacetOption[]
  lifecycleStatuses: ConversationFacetOption[]
  archives: ConversationFacetOption[]
  providers: ConversationFacetOption[]
  workspaces: ConversationFacetOption[]
}

export interface ConversationSummary {
  id: string
  title: string
  cwd: string | null
  provider: string
  createdAt: string | null
  updatedAt: string
  archived: boolean
  sourcePath: string
  sizeBytes: number
  kind: ConversationKind
  subagentKind: ConversationSubagentKind
  parentId: string | null
  parentTitle: string | null
  childCount: number
  depth: number | null
  agentNickname: string | null
  agentRole: string | null
  lifecycleStatus: ConversationLifecycleStatus
  safeToClean: boolean
  matchExcerpt: string | null
}

export interface ConversationMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  timestamp: string | null
}

export interface ConversationListResult {
  items: ConversationSummary[]
  total: number
  allTotal: number
  offset: number
  hasMore: boolean
  facets: ConversationFacets
  safeCleanupCount: number
  safeCleanupBytes: number
}

export interface ConversationCleanupPreview {
  count: number
  sizeBytes: number
  candidateIds: string[]
  closedSubagents: number
  skippedOpen: number
  skippedRecent: number
  skippedUnknown: number
  graceMinutes: number
}

export interface ConversationDetail {
  conversation: ConversationSummary
  messages: ConversationMessage[]
  totalMessages: number
  truncated: boolean
}

export interface DeleteConversationsResult {
  deleted: number
  failed: number
  deletedIds: string[]
  indexEntriesChanged: number
  errors: string[]
  message: string
}
