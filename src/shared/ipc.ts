import type {
  AccountSummary,
  AppSettings,
  AutoSwitchRunResult,
  AutoSwitchState,
  BatchTestResult,
  CredentialExportRequest,
  CredentialExportResult,
  DeleteAccountsResult,
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
  deleteAccounts(ids: string[]): Promise<DeleteAccountsResult>
  exportAccounts(request: CredentialExportRequest): Promise<CredentialExportResult>
  testAccounts(ids?: string[]): Promise<BatchTestResult>
  cancelTests(): Promise<void>
  switchAccount(id: string, restart: boolean): Promise<SwitchResult>
  restoreLatest(restart: boolean): Promise<SwitchResult>
  restoreApiMode(restart: boolean): Promise<SwitchResult>
  restartCodex(): Promise<RestartResult>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  chooseAccountDirectory(): Promise<string | null>
  revealSource(id: string): Promise<RestartResult>
  previewSessionRepair(targetProvider?: string): Promise<SessionRepairPreview>
  applySessionRepair(snapshotId: string, targetProvider: string): Promise<SessionRepairResult>
  getUpdateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  downloadUpdate(): Promise<void>
  installUpdate(): Promise<void>
  runAutoSwitchNow(): Promise<AutoSwitchRunResult>
  onTestProgress(listener: (progress: TestProgress) => void): () => void
  onUpdateState(listener: (state: UpdateState) => void): () => void
  onAutoSwitchState(listener: (state: AutoSwitchState) => void): () => void
}

export const ipcChannels = {
  snapshot: 'app:snapshot',
  scan: 'accounts:scan',
  import: 'accounts:import',
  importDirectory: 'accounts:import-directory',
  importPasted: 'accounts:import-pasted',
  deleteAccounts: 'accounts:delete',
  exportAccounts: 'accounts:export',
  test: 'accounts:test',
  cancelTest: 'accounts:test-cancel',
  switchAccount: 'accounts:switch',
  restore: 'accounts:restore',
  restoreApiMode: 'accounts:restore-api-mode',
  restart: 'codex:restart',
  settingsUpdate: 'settings:update',
  settingsChooseDirectory: 'settings:choose-directory',
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
