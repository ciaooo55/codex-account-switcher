import type {
  AccountSummary,
  AppSettings,
  BatchTestResult,
  ScanResult,
  SessionRepairPreview,
  SessionRepairResult,
  SwitchResult
} from './types'

export interface TestProgress {
  active: boolean
  done: number
  total: number
}

export interface AppSnapshot {
  accounts: AccountSummary[]
  settings: AppSettings
  testing: TestProgress
}

export interface RestartResult {
  ok: boolean
  message: string
}

export interface CodexSwitcherApi {
  getSnapshot(): Promise<AppSnapshot>
  scanDirectory(): Promise<ScanResult>
  importFiles(): Promise<ScanResult | null>
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
  onTestProgress(listener: (progress: TestProgress) => void): () => void
}

export const ipcChannels = {
  snapshot: 'app:snapshot',
  scan: 'accounts:scan',
  import: 'accounts:import',
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
  testProgress: 'accounts:test-progress'
} as const
