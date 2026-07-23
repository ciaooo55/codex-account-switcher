import { mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
import {
  ipcChannels,
  type AccountStatusSyncPatch,
  type CpaCodexTestProgress,
  type GrokTestProgress,
  type ImportPreviewTestProgress,
  type SessionRepairProgress,
  type TestProgress,
  type UpdateState
} from '../shared/ipc'
import type { AppSettings, AutoSwitchState, SecretCipher } from '../shared/types'
import { AccountManager } from './services/account-manager'
import { reconcileCodexStatuses, reconcileGrokStatuses } from './services/account-status-sync'
import { AutoSwitchScheduler, shouldNotifyAutoSwitchCompletion } from './services/auto-switch'
import { discoverCodexPaths, normalizeSelectedCodexDirectory } from './services/codex-paths'
import { discoverCpaDirectory } from './services/cpa-paths'
import { CodexProcessManager } from './services/codex-process'
import { ConversationManager } from './services/conversation-manager'
import { CpaCodexManager } from './services/cpa-codex-manager'
import { readCpaDirectoryStats } from './services/cpa-directory-stats'
import { CredentialTester } from './services/detector'
import { CredentialExportService } from './services/exporter'
import { GrokAccountManager } from './services/grok-account-manager'
import { GrokCredentialTester } from './services/grok-detector'
import { combineLibraryImportResults } from './services/library-import'
import { ImportPreviewService } from './services/import-preview'
import { LibraryHealthService } from './services/library-health'
import { OpenAIRefreshTokenImporter } from './services/refresh-token-importer'
import { OpenAIOAuthImporter } from './services/openai-oauth-importer'
import { SessionRepairService } from './services/session-repair'
import {
  cleanupLegacyUpdateCache,
  consumeInstallerResult,
  downloadInstaller,
  launchInstallerAndDelete
} from './services/update-installer'
import { SettingsStore } from './storage/settings'
import { StatusStore } from './storage/status-store'
import { DeletedCredentialStore } from './storage/deleted-credentials'
import { CredentialVault } from './storage/vault'
import { normalizeCustomApiBaseUrl } from '../shared/custom-api'
import { CustomApiStore } from './storage/custom-api-store'
import { AccountMetadataStore } from './storage/account-metadata'
import { GrokStatusStore } from './storage/grok-status-store'
import { fetchOpenAiCompatibleModelIds, MODEL_CATALOG_RELATIVE_PATH, probeCustomApiModel } from './services/model-catalog'
import { atomicWriteFile } from './storage/atomic-file'
import { CredentialSwitcher } from './switching/switcher'
import { applyCustomApiConfig, OWNED_PROVIDER_ID } from './switching/config'

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
let sessionRepairOperationActive = false
let conversationDeleteOperationActive = false
let restartOperationActive = false
let updateInstallOperationActive = false
let auxiliaryLibraryOperationCount = 0
let testController: AbortController | null = null
let grokTestController: AbortController | null = null
let cpaGrokTestController: AbortController | null = null
let cpaCodexTestController: AbortController | null = null
let importPreviewTestController: AbortController | null = null
let importPreviewTestSessionId: string | null = null
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
let cpaGrokProgress: GrokTestProgress = {
  active: false,
  done: 0,
  total: 0,
  runningIds: [],
  updatedAccount: null
}
let cpaCodexProgress: CpaCodexTestProgress = {
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
let sessionRepairProgress: SessionRepairProgress = {
  active: false,
  done: 0,
  total: 0,
  message: ''
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
    backgroundColor: '#edf1f3',
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
  // Non-critical disk cleanup must not block first paint.
  const deferredLegacyCleanup = cleanupLegacyUpdateCache(process.env.LOCALAPPDATA).catch(() => undefined)
  const installerResultPromise = consumeInstallerResult().catch(() => null)
  const userData = app.getPath('userData')
  const homeDirectory = homedir()
  const cipher = createCipher()
  const settingsStore = new SettingsStore(join(userData, 'settings.json'), homeDirectory)
  const [installerResult, initialSettingsLoaded] = await Promise.all([
    installerResultPromise,
    settingsStore.get()
  ])
  let initialSettings = initialSettingsLoaded
  if (installerResult) {
    updateState = {
      status: installerResult.status === 'succeeded' ? 'not_available' : 'error',
      currentVersion: app.getVersion(),
      availableVersion: null,
      percent: null,
      message: installerResult.status === 'succeeded'
        ? `已成功更新到 ${app.getVersion()}`
        : `更新安装失败：${installerResult.message}`
    }
  }
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
  const cpaCodexStatusStore = new StatusStore(join(userData, 'cpa-codex-status.json'))
  const grokStatusStore = new GrokStatusStore(join(userData, 'grok-library-status.json'))
  const cpaGrokStatusStore = new GrokStatusStore(join(userData, 'grok-status.json'))
  const accountMetadataStore = new AccountMetadataStore(join(userData, 'account-metadata.json'))
  // Warm metadata cache in parallel with the rest of startup.
  // Keep a retrying helper: a single failed warm must not leave aliases empty forever.
  let metadataWarm = accountMetadataStore.getAll().then(() => undefined)
  const metadataReady = async (): Promise<void> => {
    try {
      await metadataWarm
    } catch {
      metadataWarm = accountMetadataStore.getAll().then(() => undefined)
      try {
        await metadataWarm
      } catch {
        // Corrupt metadata must not block account lists; decorate falls back to empty fields.
      }
    }
  }
  const deletedStore = new DeletedCredentialStore(join(userData, 'deleted-accounts.json'))
  const deletedCpaCodexStore = new DeletedCredentialStore(join(userData, 'deleted-cpa-codex-accounts.json'))
  const deletedGrokStore = new DeletedCredentialStore(join(userData, 'deleted-grok-library-accounts.json'))
  const deletedCpaGrokStore = new DeletedCredentialStore(join(userData, 'deleted-grok-accounts.json'))
  const applicationDirectory = e2eMode
    ? userData
    : app.isPackaged
      ? resolve(process.env.PORTABLE_EXECUTABLE_DIR ?? dirname(process.execPath))
      : resolve(currentDirectory, '../..')
  if (e2eMode) await mkdir(initialSettings.grokDirectory, { recursive: true })
  let discoveredCpaDirectory = await discoverCpaDirectory({
    homeDirectory,
    configuredDirectory: initialSettings.grokDirectory,
    applicationDirectory
  })
  if (!discoveredCpaDirectory && !e2eMode) {
    const selected = await dialog.showOpenDialog({
      title: '未找到 CPA 凭证目录，请选择 CLIProxyAPI 的 auth-dir',
      defaultPath: initialSettings.grokDirectory,
      buttonLabel: '使用此目录',
      properties: ['openDirectory', 'createDirectory']
    })
    discoveredCpaDirectory = selected.canceled
      ? join(homeDirectory, '.cli-proxy-api')
      : selected.filePaths[0]
  }
  if (discoveredCpaDirectory) await mkdir(discoveredCpaDirectory, { recursive: true })
  if (discoveredCpaDirectory && resolve(discoveredCpaDirectory) !== resolve(initialSettings.grokDirectory)) {
    initialSettings = await settingsStore.update({ grokDirectory: discoveredCpaDirectory })
  }
  const importDirectory = join(applicationDirectory, 'aa')
  const codexImportDirectory = join(importDirectory, 'codex')
  const grokImportDirectory = join(importDirectory, 'grok')
  const legacyImportDirectories = [...new Set(e2eMode
    ? [join(userData, 'imports'), importDirectory]
    : app.isPackaged
      ? [
        importDirectory,
        join(userData, 'imports'),
        join(userData, 'aa'),
        join(app.getPath('appData'), 'Codex Account Switcher', 'aa')
      ]
      : [])]
  const processManager = e2eMode
    ? new CodexProcessManager(async () => '0')
    : new CodexProcessManager()
  let testApiBase: string | null = null
  if (e2eMode && process.env.CODEX_SWITCHER_TEST_API_BASE_URL) {
    const parsed = new URL(process.env.CODEX_SWITCHER_TEST_API_BASE_URL)
    if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
      throw new Error('E2E API 仅允许本机回环地址')
    }
    testApiBase = parsed.toString().replace(/\/$/, '')
  }

  const tester = {
    test: async (credential: Parameters<CredentialTester['test']>[0], signal?: AbortSignal, mode?: Parameters<CredentialTester['test']>[2]) => {
      const settings = await settingsStore.get()
      return new CredentialTester({
        timeoutMs: settings.timeoutMs,
        deepTestModel: settings.deepTestModel,
        ...(testApiBase
          ? {
              compactUrl: `${testApiBase}/compact`,
              usageUrl: `${testApiBase}/usage`,
              refreshUrl: `${testApiBase}/oauth/token`,
              personalAccessTokenWhoamiUrl: `${testApiBase}/personal-access-token/whoami`,
              queryResetCredits: false
            }
          : {}),
        onCredentialUpdated: (updated) => vault.upsertMany([updated])
      }).test(credential, signal, mode)
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
    switchToCustomApi: async (input: {
      baseUrl: string
      model: string
      apiKey: string
      models?: string[]
      syncModelCatalog?: boolean
      verifiedProbe?: {
        endpoint: 'responses'
        baseUrl: string
        probeUrl: string
        output: string
      }
      forceProbeFailure?: string
    }) => {
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
  // Keep managed custom-API provider pointed at the real upstream from settings.
  // This also migrates leftover local-gateway ports from older builds.
  const ensureDirectCustomApiProvider = async (): Promise<void> => {
    const settings = await settingsStore.get()
    const configText = await readFile(settings.configPath, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    })
    const ownsProvider = new RegExp(
      '^\s*model_provider\s*=\s*["\']' + OWNED_PROVIDER_ID + '["\']\s*$',
      'm'
    ).test(configText)
    if (!ownsProvider) return
    const apiKey = await customApiStore.getKey()
    if (!apiKey) return
    const baseUrl = normalizeCustomApiBaseUrl(settings.customApiBaseUrl)
    if (!baseUrl) return
    const preferredModel = settings.customApiModel.trim()
    if (!preferredModel) return
    const managedCatalogPattern = MODEL_CATALOG_RELATIVE_PATH.replace(/\./g, '\\.')
    const syncModelCatalog = new RegExp(
      '^\s*model_catalog_json\s*=\s*["\'][^"\']*' + managedCatalogPattern + '["\']\s*$',
      'm'
    ).test(configText)
    const applied = applyCustomApiConfig(configText, {
      baseUrl,
      model: preferredModel,
      apiKey,
      syncModelCatalog
    })
    if (applied.text !== configText) {
      await atomicWriteFile(settings.configPath, applied.text)
    }
    let authNeedsWrite = true
    try {
      const currentAuth = JSON.parse(await readFile(settings.authPath, 'utf8')) as {
        auth_mode?: unknown
        OPENAI_API_KEY?: unknown
      }
      authNeedsWrite = !(
        currentAuth.auth_mode === 'apikey' &&
        currentAuth.OPENAI_API_KEY === apiKey
      )
    } catch {
      authNeedsWrite = true
    }
    if (authNeedsWrite) {
      const authText = `${JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: apiKey }, null, 2)}\n`
      await atomicWriteFile(settings.authPath, authText)
    }
  }
  await ensureDirectCustomApiProvider().catch((error: unknown) => {
    console.error('Failed to ensure direct custom API provider', error)
  })
  let reconcileCodexStatusStores = async (): Promise<void> => undefined
  let reconcileGrokStatusStores = async (): Promise<void> => undefined
  const manager = new AccountManager({
    settings: () => settingsStore.get(),
    vault,
    statusStore,
    tester,
    switcher,
    managedImportDirectory: codexImportDirectory,
    deletedStore,
    onCredentialsChanged: () => reconcileCodexStatusStores(),
    onStatusesChanged: () => reconcileCodexStatusStores(),
    refreshTokenImporter: new OpenAIRefreshTokenImporter({
      fetchImpl: (input, init) => net.fetch(
        input instanceof URL ? input.toString() : input,
        init
      ),
      ...(testApiBase ? { tokenUrl: `${testApiBase}/oauth/token` } : {})
    }),
    oauthAuthorizationImporter: new OpenAIOAuthImporter({
      fetchImpl: (input, init) => net.fetch(
        input instanceof URL ? input.toString() : input,
        init
      ),
      ...(testApiBase ? { tokenUrl: `${testApiBase}/oauth/token` } : {})
    })
  })
  const exporter = new CredentialExportService({ vault })
  let cpaCodexManager: CpaCodexManager
  cpaCodexManager = new CpaCodexManager({
    directory: async () => (await settingsStore.get()).grokDirectory,
    concurrency: async () => (await settingsStore.get()).concurrency,
    statusStore: cpaCodexStatusStore,
    deletedStore: deletedCpaCodexStore,
    tester: {
      test: async (credential, signal, mode) => {
        const settings = await settingsStore.get()
        return new CredentialTester({
          timeoutMs: settings.timeoutMs,
          deepTestModel: settings.deepTestModel,
          ...(testApiBase
            ? {
                compactUrl: `${testApiBase}/compact`,
                usageUrl: `${testApiBase}/usage`,
                refreshUrl: `${testApiBase}/oauth/token`,
                personalAccessTokenWhoamiUrl: `${testApiBase}/personal-access-token/whoami`,
                queryResetCredits: false
              }
            : {}),
          onCredentialUpdated: (updated) => cpaCodexManager.upsertRefreshed(updated)
        }).test(credential, signal, mode)
      }
    },
    onCredentialsChanged: () => reconcileCodexStatusStores(),
    onStatusesChanged: () => reconcileCodexStatusStores()
  })
  let grokManager: GrokAccountManager
  grokManager = new GrokAccountManager({
    directory: () => grokImportDirectory,
    fileNameStyle: 'library',
    concurrency: async () => (await settingsStore.get()).concurrency,
    statusStore: grokStatusStore,
    deletedStore: deletedGrokStore,
    tester: {
      test: async (credential, signal) => {
        const settings = await settingsStore.get()
        return new GrokCredentialTester({
          timeoutMs: settings.timeoutMs,
          ...(testApiBase ? { cliBaseUrl: `${testApiBase}/grok` } : {}),
          onCredentialUpdated: (updated) => grokManager.upsertRefreshed(updated)
        }).test(credential, signal)
      }
    },
    onCredentialsChanged: () => reconcileGrokStatusStores(),
    onStatusesChanged: () => reconcileGrokStatusStores()
  })
  let cpaGrokManager: GrokAccountManager
  cpaGrokManager = new GrokAccountManager({
    directory: async () => (await settingsStore.get()).grokDirectory,
    fileNameStyle: 'cpa',
    concurrency: async () => (await settingsStore.get()).concurrency,
    statusStore: cpaGrokStatusStore,
    deletedStore: deletedCpaGrokStore,
    tester: {
      test: async (credential, signal) => {
        const settings = await settingsStore.get()
        return new GrokCredentialTester({
          timeoutMs: settings.timeoutMs,
          ...(testApiBase ? { cliBaseUrl: `${testApiBase}/grok` } : {}),
          onCredentialUpdated: (updated) => cpaGrokManager.upsertRefreshed(updated)
        }).test(credential, signal)
      }
    },
    onCredentialsChanged: () => reconcileGrokStatusStores(),
    onStatusesChanged: () => reconcileGrokStatusStores()
  })

  const importPreviewService = new ImportPreviewService(manager, grokManager, {
    concurrency: async () => (await settingsStore.get()).concurrency,
    testCodex: async (credential, signal) => {
      const settings = await settingsStore.get()
      let latest = credential
      const result = await new CredentialTester({
        timeoutMs: settings.timeoutMs,
        deepTestModel: settings.deepTestModel,
        ...(testApiBase
          ? {
              compactUrl: `${testApiBase}/compact`,
              usageUrl: `${testApiBase}/usage`,
              refreshUrl: `${testApiBase}/oauth/token`,
              personalAccessTokenWhoamiUrl: `${testApiBase}/personal-access-token/whoami`,
              queryResetCredits: false
            }
          : {}),
        onCredentialUpdated: (updated) => {
          latest = updated
        }
      }).test(credential, signal, 'full')
      return { credential: latest, result }
    },
    testGrok: async (credential, signal) => {
      const settings = await settingsStore.get()
      let latest = credential
      const result = await new GrokCredentialTester({
        timeoutMs: settings.timeoutMs,
        ...(testApiBase ? { cliBaseUrl: `${testApiBase}/grok` } : {}),
        onCredentialUpdated: async (updated) => {
          latest = updated
        }
      }).test(credential, signal)
      return { credential: latest, result }
    }
  })
  const libraryHealthService = new LibraryHealthService({
    codexDirectory: codexImportDirectory,
    grokDirectory: grokImportDirectory,
    cpaDirectory: async () => (await settingsStore.get()).grokDirectory,
    quarantineDirectory: join(userData, 'quarantine'),
    accountManager: manager,
    grokManager,
    cpaCodexManager,
    cpaGrokManager,
    metadataStore: accountMetadataStore,
    statusStores: {
      codex: statusStore,
      grok: grokStatusStore,
      cpaCodex: cpaCodexStatusStore,
      cpaGrok: cpaGrokStatusStore
    }
  })

  const decorateAccounts = <T extends { id: string }>(accounts: readonly T[]): Array<T & ReturnType<AccountMetadataStore['peek']>> =>
    accounts.map((account) => accountMetadataStore.decorate(account))

  let codexStatusSyncQueue: Promise<void> = Promise.resolve()
  reconcileCodexStatusStores = (): Promise<void> => {
    const operation = codexStatusSyncQueue.then(async () => {
      const [libraryCredentials, cpaCredentials] = await Promise.all([
        manager.listCredentials(),
        cpaCodexManager.listCredentials()
      ])
      const synced = await reconcileCodexStatuses(
        libraryCredentials,
        cpaCredentials,
        statusStore,
        cpaCodexStatusStore
      )
      const patch: AccountStatusSyncPatch = {}
      if (synced.leftResults.length > 0) patch.accounts = synced.leftResults
      if (synced.rightResults.length > 0) patch.cpaCodexAccounts = synced.rightResults
      if (Object.keys(patch).length > 0) mainWindow?.webContents.send(ipcChannels.accountStatusSync, patch)
    })
    codexStatusSyncQueue = operation.catch(() => undefined)
    return operation
  }

  let grokStatusSyncQueue: Promise<void> = Promise.resolve()
  reconcileGrokStatusStores = (): Promise<void> => {
    const operation = grokStatusSyncQueue.then(async () => {
      const [libraryCredentials, cpaCredentials] = await Promise.all([
        grokManager.listCredentials(),
        cpaGrokManager.listCredentials()
      ])
      const synced = await reconcileGrokStatuses(
        libraryCredentials,
        cpaCredentials,
        grokStatusStore,
        cpaGrokStatusStore
      )
      const patch: AccountStatusSyncPatch = {}
      if (synced.leftResults.length > 0) patch.grokAccounts = synced.leftResults
      if (synced.rightResults.length > 0) patch.cpaGrokAccounts = synced.rightResults
      if (Object.keys(patch).length > 0) mainWindow?.webContents.send(ipcChannels.accountStatusSync, patch)
    })
    grokStatusSyncQueue = operation.catch(() => undefined)
    return operation
  }

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
    if (importPreviewTestController) throw new Error('导入凭证检测进行中，暂时不能修改账号库')
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

  const runTrackedFileOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    auxiliaryLibraryOperationCount += 1
    try {
      return await operation()
    } finally {
      auxiliaryLibraryOperationCount -= 1
    }
  }

  /** Tasks that block almost everything, including account switching. */
  const exclusiveTask = (): string | null => {
    if (updateInstallOperationActive) return '更新安装正在启动'
    if (conversationDeleteOperationActive) return '对话删除正在运行'
    if (sessionRepairOperationActive) return '历史会话修复正在运行'
    if (restartOperationActive) return 'Codex 重启正在运行'
    if (switchOperationActive) return '账号切换或恢复正在运行'
    if (accountLibraryOperationActive) return 'Codex 账号库操作正在运行'
    if (auxiliaryLibraryOperationCount > 0) return '账号文件操作正在运行'
    if (autoSwitchOperationActive) return '自动检测或切换正在运行'
    return null
  }

  /** Background account tests may continue while switching; they still block other tests/mutations. */
  const runningTask = (): string | null => {
    if (testController) return 'Codex 账号检测正在运行'
    if (grokTestController) return 'Grok 账号检测正在运行'
    if (cpaGrokTestController) return 'CPA Grok 账号检测正在运行'
    if (cpaCodexTestController) return 'CPA Codex 账号检测正在运行'
    if (importPreviewTestController) return '导入凭证检测正在运行'
    return exclusiveTask()
  }

  /** Account switch / custom API / restore only wait for exclusive ops, not background tests. */
  const switchBlockingTask = (): string | null => exclusiveTask()

  const assertNoRunningTask = (action: string): void => {
    const task = runningTask()
    if (task) throw new Error(`${task}，暂时不能${action}`)
  }

  const initialScan = runAccountLibraryMutation(async () => {
    let managedLibraryExists = false
    try {
      managedLibraryExists = (await stat(codexImportDirectory)).isDirectory()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!managedLibraryExists) {
      for (const directory of legacyImportDirectories) {
        await manager.migrateManagedDirectory(directory)
      }
      try {
        managedLibraryExists = (await stat(codexImportDirectory)).isDirectory()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (!managedLibraryExists) await manager.rebuildManagedLibraryFromVault()
    }
    return manager.scanDirectory()
  })
  const initialGrokScan = grokManager.scanDirectory().catch(() => null)
  const initialCpaGrokScan = cpaGrokManager.scanDirectory().catch(() => null)
  const initialCpaCodexScan = cpaCodexManager.scanDirectory().then(async (result) => {
    const cpaStatuses = await cpaCodexStatusStore.getAll()
    if (Object.keys(cpaStatuses).length === 0) {
      const legacyStatuses = await statusStore.getAll()
      await cpaCodexStatusStore.setMany(
        result.accounts.flatMap((account) => {
          const legacy = legacyStatuses[account.id]
          return legacy ? [legacy] : []
        })
      )
      await reconcileCodexStatusStores()
    }
    return result
  }).catch(() => null)

  let cachedConversationManager: { codexHome: string; manager: ConversationManager } | null = null
  const sendSessionRepairProgress = (next: SessionRepairProgress): void => {
    sessionRepairProgress = next
    mainWindow?.webContents.send(ipcChannels.sessionRepairProgress, sessionRepairProgress)
  }
  const sessionRepairService = async (): Promise<SessionRepairService> => {
    const settings = await settingsStore.get()
    return new SessionRepairService({
      codexHome: dirname(settings.configPath),
      backupRetention: settings.backupRetention,
      onProgress: (progress) => sendSessionRepairProgress({ active: true, ...progress })
    })
  }
  const restartCodexAfterSessionSync = async (
    beforeRepair?: () => Promise<void>
  ): Promise<{ ok: boolean; message: string }> =>
    processManager.restart(async () => {
      sessionRepairOperationActive = true
      sendSessionRepairProgress({ active: true, done: 0, total: 6, message: 'Codex 已关闭，正在准备修复对话' })
      try {
        await beforeRepair?.()
        const service = await sessionRepairService()
        const preview = await service.preview()
        const repaired = await service.apply(preview.snapshotId, preview.targetProvider)
        if (!repaired.ok) throw new Error(repaired.message)
        cachedConversationManager?.manager.invalidate()
      } finally {
        sessionRepairOperationActive = false
        sendSessionRepairProgress({ ...sessionRepairProgress, active: false })
      }
    })
  const conversationManager = async (): Promise<ConversationManager> => {
    const settings = await settingsStore.get()
    const codexHome = resolve(dirname(settings.configPath))
    if (cachedConversationManager?.codexHome !== codexHome) {
      const cacheFile = join(app.getPath('userData'), 'cache', 'conversation-index-v2.json')
      cachedConversationManager = { codexHome, manager: new ConversationManager(codexHome, cacheFile) }
    }
    return cachedConversationManager.manager
  }

  const sendProgress = (next: TestProgress): void => {
    progress = {
      ...next,
      updatedAccount: next.updatedAccount
        ? accountMetadataStore.decorate(next.updatedAccount)
        : null
    }
    mainWindow?.webContents.send(ipcChannels.testProgress, progress)
  }

  const sendGrokProgress = (next: GrokTestProgress): void => {
    grokProgress = {
      ...next,
      updatedAccount: next.updatedAccount
        ? accountMetadataStore.decorate(next.updatedAccount)
        : null
    }
    mainWindow?.webContents.send(ipcChannels.grokTestProgress, grokProgress)
  }

  const sendCpaGrokProgress = (next: GrokTestProgress): void => {
    cpaGrokProgress = {
      ...next,
      updatedAccount: next.updatedAccount
        ? accountMetadataStore.decorate(next.updatedAccount)
        : null
    }
    mainWindow?.webContents.send(ipcChannels.cpaGrokTestProgress, cpaGrokProgress)
  }

  const sendCpaCodexProgress = (next: CpaCodexTestProgress): void => {
    cpaCodexProgress = {
      ...next,
      updatedAccount: next.updatedAccount
        ? accountMetadataStore.decorate(next.updatedAccount)
        : null
    }
    mainWindow?.webContents.send(ipcChannels.cpaCodexTestProgress, cpaCodexProgress)
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
      const task = runningTask()
      if (task) throw new Error(`${task}，本次自动检查已跳过`)
      autoSwitchOperationActive = true
      const settings = await settingsStore.get()
      sendProgress({ active: true, done: 0, total: settings.autoSwitchAccountIds.length + 1, runningIds: [], updatedAccount: null })
      try {
        const result = await manager.autoSwitch(settings.autoSwitchAccountIds, ({ done, total, runningIds, updatedAccount }) => {
          sendProgress({ active: true, done, total, runningIds, updatedAccount: updatedAccount ?? null })
        })
        if (result.switched && settings.autoSwitchRestartCodex) {
          const restarted = await restartCodexAfterSessionSync()
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
      if (shouldNotifyAutoSwitchCompletion(previousAutoSwitchState, state, isQuitting)) {
        showTrayMessage('自动切换完成', state.lastMessage)
      }
      previousAutoSwitchState = state
      void rebuildTrayMenu()
    }
  })

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  let availableUpdate: { version: string; expectedSha512: string; url?: string } | null = null
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
      ? {
          version: info.version,
          expectedSha512: setupFile.sha512,
          url: typeof setupFile.url === 'string' ? setupFile.url : undefined
        }
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
  autoUpdater.on('error', (error) => {
    const detail = error instanceof Error ? error.message.trim() : String(error ?? '')
    const short =
      /latest\.yml/i.test(detail) ? '更新元数据 latest.yml 缺失或不可访问'
      : /404/.test(detail) ? '更新资源不存在（404）'
      : /ENOTFOUND|ECONN|network|timed out/i.test(detail) ? '网络异常，无法检查更新'
      : detail ? detail.slice(0, 160) : '请稍后重试'
    sendUpdateState({
      ...updateState,
      status: 'error',
      percent: null,
      message: `更新检查或下载失败：${short}`
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
    await Promise.all([initialScan, initialGrokScan, initialCpaCodexScan, initialCpaGrokScan, metadataReady()])
    const settings = await settingsStore.get()
    const [accounts, grokAccounts, cpaCodexAccounts, cpaGrokAccounts, customApi] = await Promise.all([
      manager.listAccounts(),
      grokManager.listAccounts(),
      cpaCodexManager.listAccounts(),
      cpaGrokManager.listAccounts(),
      customApiStore.summary({ baseUrl: settings.customApiBaseUrl, model: settings.customApiModel })
    ])
    return {
      accounts: decorateAccounts(accounts),
      settings,
      importDirectory,
      testing: progress,
      autoSwitch: autoSwitchScheduler.getState(),
      grokAccounts: decorateAccounts(grokAccounts),
      cpaGrokAccounts: decorateAccounts(cpaGrokAccounts),
      grokDirectory: settings.grokDirectory,
      grokTesting: grokProgress,
      cpaGrokTesting: cpaGrokProgress,
      cpaCodexAccounts: decorateAccounts(cpaCodexAccounts),
      cpaCodexTesting: cpaCodexProgress,
      cpaDirectoryStats: await readCpaDirectoryStats(settings.grokDirectory),
      customApi
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
  const importAnyFiles = async (paths: string[]) => {
    return runAccountLibraryMutation(async () => {
      const [codex, grok] = await Promise.all([
        manager.importFiles(paths, { archiveSources: true }),
        grokManager.importFiles(paths)
      ])
      return combineLibraryImportResults(codex, grok)
    })
  }
  const importAnyDirectory = async (directory: string) => {
    return runAccountLibraryMutation(async () => {
      const [codex, grok] = await Promise.all([
        manager.importDirectory(directory),
        grokManager.importDirectory(directory)
      ])
      return combineLibraryImportResults(codex, grok)
    })
  }
  const importAnyPasted = async (text: string) => {
    return runAccountLibraryMutation(async () => {
      const [codex, grok] = await Promise.all([
        manager.importPasted(text),
        grokManager.importPasted(text)
      ])
      return combineLibraryImportResults(codex, grok)
    })
  }
  ipcMain.handle(ipcChannels.importAny, async () => {
    const result = await dialog.showOpenDialog({
      title: '导入 Codex / Grok 账号文件到 aa',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '账号文件', extensions: ['json', 'jsonl', 'txt', 'md', 'js', 'mjs', 'cjs', 'zip'] }]
    })
    return result.canceled ? null : importAnyFiles(result.filePaths)
  })
  ipcMain.handle(ipcChannels.importAnyDirectory, async () => {
    let directory: string | null = null
    if (e2eMode && process.env.CODEX_SWITCHER_E2E_IMPORT_DIR) {
      directory = resolve(process.env.CODEX_SWITCHER_E2E_IMPORT_DIR)
    } else {
      const settings = await settingsStore.get()
      const result = await dialog.showOpenDialog({
        title: '导入文件夹内的 Codex / Grok 账号到 aa',
        defaultPath: settings.accountDirectory,
        properties: ['openDirectory']
      })
      if (!result.canceled) directory = result.filePaths[0]
    }
    return directory ? importAnyDirectory(directory) : null
  })
  ipcMain.handle(ipcChannels.importAnyPasted, (_event, input: unknown) =>
    importAnyPasted(z.string().min(1).max(100 * 1024 * 1024).parse(input)))
  const createMixedImportPreview = async (paths: string[]) => {
    const [codex, grok] = await Promise.all([
      manager.prepareFiles(paths),
      grokManager.prepareFiles(paths)
    ])
    return importPreviewService.create(codex, grok)
  }
  ipcMain.handle(ipcChannels.importPreviewFiles, async () => {
    assertNoRunningTask('预检导入账号')
    const selected = await dialog.showOpenDialog({
      title: '选择要预检的 Codex / Grok 账号文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '账号文件', extensions: ['json', 'jsonl', 'txt', 'md', 'js', 'mjs', 'cjs', 'zip'] }]
    })
    return selected.canceled
      ? null
      : runTrackedFileOperation(() => createMixedImportPreview(selected.filePaths))
  })
  ipcMain.handle(ipcChannels.importPreviewDirectory, async () => {
    assertNoRunningTask('预检导入账号')
    let directory: string | null = null
    if (e2eMode && process.env.CODEX_SWITCHER_E2E_IMPORT_DIR) {
      directory = resolve(process.env.CODEX_SWITCHER_E2E_IMPORT_DIR)
    } else {
      const settings = await settingsStore.get()
      const selected = await dialog.showOpenDialog({
        title: '选择要预检的账号文件夹',
        defaultPath: settings.accountDirectory,
        properties: ['openDirectory']
      })
      if (!selected.canceled) directory = selected.filePaths[0]
    }
    if (!directory) return null
    return runTrackedFileOperation(async () => {
      const [codex, grok] = await Promise.all([
        manager.prepareDirectory(directory),
        grokManager.prepareDirectory(directory)
      ])
      return importPreviewService.create(codex, grok)
    })
  })
  ipcMain.handle(ipcChannels.importPreviewPasted, async (_event, input: unknown) => {
    assertNoRunningTask('预检导入账号')
    const text = z.string().min(1).max(100 * 1024 * 1024).parse(input)
    return runTrackedFileOperation(async () => {
      const [codex, grok] = await Promise.all([
        manager.preparePasted(text),
        grokManager.preparePasted(text)
      ])
      return importPreviewService.create(codex, grok, text)
    })
  })
  ipcMain.handle(ipcChannels.importPreviewRefreshTokens, async (_event, input: unknown) => {
    assertNoRunningTask('预检 Refresh Token')
    const payload = z.object({
      text: z.string().min(1).max(100 * 1024 * 1024),
      mode: z.enum(['auto', 'codex', 'mobile'])
    }).parse(input)
    return runTrackedFileOperation(async () => {
      const codex = await manager.prepareRefreshTokens(payload.text, payload.mode)
      return importPreviewService.create(codex, {
        credentials: [], errors: [], recognized: 0, sourceCount: codex.sourceCount, unrecognized: []
      }, payload.text)
    })
  })
  ipcMain.handle(ipcChannels.importPreviewOAuthComplete, async (_event, input: unknown) => {
    assertNoRunningTask('预检 OAuth 凭证')
    const payload = z.object({
      sessionId: z.string().length(32),
      callbackInput: z.string().min(1).max(16 * 1024)
    }).parse(input)
    return runTrackedFileOperation(async () => {
      const codex = await manager.prepareOAuthAuthorization(payload.sessionId, payload.callbackInput)
      return importPreviewService.create(codex, {
        credentials: [], errors: [], recognized: 0, sourceCount: codex.sourceCount, unrecognized: []
      }, payload.callbackInput)
    })
  })
  ipcMain.handle(ipcChannels.importPreviewCommit, async (_event, input: unknown) => {
    const payload = z.object({
      sessionId: z.string().uuid(),
      decisions: z.record(z.string().min(1).max(256), z.enum(['add', 'replace', 'skip'])),
      skipUnrecognized: z.boolean().optional()
    }).parse(input)
    const result = await runAccountLibraryMutation(() => importPreviewService.commit(payload))
    return {
      ...result,
      accounts: decorateAccounts(result.accounts),
      grokAccounts: decorateAccounts(result.grokAccounts)
    }
  })
  ipcMain.handle(ipcChannels.importPreviewRefine, async (_event, input: unknown) => {
    assertNoRunningTask('重新识别凭据')
    const payload = z.object({
      sessionId: z.string().uuid(),
      sourceKey: z.string().min(1).max(512),
      mode: z.enum(['codex', 'grok', 'codex_rt', 'mobile_rt'])
    }).parse(input)
    return runTrackedFileOperation(() => importPreviewService.refine(payload))
  })
  ipcMain.handle(ipcChannels.importPreviewTest, async (event, input: unknown) => {
    assertNoRunningTask('检测导入凭证')
    const payload = z.object({
      sessionId: z.string().uuid(),
      itemKeys: z.array(z.string().min(1).max(256)).min(1).max(20_000).optional()
    }).parse(input)
    importPreviewTestController = new AbortController()
    importPreviewTestSessionId = payload.sessionId
    let latestProgress: ImportPreviewTestProgress = {
      active: true,
      sessionId: payload.sessionId,
      done: 0,
      total: payload.itemKeys?.length ?? 0,
      runningKeys: [],
      updatedItem: null
    }
    const sendImportPreviewProgress = (next: ImportPreviewTestProgress): void => {
      latestProgress = next
      if (!event.sender.isDestroyed()) {
        event.sender.send(ipcChannels.importPreviewTestProgress, next)
      }
    }
    try {
      return await importPreviewService.test(payload, {
        signal: importPreviewTestController.signal,
        onProgress: ({ done, total, runningKeys, updatedItem }) =>
          sendImportPreviewProgress({
            active: true,
            sessionId: payload.sessionId,
            done,
            total,
            runningKeys,
            updatedItem: updatedItem ?? null
          })
      })
    } finally {
      importPreviewTestController = null
      importPreviewTestSessionId = null
      sendImportPreviewProgress({
        ...latestProgress,
        active: false,
        runningKeys: [],
        updatedItem: null
      })
    }
  })
  ipcMain.handle(ipcChannels.importPreviewCancelTest, () => {
    importPreviewTestController?.abort()
  })
  ipcMain.handle(ipcChannels.importPreviewDiscard, (_event, input: unknown) => {
    const sessionId = z.string().uuid().parse(input)
    if (importPreviewTestSessionId === sessionId) importPreviewTestController?.abort()
    importPreviewService.discard(sessionId)
  })
  ipcMain.handle(ipcChannels.importRefreshTokens, (_event, input: unknown) => {
    const payload = z.object({
      text: z.string().min(1).max(100 * 1024 * 1024),
      mode: z.enum(['auto', 'codex', 'mobile'])
    }).parse(input)
    return runAccountLibraryMutation(() => manager.importRefreshTokens(payload.text, payload.mode))
  })
  ipcMain.handle(ipcChannels.oauthStart, async () => {
    const session = manager.startOAuthAuthorization()
    await shell.openExternal(session.authUrl)
    return session
  })
  ipcMain.handle(ipcChannels.oauthComplete, (_event, input: unknown) => {
    const payload = z.object({
      sessionId: z.string().length(32),
      callbackInput: z.string().min(1).max(16 * 1024)
    }).parse(input)
    return runAccountLibraryMutation(() =>
      manager.completeOAuthAuthorization(payload.sessionId, payload.callbackInput))
  })
  ipcMain.handle(ipcChannels.deleteAccounts, async (_event, input: unknown) => {
    const ids = z.array(z.string().min(1)).min(1).max(20_000).parse(input)
    const result = await runAccountLibraryMutation(() => manager.deleteAccounts(ids))
    await autoSwitchScheduler.settingsChanged()
    return result
  })
  ipcMain.handle(ipcChannels.accountMetadataUpdate, async (_event, input: unknown) => {
    assertNoRunningTask('修改账号标签')
    const payload = z.object({
      accountIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(20_000),
      alias: z.string().max(120).nullable().optional(),
      group: z.string().max(80).nullable().optional(),
      tags: z.array(z.string().max(48)).max(24).optional(),
      tagMode: z.enum(['replace', 'add', 'remove']).optional(),
      note: z.string().max(2_000).nullable().optional()
    }).parse(input)
    const ids = [...new Set(payload.accountIds)]
    if (ids.length > 1 && ('alias' in payload || 'note' in payload)) {
      throw new Error('别名和备注只能对单个账号设置')
    }
    const [codex, grok, cpaCodex, cpaGrok] = await Promise.all([
      manager.listAccounts(),
      grokManager.listAccounts(),
      cpaCodexManager.listAccounts(),
      cpaGrokManager.listAccounts()
    ])
    const available = new Set([...codex, ...grok, ...cpaCodex, ...cpaGrok].map((account) => account.id))
    const missing = ids.find((id) => !available.has(id))
    if (missing) throw new Error(`账号不存在或已被删除：${missing}`)
    await runTrackedFileOperation(() =>
      accountMetadataStore.update({ ...payload, accountIds: ids })
    )
  })
  ipcMain.handle(ipcChannels.libraryHealthInspect, async () => {
    assertNoRunningTask('检查账号库')
    return runTrackedFileOperation(() => libraryHealthService.inspect())
  })
  ipcMain.handle(ipcChannels.libraryHealthRepair, async (_event, input: unknown) => {
    assertNoRunningTask('修复账号库')
    const payload = z.object({
      snapshotId: z.string().uuid(),
      issueIds: z.array(z.string().regex(/^[a-f0-9]{24}$/)).min(1).max(30_000)
    }).parse(input)
    const result = await runAccountLibraryMutation(() =>
      libraryHealthService.repair(payload.snapshotId, payload.issueIds)
    )
    await autoSwitchScheduler.settingsChanged()
    return result
  })
  ipcMain.handle(ipcChannels.exportAccounts, async (_event, input: unknown) => {
    const prioritySchema = z.number().int().min(0).max(1_000_000)
    const payload = z
      .object({
        accountIds: z.array(z.string().min(1)).min(1).max(20_000),
        format: z.enum(['cpa', 'sub2api', 'codex']),
        layout: z.enum(['separate', 'bundle']),
        defaultPriority: prioritySchema.optional(),
        priorities: z.record(z.string().min(1), prioritySchema).optional()
      })
      .parse(input)
    const selectedIds = new Set(payload.accountIds)
    if (Object.keys(payload.priorities ?? {}).some((id) => !selectedIds.has(id))) {
      throw new Error('逐账号优先级包含未选择的账号')
    }
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
    return runTrackedFileOperation(() => exporter.exportAccounts({ ...payload, outputDirectory }))
  })
  ipcMain.handle(ipcChannels.exportAccountsToCpa, async (_event, input: unknown) => {
    const prioritySchema = z.number().int().min(0).max(1_000_000)
    const payload = z.object({
      accountIds: z.array(z.string().min(1)).min(1).max(20_000),
      defaultPriority: prioritySchema.default(10),
      priorities: z.record(z.string().min(1), prioritySchema).optional()
    }).parse(input)
    const selectedIds = new Set(payload.accountIds)
    if (Object.keys(payload.priorities ?? {}).some((id) => !selectedIds.has(id))) {
      throw new Error('逐账号优先级包含未选择的账号')
    }
    const all = new Map((await vault.list()).map((credential) => [credential.id, credential]))
    const credentials = [...new Set(payload.accountIds)].map((id) => {
      const credential = all.get(id)
      if (!credential) throw new Error(`账号不存在：${id}`)
      return credential
    })
    return runTrackedFileOperation(() =>
      cpaCodexManager.exportCredentials(credentials, payload.defaultPriority, payload.priorities)
    )
  })
  ipcMain.handle(ipcChannels.test, async (_event, input: unknown) => {
    if (testController) throw new Error('已有检测任务正在运行')
    if (switchOperationActive) throw new Error('账号切换或恢复进行中，暂时不能检测账号')
    if (accountLibraryOperationActive) throw new Error('账号库正在导入、扫描或删除，暂时不能检测账号')
    if (autoSwitchOperationActive) throw new Error('自动检测或切换正在运行')
    const payload = z.object({
      ids: z.array(z.string().min(1)).optional(),
      mode: z.enum(['usage', 'full', 'refresh']).default('full')
    }).parse(input)
    const ids = payload.ids
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
        mode: payload.mode,
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
    const task = switchBlockingTask()
    if (task) return { ok: false, message: `${task}，暂时不能切换账号`, backupPath: null }
    const payload = z.object({ id: z.string().min(1), restart: z.boolean() }).parse(input)
    switchOperationActive = true
    try {
      const operation: { result?: Awaited<ReturnType<typeof manager.switchAccount>> } = {}
      const restartResult = await restartCodexAfterSessionSync(async () => {
        operation.result = await manager.switchAccount(payload.id)
        if (!operation.result.ok) throw new Error(operation.result.message)
      })
      const result = operation.result
      if (!result) {
        return { ok: false, message: restartResult.message, backupPath: null, restartResult }
      }
      return {
        ...result,
        message: result.ok && restartResult.ok
          ? `${result.message}；${restartResult.message}`
          : `${result.message}；${restartResult.message}`,
        restartResult
      }
    } finally {
      switchOperationActive = false
    }
  })
  ipcMain.handle(ipcChannels.restore, async (_event, input: unknown) => {
    const task = switchBlockingTask()
    if (task) return { ok: false, message: `${task}，暂时不能恢复配置`, backupPath: null }
    const payload = z.object({ restart: z.boolean() }).parse(input)
    switchOperationActive = true
    try {
      const operation: { result?: Awaited<ReturnType<typeof manager.restoreLatest>> } = {}
      const restartResult = await restartCodexAfterSessionSync(async () => {
        operation.result = await manager.restoreLatest()
        if (!operation.result.ok) throw new Error(operation.result.message)
      })
      const result = operation.result
      if (!result) {
        return { ok: false, message: restartResult.message, backupPath: null, restartResult }
      }
      return { ...result, restartResult, message: `${result.message}；${restartResult.message}` }
    } finally {
      switchOperationActive = false
    }
  })
  ipcMain.handle(ipcChannels.restoreApiMode, async (_event, input: unknown) => {
    const task = switchBlockingTask()
    if (task) return { ok: false, message: `${task}，暂时不能恢复 API 模式`, backupPath: null }
    const payload = z.object({ restart: z.boolean() }).parse(input)
    switchOperationActive = true
    try {
      const operation: { result?: Awaited<ReturnType<typeof manager.restoreApiMode>> } = {}
      const restartResult = await restartCodexAfterSessionSync(async () => {
        operation.result = await manager.restoreApiMode()
        if (!operation.result.ok) throw new Error(operation.result.message)
      })
      const result = operation.result
      if (!result) {
        return { ok: false, message: restartResult.message, backupPath: null, restartResult }
      }
      return { ...result, restartResult, message: `${result.message}；${restartResult.message}` }
    } finally {
      switchOperationActive = false
    }
  })
  ipcMain.handle(ipcChannels.customApiProfile, async () => {
    const settings = await settingsStore.get()
    return customApiStore.summary({ baseUrl: settings.customApiBaseUrl, model: settings.customApiModel })
  })
  ipcMain.handle(ipcChannels.customApiListModels, async (_event, input: unknown) => {
    const payload = z
      .object({
        baseUrl: z.string().max(2048),
        apiKey: z.string().max(8192).optional()
      })
      .parse(input ?? {})
    let baseUrl: string
    try {
      baseUrl = normalizeCustomApiBaseUrl(payload.baseUrl)
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : '自定义 API 地址无效',
        models: [] as string[],
        baseUrl: ''
      }
    }
    const providedKey = payload.apiKey?.trim() ?? ''
    const apiKey = providedKey || (await customApiStore.getKey())
    if (!apiKey) {
      return { ok: false as const, message: '请填写 API Key 或先保存 Key', models: [] as string[], baseUrl }
    }
    try {
      const settings = await settingsStore.get()
      const listed = await fetchOpenAiCompatibleModelIds({
        baseUrl,
        apiKey,
        timeoutMs: settings.timeoutMs
      })
      if (listed.models.length === 0) {
        const detail = listed.errors.slice(0, 4).join('；')
        return {
          ok: false as const,
          message: `未能从 ${listed.modelsUrl} 获取模型列表。请检查 API 地址、Key 权限，以及服务是否实现 GET /v1/models${detail ? `：${detail}` : ''}`,
          models: [] as string[],
          baseUrl: listed.baseUrl,
          modelsUrl: listed.modelsUrl
        }
      }
      return {
        ok: true as const,
        message:
          listed.models.length > 0
            ? `已从 ${listed.modelsUrl} 获取 ${listed.models.length} 个模型`
            : `已尝试多路径，但 ${listed.baseUrl} 未返回模型`,
        models: listed.models,
        baseUrl: listed.baseUrl,
        modelsUrl: listed.modelsUrl
      }
    } catch (error) {
      return {
        ok: false as const,
        message: error instanceof Error ? error.message : '获取模型列表失败',
        models: [] as string[],
        baseUrl
      }
    }
  })
  ipcMain.handle(ipcChannels.customApiSwitch, async (_event, input: unknown) => {
    const task = switchBlockingTask()
    if (task) return { ok: false, message: `${task}，暂时不能切换 API`, backupPath: null }
    const payload = z.object({
      profile: z.object({
        baseUrl: z.string().min(1).max(2048),
        model: z.string().min(1).max(128),
        apiKey: z.string().max(16_384).optional(),
        models: z.array(z.string().max(128)).max(500).optional(),
        syncModelCatalog: z.boolean().optional(),
        force: z.boolean().optional()
      }),
      restart: z.boolean()
    }).parse(input)

    let baseUrl: string
    const model = payload.profile.model.trim()
    try {
      baseUrl = normalizeCustomApiBaseUrl(payload.profile.baseUrl)
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : '自定义 API 地址无效',
        backupPath: null
      }
    }
    if (!model) {
      return { ok: false, message: '请先填写要测试的模型名称；测试通过后再自动拉取模型列表', backupPath: null }
    }
    if (model.length > 128 || !/^[A-Za-z0-9._:\/-]+$/.test(model)) {
      return { ok: false, message: '模型名称无效', backupPath: null }
    }

    const providedKey = payload.profile.apiKey?.trim() ?? ''
    const apiKey = providedKey || (await customApiStore.getKey())
    if (!apiKey) return { ok: false, message: '请先填写自定义 API Key', backupPath: null }

    switchOperationActive = true
    try {
      let verifiedProbe: Awaited<ReturnType<typeof probeCustomApiModel>> | undefined
      let forceProbeFailure = ''
      try {
        verifiedProbe = await probeCustomApiModel({
          baseUrl: payload.profile.baseUrl,
          model,
          apiKey
        })
      } catch (error) {
        forceProbeFailure = error instanceof Error ? error.message : '上游请求失败'
        if (!payload.profile.force) {
          return {
            ok: false,
            canForce: true,
            message: `自定义 API 真实 hi 测试未通过，未关闭 Codex，也未修改配置：${forceProbeFailure}。可以在确认风险后强制切换`,
            backupPath: null
          }
        }
      }
      const result = await switcher.switchToCustomApi({
        baseUrl: payload.profile.baseUrl,
        model,
        apiKey,
        ...(verifiedProbe ? { verifiedProbe } : { forceProbeFailure }),
        ...(payload.profile.models ? { models: payload.profile.models } : {}),
        syncModelCatalog: payload.profile.syncModelCatalog !== false
      })
      if (!result.ok) return result

      const savedModel = result.selectedModel?.trim() || model
      const savedBase = result.discoveredBaseUrl?.trim() || baseUrl
      await settingsStore.update({
        customApiBaseUrl: savedBase,
        customApiModel: savedModel
      })
      if (providedKey) await customApiStore.saveKey(providedKey)
      await customApiStore.saveModels(payload.profile.syncModelCatalog === false
        ? (payload.profile.models ?? [])
        : (result.catalogModels ?? [savedModel]))
      return result
    } finally {
      switchOperationActive = false
    }
  })

  ipcMain.handle(ipcChannels.grokScan, () => {
    if (grokTestController) throw new Error('Grok 检测正在运行')
    return runTrackedFileOperation(() => grokManager.scanDirectory())
  })
  ipcMain.handle(ipcChannels.grokImport, async () => {
    if (grokTestController) throw new Error('Grok 检测正在运行')
    const selected = await dialog.showOpenDialog({
      title: '导入 Grok 账号文件',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '账号文件', extensions: ['json', 'jsonl', 'txt', 'md', 'js', 'mjs', 'cjs', 'zip'] }]
    })
    return selected.canceled ? null : runTrackedFileOperation(() => grokManager.importFiles(selected.filePaths))
  })
  ipcMain.handle(ipcChannels.grokImportDirectory, async () => {
    if (grokTestController) throw new Error('Grok 检测正在运行')
    const settings = await settingsStore.get()
    const selected = await dialog.showOpenDialog({
      title: '导入文件夹内的 Grok 账号',
      defaultPath: settings.grokDirectory,
      properties: ['openDirectory']
    })
    return selected.canceled ? null : runTrackedFileOperation(() => grokManager.importDirectory(selected.filePaths[0]))
  })
  ipcMain.handle(ipcChannels.grokImportPasted, (_event, input: unknown) => {
    if (grokTestController) throw new Error('Grok 检测正在运行')
    const text = z.string().min(1).max(100 * 1024 * 1024).parse(input)
    return runTrackedFileOperation(() => grokManager.importPasted(text))
  })
  ipcMain.handle(ipcChannels.grokDelete, (_event, input: unknown) => {
    if (grokTestController) throw new Error('Grok 检测正在运行')
    const ids = z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(20_000).parse(input)
    return runTrackedFileOperation(() => grokManager.deleteAccounts(ids))
  })
  ipcMain.handle(ipcChannels.grokSetEnabled, (_event, input: unknown) => {
    if (grokTestController) throw new Error('Grok 检测正在运行')
    const payload = z.object({
      ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(20_000),
      enabled: z.boolean()
    }).parse(input)
    return runTrackedFileOperation(() => grokManager.setEnabled(payload.ids, payload.enabled))
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
    return selected.canceled
      ? null
      : runTrackedFileOperation(() => grokManager.exportAccounts(payload.ids, payload.layout, selected.filePaths[0]))
  })
  ipcMain.handle(ipcChannels.grokExportToCpa, async (_event, input: unknown) => {
    const ids = z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(20_000).parse(input)
    return runTrackedFileOperation(() => grokManager.copyAccountsTo(ids, cpaGrokManager))
  })
  ipcMain.handle(ipcChannels.cpaGrokScan, () => {
    if (cpaGrokTestController) throw new Error('CPA Grok 检测正在运行')
    return runTrackedFileOperation(() => cpaGrokManager.scanDirectory())
  })
  ipcMain.handle(ipcChannels.cpaGrokSyncToLibrary, (_event, input: unknown) => {
    if (cpaGrokTestController) throw new Error('CPA Grok 检测正在运行')
    const ids = z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(20_000).optional().parse(input)
    return runAccountLibraryMutation(() => cpaGrokManager.copyAccountsTo(ids, grokManager))
  })
  ipcMain.handle(ipcChannels.cpaGrokDelete, (_event, input: unknown) => {
    if (cpaGrokTestController) throw new Error('CPA Grok 检测正在运行')
    const ids = z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(20_000).parse(input)
    return runTrackedFileOperation(() => cpaGrokManager.deleteAccounts(ids))
  })
  ipcMain.handle(ipcChannels.cpaGrokSetEnabled, (_event, input: unknown) => {
    if (cpaGrokTestController) throw new Error('CPA Grok 检测正在运行')
    const payload = z.object({
      ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(20_000),
      enabled: z.boolean()
    }).parse(input)
    return runTrackedFileOperation(() => cpaGrokManager.setEnabled(payload.ids, payload.enabled))
  })
  ipcMain.handle(ipcChannels.cpaGrokTest, async (_event, input: unknown) => {
    if (cpaGrokTestController) throw new Error('已有 CPA Grok 检测任务正在运行')
    const ids = z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional().parse(input)
    cpaGrokTestController = new AbortController()
    sendCpaGrokProgress({ active: true, done: 0, total: ids?.length ?? (await cpaGrokManager.listAccounts()).length, runningIds: [], updatedAccount: null })
    try {
      return await cpaGrokManager.testAccounts(ids, {
        signal: cpaGrokTestController.signal,
        onProgress: ({ done, total, runningIds, updatedAccount }) => sendCpaGrokProgress({
          active: true, done, total, runningIds, updatedAccount: updatedAccount ?? null
        })
      })
    } finally {
      cpaGrokTestController = null
      sendCpaGrokProgress({ ...cpaGrokProgress, active: false, runningIds: [], updatedAccount: null })
    }
  })
  ipcMain.handle(ipcChannels.cpaGrokCancelTest, () => cpaGrokTestController?.abort())
  ipcMain.handle(ipcChannels.cpaCodexScan, () => {
    if (cpaCodexTestController) throw new Error('CPA Codex 检测正在运行')
    return runTrackedFileOperation(() => cpaCodexManager.scanDirectory())
  })
  ipcMain.handle(ipcChannels.cpaCodexSyncToLibrary, (_event, input: unknown) => {
    if (cpaCodexTestController) throw new Error('CPA Codex 检测正在运行')
    const ids = z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(20_000).optional().parse(input)
    return runAccountLibraryMutation(() => cpaCodexManager.copyAccountsTo(ids, manager))
  })
  ipcMain.handle(ipcChannels.cpaCodexDelete, (_event, input: unknown) => {
    if (cpaCodexTestController) throw new Error('CPA Codex 检测正在运行')
    const ids = z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(20_000).parse(input)
    return runTrackedFileOperation(() => cpaCodexManager.deleteAccounts(ids))
  })
  ipcMain.handle(ipcChannels.cpaCodexSetEnabled, (_event, input: unknown) => {
    if (cpaCodexTestController) throw new Error('CPA Codex 检测正在运行')
    const payload = z.object({
      ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(20_000),
      enabled: z.boolean()
    }).parse(input)
    return runTrackedFileOperation(() => cpaCodexManager.setEnabled(payload.ids, payload.enabled))
  })
  ipcMain.handle(ipcChannels.cpaCodexTest, async (_event, input: unknown) => {
    if (cpaCodexTestController) throw new Error('已有 CPA Codex 检测任务正在运行')
    const payload = z.object({
      ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
      mode: z.enum(['usage', 'full', 'refresh']).default('full')
    }).parse(input)
    const ids = payload.ids
    cpaCodexTestController = new AbortController()
    sendCpaCodexProgress({
      active: true,
      done: 0,
      total: ids?.length ?? (await cpaCodexManager.listAccounts()).length,
      runningIds: [],
      updatedAccount: null
    })
    try {
      return await cpaCodexManager.testAccounts(ids, {
        signal: cpaCodexTestController.signal,
        mode: payload.mode,
        onProgress: ({ done, total, runningIds, updatedAccount }) => sendCpaCodexProgress({
          active: true,
          done,
          total,
          runningIds,
          updatedAccount: updatedAccount ?? null
        })
      })
    } finally {
      cpaCodexTestController = null
      sendCpaCodexProgress({ ...cpaCodexProgress, active: false, runningIds: [], updatedAccount: null })
    }
  })
  ipcMain.handle(ipcChannels.cpaCodexCancelTest, () => cpaCodexTestController?.abort())
  ipcMain.handle(ipcChannels.restart, async () => {
    const task = runningTask()
    if (task) return { ok: false, message: `${task}，暂时不能重启 Codex` }
    restartOperationActive = true
    try {
      return await restartCodexAfterSessionSync()
    } finally {
      restartOperationActive = false
    }
  })
  ipcMain.handle(ipcChannels.settingsUpdate, async (_event, input: unknown) => {
    assertNoRunningTask('修改设置')
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
      title: '选择 CPA 共享账号目录（Codex + Grok）',
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
  ipcMain.handle(ipcChannels.snapshotPage, async (_event, input: unknown) => {
    const scope = z.enum(['accounts', 'grok', 'cpa', 'automation']).parse(input)
    const scopeReady =
      scope === 'accounts' || scope === 'automation'
        ? initialScan
        : scope === 'grok'
          ? initialGrokScan
          : Promise.all([initialCpaCodexScan, initialCpaGrokScan])
    await Promise.all([scopeReady, metadataReady()])

    const settings = await settingsStore.get()
    const base = {
      settings,
      importDirectory,
      autoSwitch: autoSwitchScheduler.getState(),
      customApi: await customApiStore.summary({
        baseUrl: settings.customApiBaseUrl,
        model: settings.customApiModel
      })
    }
    if (scope === 'accounts' || scope === 'automation') {
      return { ...base, accounts: decorateAccounts(await manager.listAccounts()), testing: progress }
    }
    if (scope === 'grok') {
      return { ...base, grokAccounts: decorateAccounts(await grokManager.listAccounts()), grokTesting: grokProgress }
    }
    const [cpaCodexAccounts, cpaGrokAccounts, cpaDirectoryStats] = await Promise.all([
      cpaCodexManager.listAccounts(),
      cpaGrokManager.listAccounts(),
      readCpaDirectoryStats(settings.grokDirectory)
    ])
    return {
      ...base,
      grokDirectory: settings.grokDirectory,
      cpaCodexAccounts: decorateAccounts(cpaCodexAccounts),
      cpaGrokAccounts: decorateAccounts(cpaGrokAccounts),
      cpaCodexTesting: cpaCodexProgress,
      cpaGrokTesting: cpaGrokProgress,
      cpaDirectoryStats
    }
  })
  ipcMain.handle(ipcChannels.revealManagedSource, async (_event, input: unknown) => {
    const { scope, id } = z.object({
      scope: z.enum(['grok', 'cpa-grok', 'cpa-codex']),
      id: z.string().min(1)
    }).parse(input)
    const settings = await settingsStore.get()
    const root = scope === 'grok' ? grokImportDirectory : settings.grokDirectory
    const accounts = scope === 'grok'
      ? await grokManager.listAccounts()
      : scope === 'cpa-grok'
        ? await cpaGrokManager.listAccounts()
        : await cpaCodexManager.listAccounts()
    const sourcePath = accounts.find((account) => account.id === id)?.sourcePath
    if (!sourcePath) return { ok: false, message: '账号托管文件不存在' }
    const normalizedRoot = resolve(root)
    const normalizedSource = resolve(sourcePath)
    const relativePath = relative(normalizedRoot, normalizedSource)
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      return { ok: false, message: '账号文件不在受管理目录内' }
    }
    try {
      if (!(await stat(normalizedSource)).isFile()) return { ok: false, message: '账号托管文件不是文件' }
      shell.showItemInFolder(normalizedSource)
      return { ok: true, message: '已打开账号文件位置' }
    } catch {
      return { ok: false, message: '账号托管文件已不存在' }
    }
  })
  ipcMain.handle(ipcChannels.conversationList, async (_event, input: unknown) => {
    const payload = z.object({
      query: z.string().max(500).optional(),
      searchScope: z.enum(['metadata', 'content']).optional(),
      kind: z.enum(['all', 'main', 'subagent', 'internal', 'unknown']).optional(),
      subagentKind: z.enum(['all', 'thread_spawn', 'review', 'compact', 'memory_consolidation', 'other']).optional(),
      lifecycleStatus: z.enum(['all', 'open', 'closed', 'unknown']).optional(),
      archive: z.enum(['all', 'active', 'archived']).optional(),
      provider: z.string().max(500).optional(),
      workspace: z.string().max(4_000).optional(),
      updatedWithinDays: z.number().int().min(1).max(3_650).nullable().optional(),
      sort: z.enum(['updated', 'hierarchy']).optional(),
      offset: z.number().int().min(0).max(100_000).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      force: z.boolean().optional()
    }).parse(input)
    return (await conversationManager()).list(payload)
  })
  ipcMain.handle(ipcChannels.conversationDetail, async (_event, input: unknown) => {
    const id = z.string().min(1).max(200).parse(input)
    return (await conversationManager()).detail(id)
  })
  ipcMain.handle(ipcChannels.conversationReveal, async (_event, input: unknown) => {
    const id = z.string().min(1).max(200).parse(input)
    const settings = await settingsStore.get()
    const codexHome = resolve(dirname(settings.configPath))
    const sourcePath = await (await conversationManager()).reveal(id)
    if (!sourcePath) return { ok: false, message: '对话文件不存在' }
    const relativePath = relative(codexHome, resolve(sourcePath))
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      return { ok: false, message: '对话文件不在 Codex 目录内' }
    }
    shell.showItemInFolder(sourcePath)
    return { ok: true, message: '已打开对话文件位置' }
  })
  ipcMain.handle(ipcChannels.conversationDelete, async (_event, input: unknown) => {
    const ids = z.array(z.string().min(1).max(200)).min(1).max(5_000).parse(input)
    assertNoRunningTask('删除对话')
    conversationDeleteOperationActive = true
    try {
      return await (await conversationManager()).delete(ids, (path) => shell.trashItem(path))
    } finally {
      conversationDeleteOperationActive = false
    }
  })
  ipcMain.handle(ipcChannels.conversationCleanupPreview, async () => {
    return (await conversationManager()).previewSafeCleanup()
  })
  ipcMain.handle(ipcChannels.conversationCleanup, async () => {
    assertNoRunningTask('清理已关闭子代理对话')
    conversationDeleteOperationActive = true
    try {
      return await (await conversationManager()).cleanupSafe((path) => shell.trashItem(path))
    } finally {
      conversationDeleteOperationActive = false
    }
  })
  ipcMain.handle(ipcChannels.sessionRepairPreview, async (_event, input: unknown) => {
    const payload = z.object({
      targetProvider: z.string().regex(/^[A-Za-z0-9_.-]+$/).optional(),
      threadIds: z.array(z.string().min(1).max(200)).max(5_000).optional()
    }).parse(input)
    assertNoRunningTask('预览历史会话修复')
    sessionRepairOperationActive = true
    try {
      return await (await sessionRepairService()).preview(payload.targetProvider, payload.threadIds)
    } finally {
      sessionRepairOperationActive = false
    }
  })
  ipcMain.handle(ipcChannels.sessionRepairApply, async (_event, input: unknown) => {
    const payload = z
      .object({
        snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
        targetProvider: z.string().regex(/^[A-Za-z0-9_.-]+$/),
        threadIds: z.array(z.string().min(1).max(200)).max(5_000).optional()
      })
      .parse(input)
    const task = runningTask()
    if (task) {
      return {
        ok: false,
        message: `${task}，暂时不能修复会话`,
        targetProvider: payload.targetProvider,
        changedSessionFiles: 0,
        sqliteRowsUpdated: 0,
        globalStateKeysUpdated: 0,
        backupPath: null
      }
    }
    sessionRepairOperationActive = true
    let closedCodex = false
    sendSessionRepairProgress({ active: true, done: 0, total: 6, message: '正在检测 Codex 运行状态' })
    try {
      if (await processManager.isOfficialRunning()) {
        sendSessionRepairProgress({ active: true, done: 1, total: 6, message: 'Codex 正在运行，正在自动关闭' })
        const stopped = await processManager.stop()
        if (!stopped.ok) {
          return {
            ok: false,
            message: `${stopped.message}；未开始写入会话数据`,
            targetProvider: payload.targetProvider,
            changedSessionFiles: 0,
            sqliteRowsUpdated: 0,
            globalStateKeysUpdated: 0,
            backupPath: null
          }
        }
        closedCodex = true
      }
      sendSessionRepairProgress({ active: true, done: 1, total: 6, message: 'Codex 已关闭，正在开始会话修复' })
      const result = await (await sessionRepairService()).apply(
        payload.snapshotId,
        payload.targetProvider,
        payload.threadIds
      )
      cachedConversationManager?.manager.invalidate()
      return closedCodex && result.ok
        ? { ...result, message: `${result.message}；Codex 已自动关闭，请手动启动` }
        : result
    } finally {
      sessionRepairOperationActive = false
      sendSessionRepairProgress({ ...sessionRepairProgress, active: false })
    }
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
    const metadataUrl = availableUpdate.url?.trim()
    const url = metadataUrl && /^https?:\/\//i.test(metadataUrl)
      ? metadataUrl
      : `https://github.com/ciaooo55/codex-account-switcher/releases/download/v${version}/${fileName}`
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
  ipcMain.handle(ipcChannels.updateInstall, async () => {
    if (updateState.status !== 'downloaded' || !downloadedInstallerPath) {
      throw new Error('安装包尚未下载完成')
    }
    assertNoRunningTask('安装更新')
    updateInstallOperationActive = true
    try {
      await launchInstallerAndDelete(downloadedInstallerPath, dirname(process.execPath))
      isQuitting = true
      app.quit()
    } finally {
      updateInstallOperationActive = false
    }
  })
  ipcMain.handle(ipcChannels.autoSwitchRun, () => autoSwitchScheduler.runNow(true))

  const trayIconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(currentDirectory, '../../build/icon.png')
  if (!e2eMode) {
    const trayIcon = nativeImage.createFromPath(trayIconPath)
    if (trayIcon.isEmpty()) throw new Error(`无法加载托盘图标：${trayIconPath}`)
    tray = new Tray(trayIcon.resize({ width: 16, height: 16 }))
    tray.setToolTip('Codex Account Switcher')
    tray.on('click', showMainWindow)
  }

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
  // First paint no longer waits for library scans; scans continue in background.
  void autoSwitchScheduler.start().catch(() => undefined)
  void rebuildTrayMenu().catch(() => undefined)
  void initialScan
    .then(() => rebuildTrayMenu())
    .catch(() => undefined)
  void deferredLegacyCleanup
  if (installerResult) {
    showTrayMessage(
      installerResult.status === 'succeeded' ? '更新完成' : '更新失败',
      updateState.message
    )
  }
  app.once('before-quit', () => {
    isQuitting = true
    testController?.abort()
    grokTestController?.abort()
    cpaGrokTestController?.abort()
    cpaCodexTestController?.abort()
    importPreviewTestController?.abort()
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
  app.exit(0)
} else if (process.argv.includes(INSTALL_QUIT_ARGUMENT)) {
  app.exit(0)
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
