import { mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  safeStorage,
  shell,
  Tray
} from 'electron'
import electronUpdater from 'electron-updater'
import { z } from 'zod'
import { ipcChannels, type GrokTestProgress, type TestProgress, type UpdateState } from '../shared/ipc'
import type { AppSettings, AutoSwitchState, SecretCipher } from '../shared/types'
import { AccountManager } from './services/account-manager'
import { AutoSwitchScheduler } from './services/auto-switch'
import { discoverCodexPaths, normalizeSelectedCodexDirectory } from './services/codex-paths'
import { CodexProcessManager } from './services/codex-process'
import { CredentialTester } from './services/detector'
import { CredentialExportService } from './services/exporter'
import { GrokAccountManager } from './services/grok-account-manager'
import { GrokCredentialTester } from './services/grok-detector'
import { SessionRepairService } from './services/session-repair'
import {
  cleanupLegacyUpdateCache,
  downloadInstaller,
  launchInstallerAndDelete
} from './services/update-installer'
import { SettingsStore } from './storage/settings'
import { StatusStore } from './storage/status-store'
import { DeletedCredentialStore } from './storage/deleted-credentials'
import { CredentialVault } from './storage/vault'
import { CustomApiStore } from './storage/custom-api-store'
import { GrokStatusStore } from './storage/grok-status-store'
import { CredentialSwitcher } from './switching/switcher'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const { autoUpdater } = electronUpdater
const e2eMode = !app.isPackaged && process.env.CODEX_SWITCHER_E2E === '1'
if (e2eMode && process.env.CODEX_SWITCHER_USER_DATA) {
  app.setPath('userData', resolve(process.env.CODEX_SWITCHER_USER_DATA))
}
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let applicationInitialized = false
let isQuitting = false
let trayBackgroundHintShown = false
let switchOperationActive = false
let accountLibraryOperationActive = false
let autoSwitchOperationActive = false
let testController: AbortController | null = null
let grokTestController: AbortController | null = null
let progress: TestProgress = {
  active: false,
  done: 0,
  total: 0,
  runningIds: [],
  updatedAccount: null
}
let grokProgress: GrokTestProgress = {
  active: false,
  done: 0,
  total: 0,
  runningIds: [],
  updatedAccount: null
}
let updateState: UpdateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  availableVersion: null,
  percent: null,
  message: '尚未检查更新'
}

const INSTALL_QUIT_ARGUMENT = '--quit-for-install'

function createCipher(): SecretCipher {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows 凭据加密不可用，应用不会以明文保存账号')
  }
  return {
    encrypt: (plainText) => safeStorage.encryptString(plainText).toString('base64'),
    decrypt: (encryptedText) =>
      safeStorage.decryptString(Buffer.from(encryptedText, 'base64'))
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#111418',
    title: 'Codex Account Switcher',
    webPreferences: {
      preload: join(currentDirectory, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(currentDirectory, '../renderer/index.html'))
  }
  return window
}

function showTrayMessage(title: string, content: string): void {
  if (!tray || tray.isDestroyed() || isQuitting) return
  tray.displayBalloon({
    title,
    content: content.length > 240 ? `${content.slice(0, 237)}...` : content,
    iconType: 'info',
    noSound: true
  })
}

function attachWindowLifecycle(window: BrowserWindow): void {
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
    if (!isQuitting && !trayBackgroundHintShown) {
      trayBackgroundHintShown = true
      showTrayMessage('已转入后台', '主界面已释放，托盘和定时自动切换仍在运行')
    }
  })
}

