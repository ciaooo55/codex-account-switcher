import { contextBridge, ipcRenderer } from 'electron'
import type { CodexSwitcherApi, CpaCodexTestProgress, GrokTestProgress, TestProgress, UpdateState } from '../shared/ipc'
import type { AutoSwitchState } from '../shared/types'
import { ipcChannels } from '../shared/ipc'

const api: CodexSwitcherApi = {
  getSnapshot: () => ipcRenderer.invoke(ipcChannels.snapshot),
  scanDirectory: () => ipcRenderer.invoke(ipcChannels.scan),
  importFiles: () => ipcRenderer.invoke(ipcChannels.import),
  importDirectory: () => ipcRenderer.invoke(ipcChannels.importDirectory),
  importPasted: (text) => ipcRenderer.invoke(ipcChannels.importPasted, text),
  importAnyFiles: () => ipcRenderer.invoke(ipcChannels.importAny),
  importAnyDirectory: () => ipcRenderer.invoke(ipcChannels.importAnyDirectory),
  importAnyPasted: (text) => ipcRenderer.invoke(ipcChannels.importAnyPasted, text),
  deleteAccounts: (ids) => ipcRenderer.invoke(ipcChannels.deleteAccounts, ids),
  exportAccounts: (request) => ipcRenderer.invoke(ipcChannels.exportAccounts, request),
  exportAccountsToCpa: (ids) => ipcRenderer.invoke(ipcChannels.exportAccountsToCpa, ids),
  testAccounts: (ids) => ipcRenderer.invoke(ipcChannels.test, ids),
  cancelTests: () => ipcRenderer.invoke(ipcChannels.cancelTest),
  switchAccount: (id, restart) =>
    ipcRenderer.invoke(ipcChannels.switchAccount, { id, restart }),
  restoreLatest: (restart) => ipcRenderer.invoke(ipcChannels.restore, { restart }),
  restoreApiMode: (restart) => ipcRenderer.invoke(ipcChannels.restoreApiMode, { restart }),
  switchToCustomApi: (profile, restart) => ipcRenderer.invoke(ipcChannels.customApiSwitch, { profile, restart }),
  getCustomApiProfile: () => ipcRenderer.invoke(ipcChannels.customApiProfile),
  scanGrokDirectory: () => ipcRenderer.invoke(ipcChannels.grokScan),
  importGrokFiles: () => ipcRenderer.invoke(ipcChannels.grokImport),
  importGrokDirectory: () => ipcRenderer.invoke(ipcChannels.grokImportDirectory),
  importGrokPasted: (text) => ipcRenderer.invoke(ipcChannels.grokImportPasted, text),
  deleteGrokAccounts: (ids) => ipcRenderer.invoke(ipcChannels.grokDelete, ids),
  testGrokAccounts: (ids) => ipcRenderer.invoke(ipcChannels.grokTest, ids),
  cancelGrokTests: () => ipcRenderer.invoke(ipcChannels.grokCancelTest),
  exportGrokAccounts: (ids, layout) => ipcRenderer.invoke(ipcChannels.grokExport, { ids, layout }),
  scanCpaCodexDirectory: () => ipcRenderer.invoke(ipcChannels.cpaCodexScan),
  testCpaCodexAccounts: (ids) => ipcRenderer.invoke(ipcChannels.cpaCodexTest, ids),
  cancelCpaCodexTests: () => ipcRenderer.invoke(ipcChannels.cpaCodexCancelTest),
  deleteCpaCodexAccounts: (ids) => ipcRenderer.invoke(ipcChannels.cpaCodexDelete, ids),
  setCpaCodexEnabled: (ids, enabled) => ipcRenderer.invoke(ipcChannels.cpaCodexSetEnabled, { ids, enabled }),
  setGrokEnabled: (ids, enabled) => ipcRenderer.invoke(ipcChannels.grokSetEnabled, { ids, enabled }),
  restartCodex: () => ipcRenderer.invoke(ipcChannels.restart),
  updateSettings: (patch) => ipcRenderer.invoke(ipcChannels.settingsUpdate, patch),
  chooseAccountDirectory: () => ipcRenderer.invoke(ipcChannels.settingsChooseDirectory),
  chooseGrokDirectory: () => ipcRenderer.invoke(ipcChannels.settingsChooseGrokDirectory),
  revealSource: (id) => ipcRenderer.invoke(ipcChannels.revealSource, id),
  previewSessionRepair: (targetProvider) =>
    ipcRenderer.invoke(ipcChannels.sessionRepairPreview, targetProvider),
  applySessionRepair: (snapshotId, targetProvider) =>
    ipcRenderer.invoke(ipcChannels.sessionRepairApply, { snapshotId, targetProvider }),
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
  onCpaCodexTestProgress: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: CpaCodexTestProgress): void => listener(progress)
    ipcRenderer.on(ipcChannels.cpaCodexTestProgress, wrapped)
    return () => ipcRenderer.removeListener(ipcChannels.cpaCodexTestProgress, wrapped)
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
