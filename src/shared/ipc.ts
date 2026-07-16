import type {
  AccountSummary,
  AppSettings,
  AutoSwitchRunResult,
  AutoSwitchState,
  BatchTestResult,
  CpaCodexAccountSummary,
  CpaCodexScanResult,
  CredentialExportRequest,
  CredentialExportResult,
  DeleteAccountsResult,
  CustomApiProfileInput,
  CustomApiProfileSummary,
  GrokAccountSummary,
  GrokBatchTestResult,
  GrokScanResult,
  ManagedFileStateResult,
  ScanResult,
  SessionRepairPreview,
  SessionRepairResult,
  SwitchResult
} from './types'

export interface TestProgress {
  active: boolean
  done: number
  total: number
  runningIds: string[]
  updatedAccount: AccountSummary | null
}

export interface GrokTestProgress {
  active: boolean
  done: number
  total: number
  runningIds: string[]
  updatedAccount: GrokAccountSummary | null
}

export interface CpaCodexTestProgress {
  active: boolean
  done: number
  total: number
  runningIds: string[]
  updatedAccount: CpaCodexAccountSummary | null
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not_available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  availableVersion: string | null
  percent: number | null
  message: string
}

export interface AppSnapshot {
  accounts: AccountSummary[]
  settings: AppSettings
  importDirectory: string
  testing: TestProgress
  autoSwitch: AutoSwitchState
  grokAccounts: GrokAccountSummary[]
  grokDirectory: string
  grokTesting: GrokTestProgress
  cpaCodexAccounts: CpaCodexAccountSummary[]
  cpaCodexTesting: CpaCodexTestProgress
  customApi: CustomApiProfileSummary
}

export interface RestartResult {
  ok: boolean
  message: string
}

export interface CodexSwitcherApi {
  getSnapshot(): Promise<AppSnapshot>
  scanDirectory(): Promise<ScanResult>
  importFiles(): Promise<ScanResult | null>
  importDirectory(): Promise<ScanResult | null>
  importPasted(text: string): Promise<ScanResult>
  importAnyFiles(): Promise<ScanResult | null>
  importAnyDirectory(): Promise<ScanResult | null>
  importAnyPasted(text: string): Promise<ScanResult>
  deleteAccounts(ids: string[]): Promise<DeleteAccountsResult>
  exportAccounts(request: CredentialExportRequest): Promise<CredentialExportResult>
  exportAccountsToCpa(ids: string[]): Promise<CpaCodexScanResult>
  testAccounts(ids?: string[]): Promise<BatchTestResult>
  cancelTests(): Promise<void>
  switchAccount(id: string, restart: boolean): Promise<SwitchResult>
  restoreLatest(restart: boolean): Promise<SwitchResult>
  restoreApiMode(restart: boolean): Promise<SwitchResult>
  switchToCustomApi(profile: CustomApiProfileInput, restart: boolean): Promise<SwitchResult>
  getCustomApiProfile(): Promise<CustomApiProfileSummary>
  scanGrokDirectory(): Promise<GrokScanResult>
  importGrokFiles(): Promise<GrokScanResult | null>
  importGrokDirectory(): Promise<GrokScanResult | null>
  importGrokPasted(text: string): Promise<GrokScanResult>
  deleteGrokAccounts(ids: string[]): Promise<DeleteAccountsResult>
  testGrokAccounts(ids?: string[]): Promise<GrokBatchTestResult>
  cancelGrokTests(): Promise<void>
  exportGrokAccounts(ids: string[], layout: 'separate' | 'bundle'): Promise<string[] | null>
  scanCpaCodexDirectory(): Promise<CpaCodexScanResult>
  testCpaCodexAccounts(ids?: string[]): Promise<BatchTestResult>
  cancelCpaCodexTests(): Promise<void>
  deleteCpaCodexAccounts(ids: string[]): Promise<DeleteAccountsResult>
  setCpaCodexEnabled(ids: string[], enabled: boolean): Promise<ManagedFileStateResult>
  setGrokEnabled(ids: string[], enabled: boolean): Promise<ManagedFileStateResult>
  restartCodex(): Promise<RestartResult>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  chooseAccountDirectory(): Promise<string | null>
  chooseGrokDirectory(): Promise<string | null>
  revealSource(id: string): Promise<RestartResult>
  previewSessionRepair(targetProvider?: string): Promise<SessionRepairPreview>
  applySessionRepair(snapshotId: string, targetProvider: string): Promise<SessionRepairResult>
  getUpdateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  runAutoSwitchNow(): Promise<AutoSwitchRunResult>
  onTestProgress(listener: (progress: TestProgress) => void): () => void
  onGrokTestProgress(listener: (progress: GrokTestProgress) => void): () => void
  onCpaCodexTestProgress(listener: (progress: CpaCodexTestProgress) => void): () => void
  onUpdateState(listener: (state: UpdateState) => void): () => void
  onAutoSwitchState(listener: (state: AutoSwitchState) => void): () => void
}

export const ipcChannels = {
  snapshot: 'app:snapshot',
  scan: 'accounts:scan',
  import: 'accounts:import',
  importDirectory: 'accounts:import-directory',
  importPasted: 'accounts:import-pasted',
  importAny: 'accounts:import-any',
  importAnyDirectory: 'accounts:import-any-directory',
  importAnyPasted: 'accounts:import-any-pasted',
  deleteAccounts: 'accounts:delete',
  exportAccounts: 'accounts:export',
  exportAccountsToCpa: 'accounts:export-to-cpa',
  test: 'accounts:test',
  cancelTest: 'accounts:test-cancel',
  switchAccount: 'accounts:switch',
  restore: 'accounts:restore',
  restoreApiMode: 'accounts:restore-api-mode',
  customApiSwitch: 'custom-api:switch',
  customApiProfile: 'custom-api:profile',
  grokScan: 'grok:scan',
  grokImport: 'grok:import',
  grokImportDirectory: 'grok:import-directory',
  grokImportPasted: 'grok:import-pasted',
  grokDelete: 'grok:delete',
  grokTest: 'grok:test',
  grokCancelTest: 'grok:test-cancel',
  grokExport: 'grok:export',
  grokTestProgress: 'grok:test-progress',
  cpaCodexScan: 'cpa-codex:scan',
  cpaCodexTest: 'cpa-codex:test',
  cpaCodexCancelTest: 'cpa-codex:test-cancel',
  cpaCodexDelete: 'cpa-codex:delete',
  cpaCodexSetEnabled: 'cpa-codex:set-enabled',
  cpaCodexTestProgress: 'cpa-codex:test-progress',
  grokSetEnabled: 'grok:set-enabled',
  restart: 'codex:restart',
  settingsUpdate: 'settings:update',
  settingsChooseDirectory: 'settings:choose-directory',
  settingsChooseGrokDirectory: 'settings:choose-grok-directory',
  revealSource: 'accounts:reveal-source',
  sessionRepairPreview: 'sessions:repair-preview',
  sessionRepairApply: 'sessions:repair-apply',
  testProgress: 'accounts:test-progress',
  updateState: 'updates:state',
  updateGetState: 'updates:get-state',
  updateCheck: 'updates:check',
  updateDownload: 'updates:download',
  updateInstall: 'updates:install',
  autoSwitchRun: 'auto-switch:run',
  autoSwitchState: 'auto-switch:state'
} as const