function showMainWindow(): void {
  if (!applicationInitialized) return
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow()
    attachWindowLifecycle(mainWindow)
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

async function main(): Promise<void> {
  await cleanupLegacyUpdateCache(process.env.LOCALAPPDATA).catch(() => undefined)
  const userData = app.getPath('userData')
  const homeDirectory = homedir()
  const cipher = createCipher()
  const settingsStore = new SettingsStore(join(userData, 'settings.json'), homeDirectory)
  let initialSettings = await settingsStore.get()
  if (e2eMode) {
    initialSettings = await settingsStore.update({
      grokDirectory: join(userData, 'grok-accounts')
    })
  }
  let codexPaths = await discoverCodexPaths({
    homeDirectory,
    configuredAuthPath: initialSettings.authPath,
    configuredConfigPath: initialSettings.configPath
  })
  if (!codexPaths) {
    const selected = await dialog.showOpenDialog({
      title: '未找到 Codex 配置目录，请选择或创建 .codex 文件夹',
      defaultPath: homeDirectory,
      buttonLabel: '使用此目录',
      properties: ['openDirectory', 'createDirectory']
    })
    const codexDirectory = selected.canceled
      ? join(homeDirectory, '.codex')
      : await normalizeSelectedCodexDirectory(selected.filePaths[0])
    codexPaths = {
      authPath: join(codexDirectory, 'auth.json'),
      configPath: join(codexDirectory, 'config.toml')
    }
  }
  await Promise.all([
    mkdir(dirname(codexPaths.authPath), { recursive: true }),
    mkdir(dirname(codexPaths.configPath), { recursive: true })
  ])
  if (
    resolve(initialSettings.authPath) !== resolve(codexPaths.authPath) ||
    resolve(initialSettings.configPath) !== resolve(codexPaths.configPath)
  ) {
    await settingsStore.update({
      authPath: codexPaths.authPath,
      configPath: codexPaths.configPath
    })
  }
  const vault = new CredentialVault(join(userData, 'vault.json'), cipher)
  const customApiStore = new CustomApiStore(join(userData, 'custom-api.json'), cipher)
  const statusStore = new StatusStore(join(userData, 'status.json'))
  const grokStatusStore = new GrokStatusStore(join(userData, 'grok-status.json'))
  const deletedStore = new DeletedCredentialStore(join(userData, 'deleted-accounts.json'))
  const applicationDirectory = e2eMode
    ? userData
    : app.isPackaged
      ? resolve(process.env.PORTABLE_EXECUTABLE_DIR ?? dirname(process.execPath))
      : resolve(currentDirectory, '../..')
  const importDirectory = join(applicationDirectory, 'aa')
  const legacyImportDirectories = [...new Set(e2eMode
    ? [join(userData, 'imports'), join(userData, 'aa')]
    : app.isPackaged
      ? [
        join(userData, 'imports'),
        join(userData, 'aa'),
        join(app.getPath('appData'), 'Codex Account Switcher', 'aa')
      ]
      : [])]
  const processManager = new CodexProcessManager()
  let testApiBase: string | null = null
  if (e2eMode && process.env.CODEX_SWITCHER_TEST_API_BASE_URL) {
    const parsed = new URL(process.env.CODEX_SWITCHER_TEST_API_BASE_URL)
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
      throw new Error('E2E API 仅允许本机回环地址')
    }
    testApiBase = parsed.toString().replace(/\/$/, '')
  }

  const tester = {
    test: async (credential: Parameters<CredentialTester['test']>[0], signal?: AbortSignal) => {
      const settings = await settingsStore.get()
      return new CredentialTester({
        timeoutMs: settings.timeoutMs,
        deepTestModel: settings.deepTestModel,
        ...(testApiBase
          ? {
              compactUrl: `${testApiBase}/compact`,
              usageUrl: `${testApiBase}/usage`,
              refreshUrl: `${testApiBase}/oauth/token`
            }
          : {}),
        onCredentialUpdated: (updated) => vault.upsertMany([updated])
      }).test(credential, signal)
    }
  }
  const switcher = {
    switchTo: async (credential: Parameters<CredentialSwitcher['switchTo']>[0]) => {
      const settings = await settingsStore.get()
      return new CredentialSwitcher({
        authPath: settings.authPath,
        configPath: settings.configPath,
        backupDir: join(userData, 'backups'),
        backupRetention: settings.backupRetention,
        cipher
      }).switchTo(credential)
    },
    restoreLatest: async () => {
      const settings = await settingsStore.get()
      return new CredentialSwitcher({
        authPath: settings.authPath,
        configPath: settings.configPath,
        backupDir: join(userData, 'backups'),
        backupRetention: settings.backupRetention,
        cipher
      }).restoreLatest()
    },
    restoreApiMode: async () => {
      const settings = await settingsStore.get()
      return new CredentialSwitcher({
        authPath: settings.authPath,
        configPath: settings.configPath,
        backupDir: join(userData, 'backups'),
        backupRetention: settings.backupRetention,
        cipher
      }).restoreApiMode()
    },
    switchToCustomApi: async (input: { baseUrl: string; model: string; apiKey: string }) => {
      const settings = await settingsStore.get()
      return new CredentialSwitcher({
        authPath: settings.authPath,
        configPath: settings.configPath,
        backupDir: join(userData, 'backups'),
        backupRetention: settings.backupRetention,
        cipher
      }).switchToCustomApi(input)
    }
  }
  const manager = new AccountManager({
    settings: () => settingsStore.get(),
    vault,
    statusStore,
    tester,
    switcher,
    managedImportDirectory: importDirectory,
    deletedStore
  })
  const exporter = new CredentialExportService({ vault })
  let grokManager: GrokAccountManager
  grokManager = new GrokAccountManager({
    directory: async () => (await settingsStore.get()).grokDirectory,
    concurrency: async () => (await settingsStore.get()).concurrency,
    statusStore: grokStatusStore,
    tester: {
      test: async (credential, signal) => {
        const settings = await settingsStore.get()
        return new GrokCredentialTester({
          timeoutMs: settings.timeoutMs,
          ...(testApiBase ? { cliBaseUrl: `${testApiBase}/grok` } : {}),
          onCredentialUpdated: (updated) => grokManager.upsertRefreshed(updated)
        }).test(credential, signal)
      }
    }
  })

  const pruneAutoSwitchPool = async (): Promise<boolean> => {
    const settings = await settingsStore.get()
    const available = new Set(
      (await manager.listAccounts())
        .filter((account) => account.switchable)
        .map((account) => account.id)
    )
    const autoSwitchAccountIds = settings.autoSwitchAccountIds.filter((id) => available.has(id))
    const poolChanged = autoSwitchAccountIds.length !== settings.autoSwitchAccountIds.length
    const disableEmptyPool = settings.autoSwitchEnabled && autoSwitchAccountIds.length === 0
    if (!poolChanged && !disableEmptyPool) return false
    await settingsStore.update({
      autoSwitchAccountIds,
      ...(disableEmptyPool ? { autoSwitchEnabled: false } : {})
    })
    return true
  }

  const assertAccountLibraryIdle = (): void => {
    if (testController) throw new Error('账号检测进行中，暂时不能修改账号库')
    if (switchOperationActive) throw new Error('账号切换或恢复进行中，暂时不能修改账号库')
    if (accountLibraryOperationActive) throw new Error('已有账号导入、扫描或删除操作正在执行')
    if (autoSwitchOperationActive) throw new Error('自动检测或切换正在执行，暂时不能修改账号库')
  }

  const runAccountLibraryMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertAccountLibraryIdle()
    accountLibraryOperationActive = true
    try {
      const result = await operation()
      await pruneAutoSwitchPool()
      return result
    } finally {
      accountLibraryOperationActive = false
    }
  }

  const initialScan = runAccountLibraryMutation(async () => {
    let managedLibraryExists = false
    try {
      managedLibraryExists = (await stat(importDirectory)).isDirectory()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!managedLibraryExists) {
      for (const directory of legacyImportDirectories) {
        await manager.migrateManagedDirectory(directory)
      }
    }
    return manager.scanDirectory()
  })
  const initialGrokScan = grokManager.scanDirectory().catch(() => null)

  const sessionRepairService = async (): Promise<SessionRepairService> => {
    const settings = await settingsStore.get()
    return new SessionRepairService({
      codexHome: dirname(settings.configPath),
      backupRetention: settings.backupRetention
    })
  }

  const sendProgress = (next: TestProgress): void => {
    progress = next
    mainWindow?.webContents.send(ipcChannels.testProgress, progress)
  }

  const sendGrokProgress = (next: GrokTestProgress): void => {
    grokProgress = next
    mainWindow?.webContents.send(ipcChannels.grokTestProgress, grokProgress)
  }

  const sendUpdateState = (next: UpdateState): void => {
    updateState = next
    mainWindow?.webContents.send(ipcChannels.updateState, updateState)
  }

  let rebuildTrayMenu: () => Promise<void> = async () => undefined
  let previousAutoSwitchState: AutoSwitchState | null = null
  const autoSwitchScheduler = new AutoSwitchScheduler({
    getSettings: () => settingsStore.get(),
    execute: async () => {
      if (testController || switchOperationActive || accountLibraryOperationActive || autoSwitchOperationActive) {
        throw new Error('其他账号任务正在运行，本次自动检查已跳过')
      }
      autoSwitchOperationActive = true
      const settings = await settingsStore.get()
      sendProgress({ active: true, done: 0, total: settings.autoSwitchAccountIds.length + 1, runningIds: [], updatedAccount: null })
      try {
        const result = await manager.autoSwitch(settings.autoSwitchAccountIds, ({ done, total, runningIds, updatedAccount }) => {
          sendProgress({ active: true, done, total, runningIds, updatedAccount: updatedAccount ?? null })
        })
        if (result.switched && settings.autoSwitchRestartCodex) {
          const restarted = await processManager.restart()
          return {
            ...result,
            ok: result.ok && restarted.ok,
            message: `${result.message}；${restarted.message}`
          }
        }
        return result
      } finally {
        autoSwitchOperationActive = false
        sendProgress({ ...progress, active: false, runningIds: [], updatedAccount: null })
      }
    },
    onState: (state) => {
      mainWindow?.webContents.send(ipcChannels.autoSwitchState, state)
      if (previousAutoSwitchState?.running && !state.running && !isQuitting) {
        showTrayMessage(
          state.lastSwitchedAccountId ? '自动切换完成' : '后台检查完成',
          state.lastMessage
        )
      }
      previousAutoSwitchState = state
      void rebuildTrayMenu()
    }
  })

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  let availableUpdate: { version: string; expectedSha512: string } | null = null
  let downloadedInstallerPath: string | null = null
  autoUpdater.on('checking-for-update', () => {
    sendUpdateState({
      ...updateState,
      status: 'checking',
      percent: null,
      message: '正在检查更新'
    })
  })
  autoUpdater.on('update-available', (info) => {
    const setupFile = info.files.find((file) => /setup.*\.exe$/i.test(String(file.url)))
      ?? info.files.find((file) => /\.exe$/i.test(String(file.url)))
    availableUpdate = setupFile
      ? { version: info.version, expectedSha512: setupFile.sha512 }
      : null
    downloadedInstallerPath = null
    sendUpdateState({
      status: 'available',
      currentVersion: app.getVersion(),
      availableVersion: info.version,
      percent: null,
      message: `发现新版本 ${info.version}`
    })
  })
  autoUpdater.on('update-not-available', () => {
    availableUpdate = null
    downloadedInstallerPath = null
    sendUpdateState({
      status: 'not_available',
      currentVersion: app.getVersion(),
      availableVersion: null,
      percent: null,
      message: '当前已是最新版本'
    })
  })
  autoUpdater.on('error', () => {
    sendUpdateState({
      ...updateState,
      status: 'error',
      percent: null,
      message: '更新检查或下载失败，请稍后重试'
    })
  })

  let updateCheckPromise: Promise<UpdateState> | null = null
  let updateDownloadPromise: Promise<void> | null = null
  const checkForUpdates = (): Promise<UpdateState> => {
    if (updateCheckPromise) return updateCheckPromise
    updateCheckPromise = (async () => {
      if (!app.isPackaged || e2eMode) {
        sendUpdateState({
          status: 'not_available',
          currentVersion: app.getVersion(),
          availableVersion: null,
          percent: null,
          message: '开发环境不执行自动更新'
        })
        return updateState
      }
      await autoUpdater.checkForUpdates()
      return updateState
    })().finally(() => {
      updateCheckPromise = null
    })
    return updateCheckPromise
  }

  ipcMain.handle(ipcChannels.snapshot, async () => {
    await Promise.all([initialScan, initialGrokScan])
    const settings = await settingsStore.get()
    return {
      accounts: await manager.listAccounts(),
      settings,
      importDirectory,
      testing: progress,
      autoSwitch: autoSwitchScheduler.getState(),
      grokAccounts: await grokManager.listAccounts(),
      grokDirectory: settings.grokDirectory,
      grokTesting: grokProgress,
      customApi: await customApiStore.summary({ baseUrl: settings.customApiBaseUrl, model: settings.customApiModel })
    }
  })
  ipcMain.handle(ipcChannels.scan, () => {
    return runAccountLibraryMutation(() => manager.scanDirectory())
  })
  ipcMain.handle(ipcChannels.import, async () => {
    return runAccountLibraryMutation(async () => {
      const result = await dialog.showOpenDialog({
        title: '导入 Codex 账号文件',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '账号文件', extensions: ['json', 'jsonl', 'txt', 'md', 'js', 'mjs', 'cjs', 'zip'] }]
      })
      return result.canceled
        ? null
        : manager.importFiles(result.filePaths, { archiveSources: true })
    })
  })
  ipcMain.handle(ipcChannels.importDirectory, async () => {
    return runAccountLibraryMutation(async () => {
      let directory: string | null = null
      if (e2eMode && process.env.CODEX_SWITCHER_E2E_IMPORT_DIR) {
        directory = resolve(process.env.CODEX_SWITCHER_E2E_IMPORT_DIR)
      } else {
        const settings = await settingsStore.get()
        const result = await dialog.showOpenDialog({
          title: '导入文件夹内的全部账号文件',
          defaultPath: settings.accountDirectory,
          properties: ['openDirectory']
        })
        if (!result.canceled) directory = result.filePaths[0]
      }
      return directory ? manager.importDirectory(directory) : null
    })
  })
  ipcMain.handle(ipcChannels.importPasted, (_event, input: unknown) => {
    const text = z.string().min(1).max(100 * 1024 * 1024).parse(input)
    return runAccountLibraryMutation(() => manager.importPasted(text))
  })
  ipcMain.handle(ipcChannels.deleteAccounts, async (_event, input: unknown) => {
    const ids = z.array(z.string().min(1)).min(1).max(20_000).parse(input)
    const result = await runAccountLibraryMutation(() => manager.deleteAccounts(ids))
    await autoSwitchScheduler.settingsChanged()
    return result
  })
  ipcMain.handle(ipcChannels.exportAccounts, async (_event, input: unknown) => {
    const payload = z
      .object({
        accountIds: z.array(z.string().min(1)).min(1).max(20_000),
        format: z.enum(['cpa', 'sub2api']),
        layout: z.enum(['separate', 'bundle'])
      })
      .parse(input)
    let outputDirectory: string
    if (e2eMode && process.env.CODEX_SWITCHER_E2E_EXPORT_DIR) {
      outputDirectory = resolve(process.env.CODEX_SWITCHER_E2E_EXPORT_DIR)
    } else {
      const settings = await settingsStore.get()
      const selected = await dialog.showOpenDialog({
        title: '选择账号导出目录',
        defaultPath: settings.accountDirectory,
        properties: ['openDirectory', 'createDirectory']
      })
      if (selected.canceled) {
        return {
          ok: false,
          cancelled: true,
          exported: 0,
          files: [],
          errors: [],
          message: '已取消导出'
        }
      }
      outputDirectory = selected.filePaths[0]
    }
    return exporter.exportAccounts({ ...payload, outputDirectory })
  })
  ipcMain.handle(ipcChannels.test, async (_event, input: unknown) => {
    if (testController) throw new Error('已有检测任务正在运行')
    if (switchOperationActive) throw new Error('账号切换或恢复进行中，暂时不能检测账号')
    if (accountLibraryOperationActive) throw new Error('账号库正在导入、扫描或删除，暂时不能检测账号')
    if (autoSwitchOperationActive) throw new Error('自动检测或切换正在运行')
    const ids = z.array(z.string().min(1)).optional().parse(input)
    testController = new AbortController()
    sendProgress({
      active: true,
      done: 0,
      total: ids?.length ?? (await manager.listAccounts()).length,
      runningIds: [],
      updatedAccount: null
    })
    try {
      return await manager.testAccounts(ids, {
        signal: testController.signal,
        onProgress: ({ done, total, runningIds, updatedAccount }) =>
          sendProgress({
            active: true,
            done,
            total,
            runningIds,
            updatedAccount: updatedAccount ?? null
          })
      })
    } finally {
      testController = null
      sendProgress({ ...progress, active: false, runningIds: [], updatedAccount: null })
    }
  })
  ipcMain.handle(ipcChannels.cancelTest, () => {
    testController?.abort()
  })
  ipcMain.handle(ipcChannels.switchAccount, async (_event, input: unknown) => {
    if (testController) {
      return { ok: false, message: '账号检测进行中，暂时不能切换账号', backupPath: null }
    }
    if (switchOperationActive) {
      return { ok: false, message: '已有账号切换或恢复操作正在执行', backupPath: null }
    }
    if (accountLibraryOperationActive) {
      return { ok: false, message: '账号库正在导入、扫描或删除，暂时不能切换账号', backupPath: null }
    }
    if (autoSwitchOperationActive) {
      return { ok: false, message: '自动检测或切换正在运行', backupPath: null }
    }
    const payload = z.object({ id: z.string().min(1), restart: z.boolean() }).parse(input)
    switchOperationActive = true
    try {
      const result = await manager.switchAccount(payload.id)
      if (result.ok && payload.restart) {
        const restartResult = await processManager.restart()
        return {
          ...result,
          message: restartResult.ok
            ? `${result.message}；${restartResult.message}`
            : `${result.message}，但${restartResult.message}。账号已完成切换，可手动重启 Codex`,
          restartResult
        }
      }
      return result
    } finally {
      switchOperationActive = false
    }
  })
  ipcMain.handle(ipcChannels.restore, async (_event, input: unknown) => {
    if (testController) {
      return { ok: false, message: '账号检测进行中，暂时不能恢复配置', backupPath: null }
    }
    if (switchOperationActive) {
      return { ok: false, message: '已有账号切换或恢复操作正在执行', backupPath: null }
    }
    if (autoSwitchOperationActive) {
      return { ok: false, message: '自动检测或切换正在运行', backupPath: null }
    }
    const payload = z.object({ restart: z.boolean() }).parse(input)
    switchOperationActive = true
    try {
      const result = await manager.restoreLatest()
      if (result.ok && payload.restart) {
        const restartResult = await processManager.restart()
        return { ...result, restartResult, message: `${result.message}；${restartResult.message}` }
      }
      return result
    } finally {
      switchOperationActive = false
    }
  })
  ipcMain.handle(ipcChannels.restoreApiMode, async (_event, input: unknown) => {
    if (testController) {
      return { ok: false, message: '账号检测进行中，暂时不能恢复 API 模式', backupPath: null }
    }
    if (switchOperationActive) {
      return { ok: false, message: '已有账号切换或恢复操作正在执行', backupPath: null }
    }
    if (autoSwitchOperationActive) {
      return { ok: false, message: '自动检测或切换正在运行', backupPath: null }
    }
    const payload = z.object({ restart: z.boolean() }).parse(input)
    switchOperationActive = true
    try {
      const result = await manager.restoreApiMode()
      if (result.ok && payload.restart) {
        const restartResult = await processManager.restart()
        return { ...result, restartResult, message: `${result.message}；${restartResult.message}` }
      }
      return result
    } finally {
      switchOperationActive = false
    }
  })
  ipcMain.handle(ipcChannels.customApiProfile, async () => {
    const settings = await settingsStore.get()
    return customApiStore.summary({ baseUrl: settings.customApiBaseUrl, model: settings.customApiModel })
  })
  ipcMain.handle(ipcChannels.customApiSwitch, async (_event, input: unknown) => {
    if (testController || switchOperationActive || autoSwitchOperationActive) {
      return { ok: false, message: '账号任务正在运行，暂时不能切换 API', backupPath: null }
    }
    const payload = z.object({
      profile: z.object({
        baseUrl: z.string().url().max(2048),
        model: z.string().min(1).max(128),
        apiKey: z.string().max(16_384).optional()
      }),
      restart: z.boolean()
    }).parse(input)
    const updated = await settingsStore.update({
      customApiBaseUrl: payload.profile.baseUrl,
      customApiModel: payload.profile.model
    })
    if (payload.profile.apiKey?.trim()) await customApiStore.saveKey(payload.profile.apiKey)
    const apiKey = await customApiStore.getKey()
    if (!apiKey) return { ok: false, message: '请先填写自定义 API Key', backupPath: null }
    switchOperationActive = true
    try {
      const result = await switcher.switchToCustomApi({
        baseUrl: updated.customApiBaseUrl,
        model: updated.customApiModel,
        apiKey
      })
      if (result.ok && payload.restart) {
        const restartResult = await processManager.restart()
        return { ...result, restartResult, message: `${result.message}；${restartResult.message}` }
      }
      return result
    } finally {
      switchOperationActive = false
    }
  })

  ipcMain.handle(ipcChannels.grokScan, () => {
    if (grokTestController) throw new Error('Grok 检测正在运行')
    return grokManager.scanDirectory()
  })
  ipcMain.handle(ipcChannels.grokImport, async () => {
    if (grokTestController) throw new Error('Grok 检测正在运行')
    const selected = await dialog.showOpenDialog({
      title: '导入 Grok 账号文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '账号文件', extensions: ['json', 'jsonl', 'txt', 'md', 'js', 'mjs', 'cjs', 'zip'] }]
    })
    return selected.canceled ? null : grokManager.importFiles(selected.filePaths)
  })
  ipcMain.handle(ipcChannels.grokImportDirectory, async () => {
    if (grokTestController) throw new Error('Grok 检测正在运行')
    const settings = await settingsStore.get()
    const selected = await dialog.showOpenDialog({
      title: '导入文件夹内的 Grok 账号',
      defaultPath: settings.grokDirectory,
      properties: ['openDirectory']
    })
    return selected.canceled ? null : grokManager.importDirectory(selected.filePaths[0])
  })
  ipcMain.handle(ipcChannels.grokImportPasted, (_event, input: unknown) => {
    if (grokTestController) throw new Error('Grok 检测正在运行')
    return grokManager.importPasted(z.string().min(1).max(100 * 1024 * 1024).parse(input))
  })
  ipcMain.handle(ipcChannels.grokDelete, (_event, input: unknown) => {
    if (grokTestController) throw new Error('Grok 检测正在运行')
    return grokManager.deleteAccounts(z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(20_000).parse(input))
  })
  ipcMain.handle(ipcChannels.grokTest, async (_event, input: unknown) => {
    if (grokTestController) throw new Error('已有 Grok 检测任务正在运行')
    const ids = z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional().parse(input)
    grokTestController = new AbortController()
    sendGrokProgress({ active: true, done: 0, total: ids?.length ?? (await grokManager.listAccounts()).length, runningIds: [], updatedAccount: null })
    try {
      return await grokManager.testAccounts(ids, {
        signal: grokTestController.signal,
        onProgress: ({ done, total, runningIds, updatedAccount }) => sendGrokProgress({
          active: true, done, total, runningIds, updatedAccount: updatedAccount ?? null
        })
      })
    } finally {
      grokTestController = null
      sendGrokProgress({ ...grokProgress, active: false, runningIds: [], updatedAccount: null })
    }
  })
  ipcMain.handle(ipcChannels.grokCancelTest, () => grokTestController?.abort())
  ipcMain.handle(ipcChannels.grokExport, async (_event, input: unknown) => {
    const payload = z.object({
      ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(20_000),
      layout: z.enum(['separate', 'bundle'])
    }).parse(input)
    const settings = await settingsStore.get()
    const selected = await dialog.showOpenDialog({
      title: '选择 Grok 账号导出目录',
      defaultPath: settings.grokDirectory,
      properties: ['openDirectory', 'createDirectory']
    })
    return selected.canceled ? null : grokManager.exportAccounts(payload.ids, payload.layout, selected.filePaths[0])
  })
  ipcMain.handle(ipcChannels.restart, () => processManager.restart())
  ipcMain.handle(ipcChannels.settingsUpdate, async (_event, input: unknown) => {
    if (testController || switchOperationActive || accountLibraryOperationActive || autoSwitchOperationActive) {
      throw new Error('账号任务正在运行，暂时不能修改设置')
    }
    let patch = z
      .object({
        accountDirectory: z.string().max(32_767).optional(),
        authPath: z.string().max(32_767).optional(),
        configPath: z.string().max(32_767).optional(),
        concurrency: z.number().optional(),
        timeoutMs: z.number().optional(),
        backupRetention: z.number().optional(),
        deepTestModel: z.string().max(128).optional(),
        autoSwitchEnabled: z.boolean().optional(),
        autoSwitchIntervalSeconds: z.number().optional(),
        autoSwitchAccountIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20_000).optional(),
        autoSwitchRestartCodex: z.boolean().optional(),
        grokDirectory: z.string().max(32_767).optional(),
        customApiBaseUrl: z.string().max(2048).optional(),
        customApiModel: z.string().max(128).optional()
      })
      .parse(input) satisfies Partial<AppSettings>
    if (patch.autoSwitchAccountIds || patch.autoSwitchEnabled === true) {
      const current = await settingsStore.get()
      const switchableIds = new Set(
        (await manager.listAccounts())
          .filter((account) => account.switchable)
          .map((account) => account.id)
      )
      const requestedIds = patch.autoSwitchAccountIds ?? current.autoSwitchAccountIds
      const autoSwitchAccountIds = requestedIds.filter((id) => switchableIds.has(id))
      if ((patch.autoSwitchEnabled ?? current.autoSwitchEnabled) && autoSwitchAccountIds.length === 0) {
        throw new Error('启用自动切换前至少选择一个仍在 aa 中且可切换的账号')
      }
      patch = { ...patch, autoSwitchAccountIds }
    }
    const updated = await settingsStore.update(patch)
    await autoSwitchScheduler.settingsChanged()
    return updated
  })
  ipcMain.handle(ipcChannels.settingsChooseDirectory, async () => {
    const current = await settingsStore.get()
    const result = await dialog.showOpenDialog({
      title: '选择账号目录',
      defaultPath: current.accountDirectory,
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle(ipcChannels.settingsChooseGrokDirectory, async () => {
    const current = await settingsStore.get()
    const result = await dialog.showOpenDialog({
      title: '选择 Grok 账号目录',
      defaultPath: current.grokDirectory,
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle(ipcChannels.revealSource, async (_event, input: unknown) => {
    const id = z.string().min(1).parse(input)
    const sourcePath = await manager.getSourcePath(id)
    if (!sourcePath) return { ok: false, message: '账号来源不存在' }
    if (!['.json', '.jsonl', '.txt', '.md', '.js', '.mjs', '.cjs', '.zip'].includes(extname(sourcePath).toLowerCase())) {
      return { ok: false, message: '账号来源文件类型不受支持' }
    }
    try {
      if (!(await stat(sourcePath)).isFile()) return { ok: false, message: '账号来源不是文件' }
      shell.showItemInFolder(sourcePath)
      return { ok: true, message: '已打开源文件位置' }
    } catch {
      return { ok: false, message: '账号源文件已不存在' }
    }
  })
  ipcMain.handle(ipcChannels.sessionRepairPreview, async (_event, input: unknown) => {
    const targetProvider = z
      .string()
      .regex(/^[A-Za-z0-9_.-]+$/)
      .optional()
      .parse(input)
    return (await sessionRepairService()).preview(targetProvider)
  })
  ipcMain.handle(ipcChannels.sessionRepairApply, async (_event, input: unknown) => {
    const payload = z
      .object({
        snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
        targetProvider: z.string().regex(/^[A-Za-z0-9_.-]+$/)
      })
      .parse(input)
    if (testController || switchOperationActive || autoSwitchOperationActive) {
      return {
        ok: false,
        message: '账号检测、切换或恢复进行中，暂时不能修复会话',
        targetProvider: payload.targetProvider,
        changedSessionFiles: 0,
        sqliteRowsUpdated: 0,
        globalStateKeysUpdated: 0,
        backupPath: null
      }
    }
    return (await sessionRepairService()).apply(payload.snapshotId, payload.targetProvider)
  })
  ipcMain.handle(ipcChannels.updateGetState, () => updateState)
  ipcMain.handle(ipcChannels.updateCheck, () => checkForUpdates())
  ipcMain.handle(ipcChannels.updateDownload, async () => {
    if (updateDownloadPromise) return updateDownloadPromise
    if (updateState.status !== 'available') throw new Error('当前没有可下载的新版本')
    if (!availableUpdate) throw new Error('更新元数据缺少 Windows 安装包或校验值')
    sendUpdateState({ ...updateState, status: 'downloading', percent: 0, message: '正在准备下载更新' })
    const version = availableUpdate.version.replace(/^v/i, '')
    const fileName = `Codex-Account-Switcher-Setup-${version}.exe`
    const targetPath = join(app.getPath('downloads'), fileName)
    const url = `https://github.com/ciaooo55/codex-account-switcher/releases/download/v${version}/${fileName}`
    downloadedInstallerPath = null
    updateDownloadPromise = downloadInstaller({
      url,
      targetPath,
      expectedSha512: availableUpdate.expectedSha512,
      fetch: (input) => net.fetch(input) as never,
      onProgress: (percent) => sendUpdateState({
        ...updateState,
        status: 'downloading',
        percent,
        message: `正在下载到“下载”文件夹 ${percent.toFixed(1)}%`
      })
    }).then((path) => {
      downloadedInstallerPath = path
      sendUpdateState({
        status: 'downloaded',
        currentVersion: app.getVersion(),
        availableVersion: availableUpdate?.version ?? version,
        percent: 100,
        message: `安装包已保存到“下载”文件夹，安装完成后会自动删除`
      })
    }).catch((error) => {
      sendUpdateState({
        ...updateState,
        status: 'available',
        percent: null,
        message: error instanceof Error ? error.message : '安装包下载失败'
      })
      throw error
    }).finally(() => {
      updateDownloadPromise = null
    })
    return updateDownloadPromise
  })
  ipcMain.handle(ipcChannels.updateInstall, () => {
    if (updateState.status !== 'downloaded' || !downloadedInstallerPath) {
      throw new Error('安装包尚未下载完成')
    }
    launchInstallerAndDelete(downloadedInstallerPath)
    isQuitting = true
    app.quit()
  })
  ipcMain.handle(ipcChannels.autoSwitchRun, () => autoSwitchScheduler.runNow(true))

  const trayIconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(currentDirectory, '../../build/icon.png')
  const trayIcon = nativeImage.createFromPath(trayIconPath)
  if (trayIcon.isEmpty()) throw new Error(`无法加载托盘图标：${trayIconPath}`)
  tray = new Tray(trayIcon.resize({ width: 16, height: 16 }))
  tray.setToolTip('Codex Account Switcher')
  tray.on('click', showMainWindow)

  const formatNextCheck = (value: string | null): string => {
    if (!value) return '下次检查：未计划'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return '下次检查：时间未知'
    return `下次检查：${date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })}`
  }

  rebuildTrayMenu = async () => {
    if (!tray || tray.isDestroyed()) return
    const settings = await settingsStore.get()
    const state = autoSwitchScheduler.getState()
    tray.setToolTip(
      state.running
        ? 'Codex Account Switcher - 正在检查账号'
        : settings.autoSwitchEnabled
          ? 'Codex Account Switcher - 定时切换已启用'
          : 'Codex Account Switcher - 定时切换未启用'
    )
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开主界面', click: showMainWindow },
        {
          label: state.running ? '正在检查账号...' : '立即检查当前账号',
          enabled: !state.running,
          click: () => {
            void autoSwitchScheduler.runNow(true).catch((error) => {
              showTrayMessage('账号检查失败', error instanceof Error ? error.message : String(error))
            })
          }
        },
        { type: 'separator' },
        {
          label: '定时自动切换',
          type: 'checkbox',
          checked: settings.autoSwitchEnabled,
          enabled: !state.running,
          click: (menuItem) => {
            void (async () => {
              const current = await settingsStore.get()
              if (menuItem.checked && current.autoSwitchAccountIds.length === 0) {
                showTrayMessage('无法启用自动切换', '请先在设置中选择至少一个候选账号')
                await rebuildTrayMenu()
                return
              }
              await settingsStore.update({ autoSwitchEnabled: menuItem.checked })
              await autoSwitchScheduler.settingsChanged()
            })().catch((error) => {
              showTrayMessage('设置更新失败', error instanceof Error ? error.message : String(error))
              void rebuildTrayMenu()
            })
          }
        },
        {
          label: state.running ? '状态：检查中' : formatNextCheck(state.nextCheckAt),
          enabled: false
        },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            isQuitting = true
            app.quit()
          }
        }
      ])
    )
  }

  applicationInitialized = true
  showMainWindow()
  await initialScan
  await autoSwitchScheduler.start()
  await rebuildTrayMenu()
  app.once('before-quit', () => {
    isQuitting = true
    autoSwitchScheduler.stop()
    tray?.destroy()
    tray = null
  })
  if (app.isPackaged && !e2eMode) {
    setTimeout(() => void checkForUpdates().catch(() => undefined), 4_000)
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else if (process.argv.includes(INSTALL_QUIT_ARGUMENT)) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    if (commandLine.includes(INSTALL_QUIT_ARGUMENT)) {
      isQuitting = true
      app.quit()
      return
    }
    showMainWindow()
  })

  app.whenReady().then(main).catch((error) => {
    dialog.showErrorBox(
      'Codex Account Switcher 启动失败',
      error instanceof Error ? error.message : String(error)
    )
    app.quit()
  })

  app.on('window-all-closed', () => {
    // Keep the tray and main-process scheduler alive after the renderer is released.
  })

  app.on('activate', showMainWindow)
}
