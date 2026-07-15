import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell
} from 'electron'
import electronUpdater from 'electron-updater'
import { z } from 'zod'
import { ipcChannels, type TestProgress, type UpdateState } from '../shared/ipc'
import type { AppSettings, SecretCipher } from '../shared/types'
import { AccountManager } from './services/account-manager'
import { CodexProcessManager } from './services/codex-process'
import { CredentialTester } from './services/detector'
import { CredentialExportService } from './services/exporter'
import { SessionRepairService } from './services/session-repair'
import { SettingsStore } from './storage/settings'
import { StatusStore } from './storage/status-store'
import { DeletedCredentialStore } from './storage/deleted-credentials'
import { CredentialVault } from './storage/vault'
import { CredentialSwitcher } from './switching/switcher'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const { autoUpdater } = electronUpdater
const e2eMode = !app.isPackaged && process.env.CODEX_SWITCHER_E2E === '1'
if (e2eMode && process.env.CODEX_SWITCHER_USER_DATA) {
  app.setPath('userData', resolve(process.env.CODEX_SWITCHER_USER_DATA))
}
let mainWindow: BrowserWindow | null = null
let testController: AbortController | null = null
let progress: TestProgress = {
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
  window.once('ready-to-show', () => window.show())
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

async function main(): Promise<void> {
  const userData = app.getPath('userData')
  const cipher = createCipher()
  const settingsStore = new SettingsStore(join(userData, 'settings.json'), homedir())
  const vault = new CredentialVault(join(userData, 'vault.json'), cipher)
  const statusStore = new StatusStore(join(userData, 'status.json'))
  const deletedStore = new DeletedCredentialStore(join(userData, 'deleted-accounts.json'))
  const importDirectory = join(userData, 'imports')
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

  const sessionRepairService = async (): Promise<SessionRepairService> => {
    const settings = await settingsStore.get()
    return new SessionRepairService({
      codexHome: dirname(settings.configPath),
      backupRetention: settings.backupRetention,
      isCodexRunning: e2eMode ? async () => false : () => processManager.isOfficialRunning()
    })
  }

  const sendProgress = (next: TestProgress): void => {
    progress = next
    mainWindow?.webContents.send(ipcChannels.testProgress, progress)
  }

  const sendUpdateState = (next: UpdateState): void => {
    updateState = next
    mainWindow?.webContents.send(ipcChannels.updateState, updateState)
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.on('checking-for-update', () => {
    sendUpdateState({
      ...updateState,
      status: 'checking',
      percent: null,
      message: '正在检查更新'
    })
  })
  autoUpdater.on('update-available', (info) => {
    sendUpdateState({
      status: 'available',
      currentVersion: app.getVersion(),
      availableVersion: info.version,
      percent: null,
      message: `发现新版本 ${info.version}`
    })
  })
  autoUpdater.on('update-not-available', () => {
    sendUpdateState({
      status: 'not_available',
      currentVersion: app.getVersion(),
      availableVersion: null,
      percent: null,
      message: '当前已是最新版本'
    })
  })
  autoUpdater.on('download-progress', (info) => {
    sendUpdateState({
      ...updateState,
      status: 'downloading',
      percent: Math.max(0, Math.min(100, info.percent)),
      message: `正在下载 ${info.percent.toFixed(1)}%`
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    sendUpdateState({
      status: 'downloaded',
      currentVersion: app.getVersion(),
      availableVersion: info.version,
      percent: 100,
      message: '安装包已下载，可退出并覆盖安装'
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

  const checkForUpdates = async (): Promise<UpdateState> => {
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
  }

  ipcMain.handle(ipcChannels.snapshot, async () => ({
    accounts: await manager.listAccounts(),
    settings: await settingsStore.get(),
    importDirectory,
    testing: progress
  }))
  ipcMain.handle(ipcChannels.scan, () => manager.scanDirectory())
  ipcMain.handle(ipcChannels.import, async () => {
    const result = await dialog.showOpenDialog({
      title: '导入 Codex 账号文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '账号文件', extensions: ['json', 'jsonl', 'txt', 'md', 'js', 'mjs', 'cjs', 'zip'] }]
    })
    return result.canceled
      ? null
      : manager.importFiles(result.filePaths, { archiveSources: true })
  })
  ipcMain.handle(ipcChannels.importDirectory, async () => {
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
  ipcMain.handle(ipcChannels.importPasted, (_event, input: unknown) =>
    manager.importPasted(z.string().min(1).max(100 * 1024 * 1024).parse(input))
  )
  ipcMain.handle(ipcChannels.deleteAccounts, async (_event, input: unknown) => {
    if (testController) throw new Error('账号检测进行中，暂时不能删除账号')
    const ids = z.array(z.string().min(1)).min(1).max(20_000).parse(input)
    return manager.deleteAccounts(ids)
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
    const payload = z.object({ id: z.string().min(1), restart: z.boolean() }).parse(input)
    const result = await manager.switchAccount(payload.id)
    if (result.ok && payload.restart) {
      const restart = await processManager.restart()
      if (!restart.ok) return { ...result, ok: false, message: restart.message }
    }
    return result
  })
  ipcMain.handle(ipcChannels.restore, async (_event, input: unknown) => {
    const payload = z.object({ restart: z.boolean() }).parse(input)
    const result = await manager.restoreLatest()
    if (result.ok && payload.restart) {
      const restart = await processManager.restart()
      if (!restart.ok) return { ...result, ok: false, message: restart.message }
    }
    return result
  })
  ipcMain.handle(ipcChannels.restoreApiMode, async (_event, input: unknown) => {
    const payload = z.object({ restart: z.boolean() }).parse(input)
    const result = await manager.restoreApiMode()
    if (result.ok && payload.restart) {
      const restart = await processManager.restart()
      if (!restart.ok) return { ...result, ok: false, message: restart.message }
    }
    return result
  })
  ipcMain.handle(ipcChannels.restart, () => processManager.restart())
  ipcMain.handle(ipcChannels.settingsUpdate, async (_event, input: unknown) => {
    const patch = z
      .object({
        accountDirectory: z.string().optional(),
        authPath: z.string().optional(),
        configPath: z.string().optional(),
        concurrency: z.number().optional(),
        timeoutMs: z.number().optional(),
        backupRetention: z.number().optional(),
        deepTestModel: z.string().optional()
      })
      .parse(input) satisfies Partial<AppSettings>
    return settingsStore.update(patch)
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
    return (await sessionRepairService()).apply(payload.snapshotId, payload.targetProvider)
  })
  ipcMain.handle(ipcChannels.updateGetState, () => updateState)
  ipcMain.handle(ipcChannels.updateCheck, () => checkForUpdates())
  ipcMain.handle(ipcChannels.updateDownload, async () => {
    if (updateState.status !== 'available') throw new Error('当前没有可下载的新版本')
    await autoUpdater.downloadUpdate()
  })
  ipcMain.handle(ipcChannels.updateInstall, () => {
    if (updateState.status !== 'downloaded') throw new Error('安装包尚未下载完成')
    autoUpdater.quitAndInstall(false, true)
  })

  mainWindow = createWindow()
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  void manager.scanDirectory().catch(() => undefined)
  if (app.isPackaged && !e2eMode) {
    setTimeout(() => void checkForUpdates().catch(() => undefined), 4_000)
  }
}

app.whenReady().then(main).catch((error) => {
  dialog.showErrorBox(
    'Codex Account Switcher 启动失败',
    error instanceof Error ? error.message : String(error)
  )
  app.quit()
})

app.on('window-all-closed', () => app.quit())

app.on('activate', () => {
  if (!mainWindow) mainWindow = createWindow()
})
