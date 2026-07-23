import { contextBridge, ipcRenderer } from 'electron'
import type {
  AccountStatusSyncPatch,
  CodexSwitcherApi,
  CpaCodexTestProgress,
  GrokTestProgress,
  ImportPreviewTestProgress,
  SessionRepairProgress,
  TestProgress,
  UpdateState
} from '../shared/ipc'
import type { AutoSwitchState } from '../shared/types'
import { ipcChannels } from '../shared/ipc'

const api: CodexSwitcherApi = {
  getSnapshot: () => ipcRenderer.invoke(ipcChannels.snapshot),
  getPageSnapshot: (scope) => ipcRenderer.invoke(ipcChannels.snapshotPage, scope),
  scanDirectory: () => ipcRenderer.invoke(ipcChannels.scan),
  importFiles: () => ipcRenderer.invoke(ipcChannels.import),
  importDirectory: () => ipcRenderer.invoke(ipcChannels.importDirectory),
  importPasted: (text) => ipcRenderer.invoke(ipcChannels.importPasted, text),
  importAnyFiles: () => ipcRenderer.invoke(ipcChannels.importAny),
  importAnyDirectory: () => ipcRenderer.invoke(ipcChannels.importAnyDirectory),
  importAnyPasted: (text) => ipcRenderer.invoke(ipcChannels.importAnyPasted, text),
  previewAnyFiles: () => ipcRenderer.invoke(ipcChannels.importPreviewFiles),
  previewAnyDirectory: () => ipcRenderer.invoke(ipcChannels.importPreviewDirectory),
  previewAnyPasted: (text) => ipcRenderer.invoke(ipcChannels.importPreviewPasted, text),
  previewRefreshTokens: (text, mode) =>
    ipcRenderer.invoke(ipcChannels.importPreviewRefreshTokens, { text, mode }),
  previewOAuthComplete: (sessionId, callbackInput) =>
    ipcRenderer.invoke(ipcChannels.importPreviewOAuthComplete, { sessionId, callbackInput }),
  commitImportPreview: (request) => ipcRenderer.invoke(ipcChannels.importPreviewCommit, request),
  refineImportPreview: (request) => ipcRenderer.invoke(ipcChannels.importPreviewRefine, request),
  testImportPreview: (request) => ipcRenderer.invoke(ipcChannels.importPreviewTest, request),
  cancelImportPreviewTests: () => ipcRenderer.invoke(ipcChannels.importPreviewCancelTest),
  discardImportPreview: (sessionId) => ipcRenderer.invoke(ipcChannels.importPreviewDiscard, sessionId),
  importRefreshTokens: (text, mode) => ipcRenderer.invoke(ipcChannels.importRefreshTokens, { text, mode }),
  startOAuthAuthorization: () => ipcRenderer.invoke(ipcChannels.oauthStart),
  completeOAuthAuthorization: (sessionId, callbackInput) =>
    ipcRenderer.invoke(ipcChannels.oauthComplete, { sessionId, callbackInput }),
  deleteAccounts: (ids) => ipcRenderer.invoke(ipcChannels.deleteAccounts, ids),
  updateAccountMetadata: (request) => ipcRenderer.invoke(ipcChannels.accountMetadataUpdate, request),
  inspectLibraries: () => ipcRenderer.invoke(ipcChannels.libraryHealthInspect),
  repairLibraries: (snapshotId, issueIds) =>
    ipcRenderer.invoke(ipcChannels.libraryHealthRepair, { snapshotId, issueIds }),
  exportAccounts: (request) => ipcRenderer.invoke(ipcChannels.exportAccounts, request),
  exportAccountsToCpa: (request) => ipcRenderer.invoke(ipcChannels.exportAccountsToCpa, request),
  testAccounts: (ids, mode) => ipcRenderer.invoke(ipcChannels.test, { ids, mode: mode ?? 'full' }),
  cancelTests: () => ipcRenderer.invoke(ipcChannels.cancelTest),
  switchAccount: (id, restart) =>
    ipcRenderer.invoke(ipcChannels.switchAccount, { id, restart }),
  restoreLatest: (restart) => ipcRenderer.invoke(ipcChannels.restore, { restart }),
  restoreApiMode: (restart) => ipcRenderer.invoke(ipcChannels.restoreApiMode, { restart }),
  switchToCustomApi: (profile, restart) => ipcRenderer.invoke(ipcChannels.customApiSwitch, { profile, restart }),
  getCustomApiProfile: () => ipcRenderer.invoke(ipcChannels.customApiProfile),
  listCustomApiModels: (input) => ipcRenderer.invoke(ipcChannels.customApiListModels, input),
  scanGrokDirectory: () => ipcRenderer.invoke(ipcChannels.grokScan),
  importGrokFiles: () => ipcRenderer.invoke(ipcChannels.grokImport),
  importGrokDirectory: () => ipcRenderer.invoke(ipcChannels.grokImportDirectory),
  importGrokPasted: (text) => ipcRenderer.invoke(ipcChannels.grokImportPasted, text),
  deleteGrokAccounts: (ids) => ipcRenderer.invoke(ipcChannels.grokDelete, ids),
  testGrokAccounts: (ids) => ipcRenderer.invoke(ipcChannels.grokTest, ids),
  cancelGrokTests: () => ipcRenderer.invoke(ipcChannels.grokCancelTest),
  exportGrokAccounts: (ids, layout) => ipcRenderer.invoke(ipcChannels.grokExport, { ids, layout }),
  exportGrokAccountsToCpa: (ids) => ipcRenderer.invoke(ipcChannels.grokExportToCpa, ids),
  scanCpaGrokDirectory: () => ipcRenderer.invoke(ipcChannels.cpaGrokScan),
  syncCpaGrokToLibrary: (ids) => ipcRenderer.invoke(ipcChannels.cpaGrokSyncToLibrary, ids),
  deleteCpaGrokAccounts: (ids) => ipcRenderer.invoke(ipcChannels.cpaGrokDelete, ids),
  testCpaGrokAccounts: (ids) => ipcRenderer.invoke(ipcChannels.cpaGrokTest, ids),
  cancelCpaGrokTests: () => ipcRenderer.invoke(ipcChannels.cpaGrokCancelTest),
  setCpaGrokEnabled: (ids, enabled) => ipcRenderer.invoke(ipcChannels.cpaGrokSetEnabled, { ids, enabled }),
  scanCpaCodexDirectory: () => ipcRenderer.invoke(ipcChannels.cpaCodexScan),
  syncCpaCodexToLibrary: (ids) => ipcRenderer.invoke(ipcChannels.cpaCodexSyncToLibrary, ids),
  testCpaCodexAccounts: (ids, mode) =>
    ipcRenderer.invoke(ipcChannels.cpaCodexTest, { ids, mode: mode ?? 'full' }),
  cancelCpaCodexTests: () => ipcRenderer.invoke(ipcChannels.cpaCodexCancelTest),
  deleteCpaCodexAccounts: (ids) => ipcRenderer.invoke(ipcChannels.cpaCodexDelete, ids),
  setCpaCodexEnabled: (ids, enabled) => ipcRenderer.invoke(ipcChannels.cpaCodexSetEnabled, { ids, enabled }),
  setGrokEnabled: (ids, enabled) => ipcRenderer.invoke(ipcChannels.grokSetEnabled, { ids, enabled }),
  restartCodex: () => ipcRenderer.invoke(ipcChannels.restart),
  updateSettings: (patch) => ipcRenderer.invoke(ipcChannels.settingsUpdate, patch),
  chooseAccountDirectory: () => ipcRenderer.invoke(ipcChannels.settingsChooseDirectory),
  chooseGrokDirectory: () => ipcRenderer.invoke(ipcChannels.settingsChooseGrokDirectory),
  revealSource: (id) => ipcRenderer.invoke(ipcChannels.revealSource, id),
  revealManagedSource: (scope, id) => ipcRenderer.invoke(ipcChannels.revealManagedSource, { scope, id }),
  listConversations: (query) => ipcRenderer.invoke(ipcChannels.conversationList, query ?? {}),
  getConversation: (id) => ipcRenderer.invoke(ipcChannels.conversationDetail, id),
  revealConversation: (id) => ipcRenderer.invoke(ipcChannels.conversationReveal, id),
  deleteConversations: (ids) => ipcRenderer.invoke(ipcChannels.conversationDelete, ids),
  previewSafeConversationCleanup: () => ipcRenderer.invoke(ipcChannels.conversationCleanupPreview),
  cleanupSafeConversations: () => ipcRenderer.invoke(ipcChannels.conversationCleanup),
  previewSessionRepair: (targetProvider, threadIds) =>
    ipcRenderer.invoke(ipcChannels.sessionRepairPreview, { targetProvider, threadIds }),
  applySessionRepair: (snapshotId, targetProvider, threadIds) =>
    ipcRenderer.invoke(ipcChannels.sessionRepairApply, { snapshotId, targetProvider, threadIds }),
  getUpdateState: () => ipcRenderer.invoke(ipcChannels.updateGetState),
  checkForUpdates: () => ipcRenderer.invoke(ipcChannels.updateCheck),
  downloadUpdate: () => ipcRenderer.invoke(ipcChannels.updateDownload),
  installUpdate: () => ipcRenderer.invoke(ipcChannels.updateInstall),
  runAutoSwitchNow: () => ipcRenderer.invoke(ipcChannels.autoSwitchRun),
  onTestProgress: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: TestProgress): void => listener(progress)
    ipcRenderer.on(ipcChannels.testProgress, wrapped)
    return () => ipcRenderer.removeListener(ipcChannels.testProgress, wrapped)
  },
  onGrokTestProgress: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: GrokTestProgress): void => listener(progress)
    ipcRenderer.on(ipcChannels.grokTestProgress, wrapped)
    return () => ipcRenderer.removeListener(ipcChannels.grokTestProgress, wrapped)
  },
  onCpaGrokTestProgress: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: GrokTestProgress): void => listener(progress)
    ipcRenderer.on(ipcChannels.cpaGrokTestProgress, wrapped)
    return () => ipcRenderer.removeListener(ipcChannels.cpaGrokTestProgress, wrapped)
  },
  onCpaCodexTestProgress: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: CpaCodexTestProgress): void => listener(progress)
    ipcRenderer.on(ipcChannels.cpaCodexTestProgress, wrapped)
    return () => ipcRenderer.removeListener(ipcChannels.cpaCodexTestProgress, wrapped)
  },
  onAccountStatusSync: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, patch: AccountStatusSyncPatch): void => listener(patch)
    ipcRenderer.on(ipcChannels.accountStatusSync, wrapped)
    return () => ipcRenderer.removeListener(ipcChannels.accountStatusSync, wrapped)
  },
  onImportPreviewTestProgress: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: ImportPreviewTestProgress): void => listener(progress)
    ipcRenderer.on(ipcChannels.importPreviewTestProgress, wrapped)
    return () => ipcRenderer.removeListener(ipcChannels.importPreviewTestProgress, wrapped)
  },
  onSessionRepairProgress: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: SessionRepairProgress): void => listener(progress)
    ipcRenderer.on(ipcChannels.sessionRepairProgress, wrapped)
    return () => ipcRenderer.removeListener(ipcChannels.sessionRepairProgress, wrapped)
  },
  onUpdateState: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: UpdateState): void => listener(state)
    ipcRenderer.on(ipcChannels.updateState, wrapped)
    return () => ipcRenderer.removeListener(ipcChannels.updateState, wrapped)
  },
  onAutoSwitchState: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: AutoSwitchState): void => listener(state)
    ipcRenderer.on(ipcChannels.autoSwitchState, wrapped)
    return () => ipcRenderer.removeListener(ipcChannels.autoSwitchState, wrapped)
  }
}

contextBridge.exposeInMainWorld('codexSwitcher', api)
