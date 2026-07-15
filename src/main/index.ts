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
import { z } from 'zod'
import { ipcChannels, type TestProgress } from '../shared/ipc'
import type { AppSettings, SecretCipher } from '../shared/types'
import { AccountManager } from './services/account-manager'
import { CodexProcessManager } from './services/codex-process'
import { CredentialTester } from './services/detector'
import { SessionRepairService } from './services/session-repair'
import { SettingsStore } from './storage/settings'
import { StatusStore } from './storage/status-store'
import { CredentialVault } from './storage/vault'
import { CredentialSwitcher } from './switching/switcher'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const e2eMode = !app.isPackaged && process.env.CODEX_SWITCHER_E2E === '1'
if (e2eMode && process.env.CODEX_SWITCHER_USER_DATA) {
  app.setPath('userData', resolve(process.env.CODEX_SWITCHER_USER_DATA))
}
let mainWindow: BrowserWindow | null = null
let testController: AbortController | null = null
let progress: TestProgress = { active: false, done: 0, total: 0 }

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
    switcher
  })

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

  ipcMain.handle(ipcChannels.snapshot, async () => ({
    accounts: await manager.listAccounts(),
    settings: await settingsStore.get(),
    testing: progress
  }))
  ipcMain.handle(ipcChannels.scan, () => manager.scanDirectory())
  ipcMain.handle(ipcChannels.import, async () => {
    const result = await dialog.showOpenDialog({
      title: '导入 Codex 账号文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '账号文件', extensions: ['json', 'txt', 'js'] }]
    })
    return result.canceled ? null : manager.importFiles(result.filePaths)
  })
  ipcMain.handle(ipcChannels.test, async (_event, input: unknown) => {
    if (testController) throw new Error('已有检测任务正在运行')
    const ids = z.array(z.string().min(1)).optional().parse(input)
    testController = new AbortController()
    sendProgress({ active: true, done: 0, total: ids?.length ?? (await manager.listAccounts()).length })
    try {
      return await manager.testAccounts(ids, {
        signal: testController.signal,
        onProgress: ({ done, total }) => sendProgress({ active: true, done, total })
      })
    } finally {
      testController = null
      sendProgress({ ...progress, active: false })
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
    if (!['.json', '.txt', '.js'].includes(extname(sourcePath).toLowerCase())) {
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

  mainWindow = createWindow()
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  void manager.scanDirectory().catch(() => undefined)
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
