import { contextBridge, ipcRenderer } from 'electron'
import type { CodexSwitcherApi, TestProgress } from '../shared/ipc'
import { ipcChannels } from '../shared/ipc'

const api: CodexSwitcherApi = {
  getSnapshot: () => ipcRenderer.invoke(ipcChannels.snapshot),
  scanDirectory: () => ipcRenderer.invoke(ipcChannels.scan),
  importFiles: () => ipcRenderer.invoke(ipcChannels.import),
  testAccounts: (ids) => ipcRenderer.invoke(ipcChannels.test, ids),
  cancelTests: () => ipcRenderer.invoke(ipcChannels.cancelTest),
  switchAccount: (id, restart) =>
    ipcRenderer.invoke(ipcChannels.switchAccount, { id, restart }),
  restoreLatest: (restart) => ipcRenderer.invoke(ipcChannels.restore, { restart }),
  restoreApiMode: (restart) => ipcRenderer.invoke(ipcChannels.restoreApiMode, { restart }),
  restartCodex: () => ipcRenderer.invoke(ipcChannels.restart),
  updateSettings: (patch) => ipcRenderer.invoke(ipcChannels.settingsUpdate, patch),
  chooseAccountDirectory: () => ipcRenderer.invoke(ipcChannels.settingsChooseDirectory),
  revealSource: (id) => ipcRenderer.invoke(ipcChannels.revealSource, id),
  previewSessionRepair: (targetProvider) =>
    ipcRenderer.invoke(ipcChannels.sessionRepairPreview, targetProvider),
  applySessionRepair: (snapshotId, targetProvider) =>
    ipcRenderer.invoke(ipcChannels.sessionRepairApply, { snapshotId, targetProvider }),
  onTestProgress: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: TestProgress): void => listener(progress)
    ipcRenderer.on(ipcChannels.testProgress, wrapped)
    return () => ipcRenderer.removeListener(ipcChannels.testProgress, wrapped)
  }
}

contextBridge.exposeInMainWorld('codexSwitcher', api)
