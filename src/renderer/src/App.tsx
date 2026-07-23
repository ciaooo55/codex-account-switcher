import {
  BadgeCheck,
  CheckCircle2,
  CircleAlert,
  ClipboardPaste,
  Code2,
  Copy,
  Download,
  FolderInput,
  FolderOpen,
  Import,
  KeyRound,
  ListChecks,
  LoaderCircle,
  MessagesSquare,
  MoreHorizontal,
  Moon,
  PackageOpen,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  ScanSearch,
  Settings,
  Square,
  Sun,
  TestTube2,
  TimerReset,
  Trash2,
  Zap,
  Wrench,
  X
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  AppSnapshot,
  AppSnapshotPatch,
  AppSnapshotScope,
  ImportPreviewTestProgress,
  SessionRepairProgress,
  UpdateState
} from '../../shared/ipc'
import type {
  AccountSummary,
  AppSettings,
  CodexTestMode,
  DisplayAccountStatus,
  CredentialExportFormat,
  CredentialExportLayout,
  OAuthAuthorizationSession,
  ImportPreviewCommitResult,
  ImportPreviewManualMode,
  ImportPreviewResult,
  LibraryHealthReport,
  GrokAccountSummary,
  RefreshTokenClientMode,
  ScanResult,
  SessionRepairPreview
} from '../../shared/types'
import { ACCOUNT_SORT_OPTIONS, compareAccounts, type AccountSortMode } from './account-sort'
import {
  buildAccountFacets,
  EMPTY_ACCOUNT_FACET_FILTERS,
  hasFacetOption,
  matchesAccountFacets,
  type AccountFacetFilters as AccountFacetFilterValues
} from './account-filters'
import { displayStatus, STATUS_LABELS } from './account-status'
import { AccountFacetFilters } from './components/AccountFacetFilters'
import {
  CODEX_TEST_MODE_RUNNING,
  CODEX_TEST_MODE_SUCCESS,
  CodexTestModeControl
} from './components/CodexTestModeControl'
import { ConversationManagerDialog } from './components/ConversationManagerDialog'
import { ImportPreviewDialog } from './components/ImportPreviewDialog'
import { LibraryHealthDialog } from './components/LibraryHealthDialog'
import { CurrentAccountOverview } from './components/CurrentAccountOverview'
import { StatusFilterStrip, type StatusCategoryAction } from './components/StatusFilterStrip'
import { AccountsPage, AutomationPage, CpaPage, GrokLibraryPage } from './pages'
import { AccountMetadataChips } from './components/accounts/AccountMetadataChips'
import { Quota } from './components/accounts/Quota'
import { AppHeader } from './components/layout/AppHeader'
import { AppToast } from './components/layout/AppToast'
import { GlobalTestProgress } from './components/layout/GlobalTestProgress'
import { useDialogFocus } from './hooks/useDialogFocus'
import { useConfirmation } from './hooks/useConfirmation'
import { toggleSelection, usePrunedSelection } from './hooks/usePrunedSelection'
import { useVirtualTableRows } from './hooks/useVirtualTableRows'
import { dateTime, sourceFileName } from './lib/format'
import type { AppView } from './lib/navigation'
import { applyStatusSync, bootstrapSnapshotFromAccountsPage } from './lib/snapshot'
import { applyTheme, initialTheme, toggleTheme, type ThemeMode } from './lib/theme'
import { codexApi, type CodexSwitcherApi } from './services/codexApi'
import { AppSessionProvider } from './context/AppSessionContext'
import { SettingsDialog } from './components/dialogs/SettingsDialog'

type PasteImportMode = RefreshTokenClientMode | 'oauth'

export function App(): React.JSX.Element {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const value = initialTheme()
    document.documentElement.dataset.theme = value
    return value
  })
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [secondaryLibrariesHydrated, setSecondaryLibrariesHydrated] = useState(false)
  const [selected, setSelected] = usePrunedSelection(snapshot?.accounts.map((account) => account.id) ?? [])
  const [keyword, setKeyword] = useState('')
  const [statusFilter, setStatusFilter] = useState<DisplayAccountStatus | ''>('')
  const [facetFilters, setFacetFilters] = useState<AccountFacetFilterValues>(EMPTY_ACCOUNT_FACET_FILTERS)
  const [accountSort, setAccountSort] = useState<AccountSortMode>('availability_reset')
  const [testMode, setTestMode] = useState<CodexTestMode>('full')
  const [activeView, setActiveView] = useState<AppView>('accounts')
  const [grokViewRevision, setGrokViewRevision] = useState(0)
  const [automationKeyword, setAutomationKeyword] = useState('')
  const [automationSort, setAutomationSort] = useState<AccountSortMode>('availability_reset')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null)
  const [customApiKey, setCustomApiKey] = useState('')
  const [customApiModels, setCustomApiModels] = useState<string[]>([])
  const [customApiModelsText, setCustomApiModelsText] = useState('')
  const [customApiSyncCatalog, setCustomApiSyncCatalog] = useState(true)
  const [customApiModelsNote, setCustomApiModelsNote] = useState('')
  const [message, setMessage] = useState<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [repairPreview, setRepairPreview] = useState<SessionRepairPreview | null>(null)
  const [repairThreadIds, setRepairThreadIds] = useState<string[] | undefined>(undefined)
  const [repairProgress, setRepairProgress] = useState<SessionRepairProgress | null>(null)
  const [conversationOpen, setConversationOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importPreview, setImportPreview] = useState<ImportPreviewResult | null>(null)
  const [importPreviewTesting, setImportPreviewTesting] = useState<ImportPreviewTestProgress | null>(null)
  const [pasteText, setPasteText] = useState('')
  const [pasteImportMode, setPasteImportMode] = useState<PasteImportMode>('auto')
  const [oauthSession, setOauthSession] = useState<OAuthAuthorizationSession | null>(null)
  const [exportDialog, setExportDialog] = useState<{
    accountIds: string[]
    format: CredentialExportFormat
    layout: CredentialExportLayout
    defaultPriority: number
    individualPriorities: boolean
    priorities: Record<string, number>
  } | null>(null)
  const [updateState, setUpdateState] = useState<UpdateState | null>(null)
  const [healthReport, setHealthReport] = useState<LibraryHealthReport | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    account: AccountSummary
    x: number
    y: number
  } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const previousViewRef = useRef(activeView)
  const [clock, setClock] = useState(() => Date.now())
  const { requestConfirmation, confirmationDialog } = useConfirmation()

  const closeImportDialog = (force = false): void => {
    if ((busy || importPreviewTesting?.active) && !force) return
    if (importPreviewTesting?.active) void codexApi().cancelImportPreviewTests()
    if (importPreview) void codexApi().discardImportPreview(importPreview.sessionId)
    setImportOpen(false)
    setImportPreview(null)
    setImportPreviewTesting(null)
    setPasteText('')
    setOauthSession(null)
  }
  const closeExportDialog = (): void => {
    if (!busy) setExportDialog(null)
  }
  const closeRepairDialog = (): void => {
    if (!busy) {
      setRepairPreview(null)
      setRepairThreadIds(undefined)
    }
  }
  const closeSettingsDialog = (force = false): void => {
    if (busy && !force) return
    setSettingsOpen(false)
    setCustomApiKey('')
  }
  const openSettingsDialog = (): void => {
    const models = snapshot?.customApi.models ?? []
    setCustomApiModels(models)
    setCustomApiModelsText(models.join('\n'))
    setCustomApiSyncCatalog(true)
    setCustomApiModelsNote(models.length > 0 ? `已保存 ${models.length} 个 Codex 模型` : '')
    setSettingsOpen(true)
  }
  const importDialogRef = useDialogFocus<HTMLElement>(importOpen && !importPreview, closeImportDialog)
  const exportDialogRef = useDialogFocus<HTMLElement>(Boolean(exportDialog), closeExportDialog)
  const repairDialogRef = useDialogFocus<HTMLElement>(Boolean(repairPreview), closeRepairDialog)
  const settingsDialogRef = useDialogFocus<HTMLElement>(settingsOpen, closeSettingsDialog)

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const applySnapshotPatch = (patch: AppSnapshotPatch, preserveSettingsDraft = false): void => {
    setSnapshot((current) => current ? { ...current, ...patch } : current)
    if (!preserveSettingsDraft && patch.settings) setSettingsDraft(patch.settings)
  }

  const reload = async (
    preserveSettingsDraft = false,
    scope: AppSnapshotScope = activeView
  ): Promise<void> => {
    applySnapshotPatch(await codexApi().getPageSnapshot(scope), preserveSettingsDraft)
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const page = await codexApi().getPageSnapshot('accounts')
        if (cancelled) return
        const next = bootstrapSnapshotFromAccountsPage(page)
        setSnapshot(next)
        setSettingsDraft(next.settings)
        // Warm other libraries after accounts are in hand. Merge onto current/next so a
        // pre-commit warm response cannot be dropped by applySnapshotPatch(current=null).
        void Promise.all([
          codexApi().getPageSnapshot('grok').catch(() => null),
          codexApi().getPageSnapshot('cpa').catch(() => null)
        ]).then(([grok, cpa]) => {
          if (cancelled) return
          setSnapshot((current) => {
            const base = current ?? next
            return {
              ...base,
              ...(grok ?? {}),
              ...(cpa ?? {})
            }
          })
          setSecondaryLibrariesHydrated(true)
        })
      } catch {
        const next = await codexApi().getSnapshot()
        if (cancelled) return
        setSnapshot(next)
        setSettingsDraft(next.settings)
        setSecondaryLibrariesHydrated(true)
      }
    })()
    void codexApi().getUpdateState().then(setUpdateState)
    const stopTesting = codexApi().onTestProgress((testing) =>
      setSnapshot((current) => {
        if (!current) return current
        const accounts = testing.updatedAccount
          ? current.accounts.map((account) =>
              account.id === testing.updatedAccount?.id ? testing.updatedAccount : account
            )
          : current.accounts
        return { ...current, accounts, testing }
      })
    )
    const stopUpdates = codexApi().onUpdateState(setUpdateState)
    const stopGrokTesting = codexApi().onGrokTestProgress((grokTesting) =>
      setSnapshot((current) => {
        if (!current) return current
        const grokAccounts = grokTesting.updatedAccount
          ? current.grokAccounts.map((account) => account.id === grokTesting.updatedAccount?.id ? grokTesting.updatedAccount : account)
          : current.grokAccounts
        return { ...current, grokAccounts, grokTesting }
      })
    )
    const stopCpaCodexTesting = codexApi().onCpaCodexTestProgress((cpaCodexTesting) =>
      setSnapshot((current) => {
        if (!current) return current
        const cpaCodexAccounts = cpaCodexTesting.updatedAccount
          ? current.cpaCodexAccounts.map((account) => account.id === cpaCodexTesting.updatedAccount?.id ? cpaCodexTesting.updatedAccount : account)
          : current.cpaCodexAccounts
        return { ...current, cpaCodexAccounts, cpaCodexTesting }
      })
    )
    const stopAccountStatusSync = codexApi().onAccountStatusSync((patch) => {
      setSnapshot((current) => current ? applyStatusSync(current, patch) : current)
    })
    const stopCpaGrokTesting = codexApi().onCpaGrokTestProgress((cpaGrokTesting) =>
      setSnapshot((current) => {
        if (!current) return current
        const cpaGrokAccounts = cpaGrokTesting.updatedAccount
          ? current.cpaGrokAccounts.map((account) => account.id === cpaGrokTesting.updatedAccount?.id ? cpaGrokTesting.updatedAccount : account)
          : current.cpaGrokAccounts
        return { ...current, cpaGrokAccounts, cpaGrokTesting }
      })
    )
    const stopImportPreviewTesting = codexApi().onImportPreviewTestProgress((testing) => {
      setImportPreviewTesting(testing)
      if (!testing.updatedItem) return
      setImportPreview((current) => current?.sessionId === testing.sessionId
        ? {
            ...current,
            items: current.items.map((item) => item.key === testing.updatedItem?.key ? testing.updatedItem : item)
          }
        : current)
    })
    const stopSessionRepairProgress = codexApi().onSessionRepairProgress(setRepairProgress)
    const stopAutoSwitch = codexApi().onAutoSwitchState((autoSwitch) => {
      setSnapshot((current) => current ? { ...current, autoSwitch } : current)
      if (!autoSwitch.running) {
        void codexApi().getPageSnapshot('accounts').then((patch) => applySnapshotPatch(patch, true))
      }
    })
    return () => {
      cancelled = true
      stopTesting()
      stopUpdates()
      stopGrokTesting()
      stopCpaCodexTesting()
      stopAccountStatusSync()
      stopCpaGrokTesting()
      stopImportPreviewTesting()
      stopSessionRepairProgress()
      stopAutoSwitch()
    }
  }, [])

  useEffect(() => {
    if (previousViewRef.current === activeView) return
    previousViewRef.current = activeView
    if (snapshot) void reload(true, activeView)
  }, [activeView])

  useEffect(() => {
    const interval = window.setInterval(() => setClock(Date.now()), 30_000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!message) return
    const timeout = window.setTimeout(() => setMessage(null), message.kind === 'error' ? 8_000 : 5_000)
    return () => window.clearTimeout(timeout)
  }, [message])

  useEffect(() => {
    if (!contextMenu) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && contextMenuRef.current?.contains(event.target)) return
      setContextMenu(null)
    }
    const close = (): void => setContextMenu(null)
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', closeOutside)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [contextMenu])

  useLayoutEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return
    const margin = 8
    const bounds = contextMenuRef.current.getBoundingClientRect()
    const x = Math.max(margin, Math.min(contextMenu.x, window.innerWidth - bounds.width - margin))
    const y = Math.max(margin, Math.min(contextMenu.y, window.innerHeight - bounds.height - margin))
    if (x === contextMenu.x && y === contextMenu.y) return
    setContextMenu((current) => current ? { ...current, x, y } : null)
  }, [contextMenu])

  const accountFacets = useMemo(
    () => buildAccountFacets(snapshot?.accounts ?? []),
    [snapshot?.accounts]
  )
  const availableAccountFacets = useMemo(() => {
    if (!statusFilter) return accountFacets
    return buildAccountFacets(
      (snapshot?.accounts ?? []).filter((account) => displayStatus(account.status) === statusFilter)
    )
  }, [accountFacets, snapshot?.accounts, statusFilter])

  useEffect(() => {
    setFacetFilters((current) => {
      const next = {
        plan: hasFacetOption(availableAccountFacets.plans, current.plan) ? current.plan : '',
        domain: hasFacetOption(availableAccountFacets.domains, current.domain) ? current.domain : '',
        reason: hasFacetOption(availableAccountFacets.reasons, current.reason) ? current.reason : '',
        group: hasFacetOption(availableAccountFacets.groups, current.group) ? current.group : '',
        tag: hasFacetOption(availableAccountFacets.tags, current.tag) ? current.tag : ''
      }
      return next.plan === current.plan && next.domain === current.domain && next.reason === current.reason && next.group === current.group && next.tag === current.tag
        ? current
        : next
    })
  }, [availableAccountFacets])

  const accounts = useMemo(() => {
    if (!snapshot) return []
    const query = keyword.trim().toLowerCase()
    return snapshot.accounts.filter((account) => {
      if (statusFilter && displayStatus(account.status) !== statusFilter) return false
      if (!matchesAccountFacets(account, facetFilters)) return false
      if (!query) return true
      return `${account.alias ?? ''} ${account.email ?? ''} ${account.workspaceId ?? ''} ${account.planType ?? ''} ${account.group ?? ''} ${(account.tags ?? []).join(' ')} ${account.note ?? ''} ${account.sourceDialect} ${account.sourcePath} ${account.detail}`
        .toLowerCase()
        .includes(query)
    }).sort(compareAccounts(accountSort))
  }, [accountSort, facetFilters, keyword, snapshot?.accounts, statusFilter])

  const accountById = useMemo(
    () => new Map((snapshot?.accounts ?? []).map((account) => [account.id, account])),
    [snapshot?.accounts]
  )
  const runningAccountIds = useMemo(
    () => new Set(snapshot?.testing.runningIds ?? []),
    [snapshot?.testing.runningIds]
  )
  const activeAccount = useMemo(
    () => (snapshot?.accounts ?? []).find((account) => account.active) ?? null,
    [snapshot?.accounts]
  )
  const selectedAccount = useMemo(() => selected.size === 1
    ? (snapshot?.accounts ?? []).find((account) => selected.has(account.id)) ?? null
    : null, [selected, snapshot?.accounts])
  const automationAccounts = useMemo(() => (snapshot?.accounts ?? []).filter((account) => {
    const query = automationKeyword.trim().toLowerCase()
    return !query || `${account.alias ?? ''} ${account.email ?? ''} ${account.planType ?? ''} ${account.group ?? ''} ${(account.tags ?? []).join(' ')} ${account.note ?? ''} ${account.detail}`.toLowerCase().includes(query)
  }).sort(compareAccounts(automationSort)), [automationKeyword, automationSort, snapshot?.accounts])
  const virtualAccounts = useVirtualTableRows(accounts, (account) => account.id)
  const virtualAutomationAccounts = useVirtualTableRows(automationAccounts, (account) => account.id, 96)

  const openExport = (ids?: string[]): void => {
    const accountIds = ids ?? (selected.size > 0 ? [...selected] : accounts.map((item) => item.id))
    if (accountIds.length === 0) {
      setMessage({ kind: 'error', text: '没有可导出的账号' })
      return
    }
    setExportDialog({
      accountIds,
      format: 'cpa',
      layout: 'separate',
      defaultPriority: 10,
      individualPriorities: false,
      priorities: Object.fromEntries(accountIds.map((id) => [id, 10]))
    })
  }

  const submitExport = async (): Promise<void> => {
    if (!exportDialog) return
    setBusy(true)
    setMessage(null)
    try {
      const request = exportDialog.format === 'codex'
        ? {
            accountIds: exportDialog.accountIds,
            format: exportDialog.format,
            layout: exportDialog.layout
          }
        : {
            accountIds: exportDialog.accountIds,
            format: exportDialog.format,
            layout: exportDialog.layout,
            defaultPriority: exportDialog.defaultPriority,
            ...(exportDialog.individualPriorities ? { priorities: exportDialog.priorities } : {})
          }
      const result = await codexApi().exportAccounts(request)
      if (!result.cancelled) {
        setMessage({ kind: result.ok ? 'ok' : 'error', text: result.message })
        setExportDialog(null)
      }
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const runImportPreview = async (
    action: () => Promise<ImportPreviewResult | null>
  ): Promise<boolean> => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await action()
      if (!result) {
        setMessage({ kind: 'warn', text: '已取消操作' })
        return false
      }
      setImportPreview(result)
      setImportPreviewTesting(null)
      if (result.items.length === 0) {
        setMessage({
          kind: 'warn',
          text: result.recognized > 0
            ? `已识别 ${result.recognized} 条，但均未完成导入${result.errors[0] ? `。首项：${result.errors[0]}` : ''}`
            : result.errors[0]
              ? `没有可导入账号：${result.errors[0]}`
              : '没有识别到 Codex 或 Grok 凭证'
        })
      }
      return result.items.length > 0
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
      return false
    } finally {
      setBusy(false)
    }
  }

  const submitPaste = async (): Promise<void> => {
    if (!pasteText.trim()) return
    const action = pasteImportMode === 'oauth'
      ? () => {
          if (!oauthSession) throw new Error('请先打开官方授权页')
          return codexApi().previewOAuthComplete(oauthSession.sessionId, pasteText)
        }
      : pasteImportMode === 'auto'
        ? () => codexApi().previewAnyPasted(pasteText)
        : () => codexApi().previewRefreshTokens(pasteText, pasteImportMode)
    await runImportPreview(action)
  }

  const commitImportPreview = async (
    decisions: Parameters<CodexSwitcherApi['commitImportPreview']>[0]['decisions'],
    skipUnrecognized = false
  ): Promise<void> => {
    if (!importPreview) return
    setBusy(true)
    setMessage(null)
    try {
      const result: ImportPreviewCommitResult = await codexApi().commitImportPreview({
        sessionId: importPreview.sessionId,
        decisions,
        ...(skipUnrecognized ? { skipUnrecognized: true } : {})
      })
      applySnapshotPatch({ accounts: result.accounts, grokAccounts: result.grokAccounts })
      if (result.grokImported > 0) setGrokViewRevision((current) => current + 1)
      if (result.codexImported > 0) {
        setKeyword('')
        setStatusFilter('')
        setFacetFilters(EMPTY_ACCOUNT_FACET_FILTERS)
        setActiveView('accounts')
      } else if (result.grokImported > 0) setActiveView('grok')
      closeImportDialog(true)
      setMessage({
        kind: result.errors.length ? 'warn' : 'ok',
        text: `导入完成：新增 ${result.added}，更新 ${result.updated}，跳过 ${result.ignored}${result.errors.length ? `；${result.errors.length} 项存在问题` : ''}`
      })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const refineImportPreview = async (
    sourceKey: string,
    mode: ImportPreviewManualMode
  ): Promise<void> => {
    if (!importPreview) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await codexApi().refineImportPreview({
        sessionId: importPreview.sessionId,
        sourceKey,
        mode
      })
      const resolved = !result.unrecognized.some((source) => source.key === sourceKey)
      const added = Math.max(0, result.items.length - importPreview.items.length)
      setImportPreview(result)
      setMessage(resolved
        ? { kind: 'ok', text: `重新识别成功，已加入 ${added} 个账号，请确认后写入 aa` }
        : {
            kind: 'warn',
            text: result.unrecognized.find((source) => source.key === sourceKey)?.detail
              ?? '所选方式仍未识别到可用凭据，请选择其他方式'
          })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const testImportPreview = async (itemKeys?: string[]): Promise<void> => {
    if (!importPreview || busy || importPreviewTesting?.active) return
    const sessionId = importPreview.sessionId
    setMessage(null)
    setImportPreviewTesting({
      active: true,
      sessionId,
      done: 0,
      total: itemKeys?.length ?? importPreview.items.length,
      runningKeys: [],
      updatedItem: null
    })
    try {
      const result = await codexApi().testImportPreview({
        sessionId,
        ...(itemKeys ? { itemKeys } : {})
      })
      setImportPreview((current) => current?.sessionId === sessionId ? result.preview : current)
      setMessage(result.cancelled
        ? { kind: 'warn', text: `已取消导入检测，保留了 ${result.tested} 个已完成结果` }
        : { kind: 'ok', text: `导入凭证检测完成：${result.tested} 个账号` })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setImportPreviewTesting((current) => current?.sessionId === sessionId
        ? { ...current, active: false, runningKeys: [], updatedItem: null }
        : current)
    }
  }

  const cancelImportPreviewTests = (): void => {
    void codexApi().cancelImportPreviewTests()
  }

  const backFromImportPreview = (): void => {
    if (!importPreview || busy || importPreviewTesting?.active) return
    void codexApi().discardImportPreview(importPreview.sessionId)
    setImportPreview(null)
    setImportPreviewTesting(null)
  }

  const startOAuthAuthorization = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const session = await codexApi().startOAuthAuthorization()
      setOauthSession(session)
      setMessage({ kind: 'ok', text: '已打开 OpenAI 官方授权页，登录后将浏览器地址粘贴回来' })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const submitExportToCpa = async (): Promise<void> => {
    if (!exportDialog) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await codexApi().exportAccountsToCpa({
        accountIds: exportDialog.accountIds,
        defaultPriority: exportDialog.defaultPriority,
        ...(exportDialog.individualPriorities ? { priorities: exportDialog.priorities } : {})
      })
      await reload()
      setMessage({
        kind: result.errors.length ? 'warn' : 'ok',
        text: `已导出 ${result.imported} 个到 CPA${result.skipped ? `，${result.skipped} 个已有账号已更新凭证和优先级` : ''}`
      })
      setExportDialog(null)
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const inspectLibraries = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      setHealthReport(await codexApi().inspectLibraries())
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const repairLibraries = async (issueIds: string[]): Promise<void> => {
    if (!healthReport || issueIds.length === 0) return
    if (!await requestConfirmation({
      title: `修复 ${issueIds.length} 项账号库问题`,
      message: '标准化操作可能拆分、重命名或合并受管理目录中的凭证文件。',
      detail: '无法识别的文件会移动到应用隔离目录；外部导入源文件不会修改。',
      confirmLabel: '确认修复',
      tone: 'warning'
    })) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await codexApi().repairLibraries(healthReport.snapshotId, issueIds)
      setHealthReport(result.report)
      await reload(true, activeView)
      setMessage({ kind: result.errors.length ? 'warn' : 'ok', text: result.message })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const checkForUpdates = async (): Promise<void> => {
    try {
      setUpdateState(await codexApi().checkForUpdates())
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }

  const downloadUpdate = async (): Promise<void> => {
    try {
      await codexApi().downloadUpdate()
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }

  const installUpdate = async (): Promise<void> => {
    if (!await requestConfirmation({
      title: '安装应用更新',
      message: '安装过程会退出当前应用并覆盖现有版本。',
      detail: '安装完成后会自动启动新版本，账号库和设置不会被删除。',
      confirmLabel: '安装并重启',
      tone: 'warning'
    })) return
    try {
      await codexApi().installUpdate()
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }

  const automationPatch = (): Pick<AppSettings, 'autoSwitchEnabled' | 'autoSwitchIntervalSeconds' | 'autoSwitchAccountIds' | 'autoSwitchRestartCodex'> => ({
    autoSwitchEnabled: settingsDraft!.autoSwitchEnabled,
    autoSwitchIntervalSeconds: settingsDraft!.autoSwitchIntervalSeconds,
    autoSwitchAccountIds: settingsDraft!.autoSwitchAccountIds,
    autoSwitchRestartCodex: settingsDraft!.autoSwitchRestartCodex
  })

  const saveAutomation = async (): Promise<void> => {
    if (settingsDraft?.autoSwitchEnabled && settingsDraft.autoSwitchAccountIds.length === 0) {
      setMessage({ kind: 'error', text: '启用自动切换前至少选择一个候选账号' })
      return
    }
    await run(() => codexApi().updateSettings(automationPatch()), '自动切换设置已保存')
  }

  const saveAndRunAutomation = async (): Promise<void> => {
    if (!settingsDraft || settingsDraft.autoSwitchAccountIds.length === 0) {
      setMessage({ kind: 'error', text: '请先选择至少一个候选账号' })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      await codexApi().updateSettings(automationPatch())
      const result = await codexApi().runAutoSwitchNow()
      await reload()
      setMessage({ kind: result.ok ? 'ok' : 'warn', text: result.message })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const run = async (action: () => Promise<unknown>, success?: string, reloadAfter = true): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      await action()
      if (reloadAfter) await reload()
      if (success) setMessage({ kind: 'ok', text: success })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  /** Background tests keep UI interactive (switch pages / switch accounts). Progress uses testing.active. */
  const runTest = async (action: () => Promise<unknown>, success?: string): Promise<void> => {
    setMessage(null)
    try {
      await action()
      await reload()
      if (success) setMessage({ kind: 'ok', text: success })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }

  const runScan = async (
    action: () => Promise<ScanResult | null>,
    success: string
  ): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await action()
      if (!result) {
        setMessage({ kind: 'warn', text: '已取消操作' })
        return
      }
      await reload()
      const summary = `导入 ${result.imported}，跳过 ${result.skipped}`
      setMessage({
        kind: result.errors.length > 0 ? 'warn' : 'ok',
        text: result.errors.length > 0
          ? `${success}：${summary}，失败 ${result.errors.length}`
          : `${success}：${summary}`
      })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const toggle = (id: string): void => {
    toggleSelection(setSelected, id)
  }

  const selectAccountRow = (id: string): void => toggle(id)

  const switchAccount = async (id: string): Promise<void> => {
    if (!await requestConfirmation({
      title: '切换账号并重启',
      message: '重启会中断 Codex 当前正在运行的任务。',
      detail: '凭据写入后会关闭官方 Codex，在重新启动前同步当前会话的 provider 与可见性状态。',
      confirmLabel: '继续切换并重启',
      tone: 'warning'
    })) return
    setBusy(true)
    setMessage(null)
    try {
      const result = await codexApi().switchAccount(id, true)
      if (!result.ok) throw new Error(result.message)
      await reload()
      setMessage({
        kind: result.restartResult && !result.restartResult.ok ? 'warn' : 'ok',
        text: result.restartResult && !result.restartResult.ok
          ? result.message
          : '切换成功，当前会话已同步，Codex 已重启'
      })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const switchSelected = async (): Promise<void> => {
    const id = [...selected][0]
    if (!id || selected.size !== 1) {
      setMessage({ kind: 'error', text: '请选择一个账号进行切换' })
      return
    }
    await switchAccount(id)
  }

  const deleteAccounts = async (ids?: string[]): Promise<void> => {
    const accountIds = ids ?? [...selected]
    if (accountIds.length === 0) {
      setMessage({ kind: 'error', text: '请选择要删除的账号' })
      return
    }
    if (!await requestConfirmation({
      title: `删除 ${accountIds.length} 个账号`,
      message: 'aa 中对应的托管账号 JSON 会一并删除。',
      detail: '最初导入的外部源文件不会被修改，删除后可再次从源文件导入。',
      confirmLabel: '确认删除',
      tone: 'danger'
    })) {
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const result = await codexApi().deleteAccounts(accountIds)
      if (result.deleted === 0) throw new Error('没有删除任何账号')
      const removed = new Set(accountIds)
      setSnapshot((current) => current ? {
        ...current,
        accounts: current.accounts.filter((account) => !removed.has(account.id))
      } : current)
      setSelected((current) => {
        const next = new Set(current)
        for (const id of accountIds) next.delete(id)
        return next
      })
      setMessage({ kind: 'ok', text: result.message })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const handleCodexCategoryAction = (
    action: StatusCategoryAction,
    category: DisplayAccountStatus | ''
  ): void => {
    const categoryAccounts = (snapshot?.accounts ?? []).filter((account) =>
      !category || displayStatus(account.status) === category
    )
    const ids = categoryAccounts.map((account) => account.id)
    if (action === 'select') {
      setSelected(new Set(ids))
      return
    }
    if (action === 'test') {
      void runTest(
        () => codexApi().testAccounts(ids, testMode),
        `${category ? STATUS_LABELS[category] : '全部账号'} ${ids.length} 个检测完成`
      )
      return
    }
    if (action === 'delete') void deleteAccounts(ids)
  }

  const handleCodexGroupAction = (action: StatusCategoryAction, group: string): void => {
    const groupAccounts = (snapshot?.accounts ?? []).filter((account) => {
      if (statusFilter && displayStatus(account.status) !== statusFilter) return false
      return !group || matchesAccountFacets(account, { ...EMPTY_ACCOUNT_FACET_FILTERS, group })
    })
    const ids = groupAccounts.map((account) => account.id)
    const groupLabel = group
      ? availableAccountFacets.groups.find((option) => option.value === group)?.label ?? group
      : '全部分组'
    if (action === 'select') {
      setSelected(new Set(ids))
      return
    }
    if (action === 'test') {
      void runTest(
        () => codexApi().testAccounts(ids, testMode),
        `${groupLabel} ${ids.length} 个检测完成`
      )
      return
    }
    if (action === 'delete') void deleteAccounts(ids)
  }

  const openContextMenu = (event: React.MouseEvent, account: AccountSummary): void => {
    event.preventDefault()
    setSelected(new Set([account.id]))
    setContextMenu({
      account,
      x: event.clientX,
      y: event.clientY
    })
  }

  const contextAction = (action: () => void | Promise<void>): void => {
    setContextMenu(null)
    void action()
  }

  const openSessionRepair = async (
    targetProvider?: string,
    threadIds?: string[]
  ): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const selectedThreadIds = threadIds ?? repairThreadIds
      setRepairThreadIds(selectedThreadIds)
      setRepairProgress(null)
      setRepairPreview(selectedThreadIds?.length
        ? await codexApi().previewSessionRepair(targetProvider, selectedThreadIds)
        : await codexApi().previewSessionRepair(targetProvider))
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const applySessionRepair = async (): Promise<void> => {
    if (!repairPreview) return
    setBusy(true)
    setMessage(null)
    try {
      const result = repairThreadIds?.length
        ? await codexApi().applySessionRepair(
            repairPreview.snapshotId,
            repairPreview.targetProvider,
            repairThreadIds
          )
        : await codexApi().applySessionRepair(
            repairPreview.snapshotId,
            repairPreview.targetProvider
          )
      if (!result.ok) throw new Error(result.message)
      setRepairPreview(null)
      setRepairThreadIds(undefined)
      setMessage({ kind: 'ok', text: result.message })
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  if (!snapshot || !settingsDraft) {
    return (
      <main className="loading-screen">
        <LoaderCircle className="spin" size={28} />
        <span>正在读取本地账号</span>
      </main>
    )
  }

  const switchCapability = (account: AccountSummary): string => {
    if (!account.switchable) return '仅用于检测'
    const mode = account.switchMode ?? (account.canRefresh ? 'oauth' : 'external')
    if (mode === 'oauth') return '可切换 · 标准 OAuth'
    if (mode === 'personal_access_token') return '可切换 · Personal Access Token，需重启'
    return '可切换 · 外部凭据，需重启'
  }
  const sessionValue = {
    snapshot,
    theme,
    activeView,
    busy,
    message,
    applySnapshotPatch,
    setBusy,
    notify: (kind: 'ok' | 'warn' | 'error', text: string): void => { setMessage({ kind, text }) },
    setActiveView
  }

  return (
    <AppSessionProvider value={sessionValue}>
    <div className="app-shell">
      <AppHeader
        activeView={activeView}
        onViewChange={setActiveView}
        accountsCount={snapshot.accounts.length}
        grokCount={secondaryLibrariesHydrated ? snapshot.grokAccounts.length : '…'}
        cpaCount={secondaryLibrariesHydrated ? snapshot.cpaCodexAccounts.length + snapshot.cpaGrokAccounts.length : '…'}
        version={updateState?.currentVersion ?? null}
        theme={theme}
        busy={busy}
        onImport={() => setImportOpen(true)}
        onToggleTheme={() => setTheme((current) => toggleTheme(current))}
        onOpenSettings={openSettingsDialog}
      />

      {message && <AppToast message={message} onClose={() => setMessage(null)} />}

      <GlobalTestProgress snapshot={snapshot} />

      {activeView === 'accounts' ? (
        <AccountsPage
          snapshot={snapshot}
          accounts={accounts}
          activeAccount={activeAccount}
          selectedAccount={selectedAccount}
          selected={selected}
          setSelected={setSelected}
          toggle={toggle}
          selectAccountRow={selectAccountRow}
          keyword={keyword}
          setKeyword={setKeyword}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          facetFilters={facetFilters}
          setFacetFilters={setFacetFilters}
          accountSort={accountSort}
          setAccountSort={setAccountSort}
          testMode={testMode}
          setTestMode={setTestMode}
          accountFacets={accountFacets}
          availableAccountFacets={availableAccountFacets}
          runningAccountIds={runningAccountIds}
          virtualAccounts={virtualAccounts}
          busy={busy}
          clock={clock}
          switchCapability={switchCapability}
          handleCodexCategoryAction={handleCodexCategoryAction}
          handleCodexGroupAction={handleCodexGroupAction}
          run={run}
          runScan={runScan}
          runTest={runTest}
          openExport={openExport}
          openSettingsDialog={openSettingsDialog}
          inspectLibraries={inspectLibraries}
          switchSelected={switchSelected}
          openSessionRepair={openSessionRepair}
          setConversationOpen={setConversationOpen}
          deleteAccounts={deleteAccounts}
          openContextMenu={openContextMenu}
        />
      ) : activeView === 'grok' ? (
        <GrokLibraryPage
          key={grokViewRevision}
          snapshot={snapshot}
          onSnapshot={(patch) => applySnapshotPatch(patch)}
          notify={(kind, text) => setMessage({ kind, text })}
          onBusyChange={setBusy}
          requestConfirmation={requestConfirmation}
        />
      ) : activeView === 'cpa' ? (
        <CpaPage
          snapshot={snapshot}
          onSnapshot={(patch) => applySnapshotPatch(patch)}
          notify={(kind, text) => setMessage({ kind, text })}
          onBusyChange={setBusy}
          requestConfirmation={requestConfirmation}
        />
      ) : (
        <AutomationPage
          snapshot={snapshot}
          settingsDraft={settingsDraft}
          setSettingsDraft={setSettingsDraft}
          automationAccounts={automationAccounts}
          automationKeyword={automationKeyword}
          setAutomationKeyword={setAutomationKeyword}
          automationSort={automationSort}
          setAutomationSort={setAutomationSort}
          virtualAutomationAccounts={virtualAutomationAccounts}
          runningAccountIds={runningAccountIds}
          busy={busy}
          clock={clock}
          switchCapability={switchCapability}
          saveAutomation={saveAutomation}
          saveAndRunAutomation={saveAndRunAutomation}
        />
      )}

      {importOpen && (
        <div className="repair-backdrop" role="presentation">
          {importPreview ? (
            <ImportPreviewDialog
              preview={importPreview}
              busy={busy}
              testing={importPreviewTesting}
              onBack={backFromImportPreview}
              onClose={() => closeImportDialog()}
              onCommit={(decisions, skipUnrecognized) => void commitImportPreview(decisions, skipUnrecognized)}
              onRefine={refineImportPreview}
              onTest={testImportPreview}
              onCancelTest={cancelImportPreviewTests}
            />
          ) : (
          <section ref={importDialogRef} className="compact-dialog import-dialog" role="dialog" aria-modal="true" aria-label="导入账号" tabIndex={-1}>
            <div className="panel-header">
              <div><h2>导入账号到本地库</h2><div className="provider-detection"><span className="provider-label codex"><Code2 size={11} />Codex</span><span className="provider-label grok"><Zap size={11} />Grok</span><span>自动分类保存到 aa，不修改 CPA 目录</span></div></div>
              <button className="icon-button" title="关闭" aria-label="关闭导入账号" onClick={() => closeImportDialog()} disabled={busy}>
                <X size={18} />
              </button>
            </div>
            <div className="import-source-actions">
              <button aria-label="导入多个文件" onClick={() => void runImportPreview(() => codexApi().previewAnyFiles())} disabled={busy}><Import size={17} /><span><strong>导入文件</strong><small>先识别、去重并预览</small></span></button>
              <button aria-label="导入文件夹" onClick={() => void runImportPreview(() => codexApi().previewAnyDirectory())} disabled={busy}><FolderInput size={17} /><span><strong>导入文件夹</strong><small>递归识别后确认写入</small></span></button>
            </div>
            <div className="import-divider"><span>或粘贴凭据</span></div>
            <div className="option-group import-method-group">
              <span>识别方式</span>
              <div className="segmented-control import-mode-control">
                <button className={pasteImportMode === 'auto' ? 'selected' : ''} onClick={() => setPasteImportMode('auto')}>智能识别</button>
                <button className={pasteImportMode === 'oauth' ? 'selected' : ''} onClick={() => setPasteImportMode('oauth')}>浏览器授权</button>
                <button className={pasteImportMode === 'codex' ? 'selected' : ''} onClick={() => setPasteImportMode('codex')}>Codex RT</button>
                <button className={pasteImportMode === 'mobile' ? 'selected' : ''} onClick={() => setPasteImportMode('mobile')}>移动端 RT</button>
              </div>
              <small>{pasteImportMode === 'auto' ? '同时识别 Codex 与 Grok 的 JSON、JSONL、CPA、Sub2API、裸 AT/PAT；仅写入本地 aa 分类目录' : pasteImportMode === 'oauth' ? '使用 Codex CLI 的 PKCE 参数打开 OpenAI 官方授权页，token 仅在主进程中交换' : pasteImportMode === 'codex' ? '每行一个 rt.1...，使用 Codex CLI 客户端刷新并保存旋转后的新 RT' : '每行一个 rt.1...，使用 OpenAI 移动端客户端刷新并保存对应 client_id'}</small>
            </div>
            {pasteImportMode === 'oauth' && (
              <div className="oauth-import-step">
                <button onClick={() => void startOAuthAuthorization()} disabled={busy}>
                  {busy ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
                  {oauthSession ? '重新打开授权页' : '打开 OpenAI 授权页'}
                </button>
                <span>{oauthSession ? '授权会话已就绪，粘贴回调 URL 后完成导入' : '授权会话保留 30 分钟'}</span>
              </div>
            )}
            <label className="paste-field">
              <textarea
                aria-label="凭据文本"
                value={pasteText}
                onChange={(event) => setPasteText(event.target.value)}
                placeholder={pasteImportMode === 'auto' ? '粘贴 Codex / Grok JSON、JSONL、CPA、SubAPI、裸 AT/PAT/RT、键值文本或静态 JS' : pasteImportMode === 'oauth' ? '粘贴浏览器最后的 http://localhost:1455/auth/callback?code=...&state=... 地址' : '每行粘贴一个 OpenAI Refresh Token（rt.1...）'}
              />
            </label>
            <div className="panel-actions">
              <button className="secondary-button" onClick={() => closeImportDialog()} disabled={busy}><X size={16} />取消</button>
              <button className="primary-button" onClick={() => void submitPaste()} disabled={busy || !pasteText.trim() || (pasteImportMode === 'oauth' && !oauthSession)}>
                {busy ? <LoaderCircle className="spin" size={16} /> : <ClipboardPaste size={16} />}
                {pasteImportMode === 'oauth' ? '完成授权并导入' : '清洗并导入'}
              </button>
            </div>
          </section>
          )}
        </div>
      )}

      {exportDialog && (
        <div className="repair-backdrop" role="presentation">
          <section ref={exportDialogRef} className="compact-dialog" role="dialog" aria-modal="true" aria-label="导出账号" tabIndex={-1}>
            <div className="panel-header">
              <h2>导出 {exportDialog.accountIds.length} 个账号</h2>
              <button className="icon-button" title="关闭" aria-label="关闭账号导出" onClick={closeExportDialog} disabled={busy}>
                <X size={18} />
              </button>
            </div>
            <div className="option-group">
              <span>目标格式</span>
              <div className="segmented-control format-control">
                <button className={exportDialog.format === 'cpa' ? 'selected' : ''} onClick={() => setExportDialog({ ...exportDialog, format: 'cpa' })}>CPA</button>
                <button className={exportDialog.format === 'sub2api' ? 'selected' : ''} onClick={() => setExportDialog({ ...exportDialog, format: 'sub2api' })}>SubAPI</button>
                <button className={exportDialog.format === 'codex' ? 'selected' : ''} onClick={() => setExportDialog({ ...exportDialog, format: 'codex' })}>Codex auth.json</button>
              </div>
            </div>
            <div className="option-group">
              <span>文件布局</span>
              <div className="segmented-control">
                <button className={exportDialog.layout === 'separate' ? 'selected' : ''} onClick={() => setExportDialog({ ...exportDialog, layout: 'separate' })}>每账号一文件</button>
                <button className={exportDialog.layout === 'bundle' ? 'selected' : ''} onClick={() => setExportDialog({ ...exportDialog, layout: 'bundle' })}>{exportDialog.format === 'sub2api' ? '合并单文件' : '合并 ZIP'}</button>
              </div>
            </div>
            {exportDialog.format !== 'codex' && (
              <div className="priority-editor">
                <label className="priority-batch">
                  <span>统一优先级</span>
                  <input
                    aria-label="统一优先级"
                    type="number"
                    min={0}
                    max={1_000_000}
                    step={1}
                    value={exportDialog.defaultPriority}
                    onChange={(event) => {
                      const value = Math.max(0, Math.min(1_000_000, Math.trunc(Number(event.target.value) || 0)))
                      setExportDialog((current) => current ? {
                        ...current,
                        defaultPriority: value,
                        priorities: Object.fromEntries(current.accountIds.map((id) => [id, value]))
                      } : null)
                    }}
                  />
                </label>
                <span className="priority-hint">
                  {exportDialog.format === 'cpa'
                    ? 'CPA 数值越大越优先，未设置时默认为 0。'
                    : 'Sub2API 数值越小越优先，项目默认值为 50。'}
                </span>
                {exportDialog.accountIds.length > 1 && (
                  <label className="priority-toggle">
                    <input
                      type="checkbox"
                      checked={exportDialog.individualPriorities}
                      onChange={(event) => setExportDialog({
                        ...exportDialog,
                        individualPriorities: event.target.checked
                      })}
                    />
                    <span>分别设置每个账号</span>
                  </label>
                )}
                {exportDialog.individualPriorities && (
                  <div className="priority-account-list" aria-label="逐账号优先级">
                    {exportDialog.accountIds.map((id) => {
                      const account = accountById.get(id)
                      const label = account?.email ?? account?.workspaceId ?? id
                      return (
                        <label key={id} className="priority-account-row">
                          <span title={label}>{label}</span>
                          <small>{account?.planType ?? '未知'}</small>
                          <input
                            aria-label={`${label} 的优先级`}
                            type="number"
                            min={0}
                            max={1_000_000}
                            step={1}
                            value={exportDialog.priorities[id] ?? exportDialog.defaultPriority}
                            onChange={(event) => {
                              const value = Math.max(0, Math.min(1_000_000, Math.trunc(Number(event.target.value) || 0)))
                              setExportDialog((current) => current ? {
                                ...current,
                                priorities: { ...current.priorities, [id]: value }
                              } : null)
                            }}
                          />
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
            <div className="export-warning">
              <CircleAlert size={17} />
              <span>{exportDialog.format === 'codex' ? 'Codex auth.json 没有优先级字段；多账号只能打包为 ZIP。' : '普通导出可选择任意目录；直接导出到 CPA 时，同账号不会重复创建文件，只更新凭证和优先级。'}</span>
            </div>
            <div className="panel-actions">
              <button className="secondary-button" onClick={closeExportDialog} disabled={busy}><X size={16} />取消</button>
              {exportDialog.format === 'cpa' && <button onClick={() => void submitExportToCpa()} disabled={busy}>
                <Zap size={16} />直接导出到 CPA
              </button>}
              <button className="primary-button" onClick={() => void submitExport()} disabled={busy}>
                {busy ? <LoaderCircle className="spin" size={16} /> : <FolderOpen size={16} />}
                选择目录并导出
              </button>
            </div>
          </section>
        </div>
      )}

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="account-context-menu"
          role="menu"
          aria-label="账号管理"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="context-account" title={contextMenu.account.email ?? contextMenu.account.sourcePath}>
            {contextMenu.account.alias ?? contextMenu.account.email ?? '邮箱未知'}
          </div>
          <button role="menuitem" onClick={() => contextAction(() => runTest(() => codexApi().testAccounts([contextMenu.account.id], testMode), CODEX_TEST_MODE_SUCCESS[testMode]))}>
            <TestTube2 size={15} />检测此账号
          </button>
          <button role="menuitem" disabled={busy || !contextMenu.account.switchable} title={!contextMenu.account.switchable ? '缺少可供 Codex 使用的认证材料' : '切换后会同步当前会话并重启 Codex'} onClick={() => contextAction(() => switchAccount(contextMenu.account.id))}>
            <RotateCcw size={15} />切换并重启
          </button>
          <button role="menuitem" onClick={() => contextAction(() => openExport([contextMenu.account.id]))}>
            <Download size={15} />导出此账号
          </button>
          <button role="menuitem" onClick={() => contextAction(async () => {
            const result = await codexApi().revealSource(contextMenu.account.id)
            if (!result.ok) setMessage({ kind: 'error', text: result.message })
          })}>
            <FolderOpen size={15} />打开源文件位置
          </button>
          <button role="menuitem" disabled={!contextMenu.account.email} onClick={() => contextAction(async () => {
            if (!contextMenu.account.email) return
            await navigator.clipboard.writeText(contextMenu.account.email)
            setMessage({ kind: 'ok', text: '邮箱已复制' })
          })}>
            <Copy size={15} />复制邮箱
          </button>
          <button className="context-danger" role="menuitem" disabled={busy || snapshot.testing.active} onClick={() => contextAction(() => deleteAccounts([contextMenu.account.id]))}>
            <Trash2 size={15} />删除此账号
          </button>
        </div>
      )}

      {conversationOpen && (
        <ConversationManagerDialog
          onClose={() => setConversationOpen(false)}
          requestConfirmation={requestConfirmation}
          onSync={(threadIds) => {
            setConversationOpen(false)
            void openSessionRepair(undefined, threadIds)
          }}
        />
      )}

      {repairPreview && (
        <div className="repair-backdrop" role="presentation">
          <section
            ref={repairDialogRef}
            className="repair-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="repair-title"
            tabIndex={-1}
          >
            <div className="panel-header">
              <h2 id="repair-title">修复历史会话</h2>
              <button
                className="icon-button"
                title="关闭"
                aria-label="关闭会话修复"
                onClick={closeRepairDialog}
                disabled={busy}
              >
                <X size={18} />
              </button>
            </div>
            <label className="repair-provider">
              目标供应商
              <select
                aria-label="目标供应商"
                value={repairPreview.targetProvider}
                disabled={busy}
                onChange={(event) => void openSessionRepair(event.target.value, repairThreadIds)}
              >
                {repairPreview.availableProviders.map((provider) => (
                  <option key={provider} value={provider}>
                    {provider}{provider === repairPreview.currentProvider ? '（当前）' : ''}
                  </option>
                ))}
              </select>
            </label>
            <div className="repair-metrics">
              <div><span>扫描会话</span><strong>{repairPreview.scannedSessionFiles}</strong></div>
              <div><span>待改文件</span><strong>{repairPreview.changedSessionFiles}</strong></div>
              <div><span>SQLite 供应商</span><strong>{repairPreview.sqliteProviderRows}</strong></div>
              <div><span>可见性</span><strong>{repairPreview.sqliteUserEventRows}</strong></div>
              <div><span>工作区路径</span><strong>{repairPreview.sqliteCwdRows}</strong></div>
              <div><span>全局状态</span><strong>{repairPreview.globalStateKeys}</strong></div>
            </div>
            {repairPreview.encryptedContentFiles > 0 && (
              <div className="repair-warning">
                <CircleAlert size={17} />
                <span>
                  {repairPreview.encryptedContentFiles} 个会话包含来自{' '}
                  {repairPreview.encryptedContentProviders.join('、') || '其他供应商'} 的加密内容，
                  跨供应商继续或压缩时可能需要切回原供应商。
                </span>
              </div>
            )}
            {repairPreview.skippedLockedFiles.length > 0 && (
              <div className="repair-warning">
                <CircleAlert size={17} />
                <span>{repairPreview.skippedLockedFiles.length} 个锁定文件将被跳过。</span>
              </div>
            )}
            <div className="repair-note">
              {repairThreadIds?.length
                ? `将深度同步选中的 ${repairThreadIds.length} 个对话，覆盖其中全部会话元数据。`
                : '将快速同步官方状态库引用的历史对话，仅检查每个对话的首条元数据。'}应用会自动关闭正在运行的 Codex；写入前会校验快照并创建备份，写入后会再次扫描确认结果。
            </div>
            {repairProgress && (
              <div className="repair-progress" aria-live="polite">
                <div className="task-progress">
                  <div style={{ width: `${Math.round((repairProgress.done / Math.max(1, repairProgress.total)) * 100)}%` }} />
                  <span>{repairProgress.message}（{repairProgress.done}/{repairProgress.total}）</span>
                </div>
              </div>
            )}
            <div className="panel-actions">
              <button className="secondary-button" onClick={closeRepairDialog} disabled={busy}><X size={16} />取消</button>
              <button
                className="primary-button"
                onClick={() => void applySessionRepair()}
                disabled={busy}
              >
                {busy ? <LoaderCircle className="spin" size={16} /> : <Wrench size={16} />}
                确认修复
              </button>
            </div>
          </section>
        </div>
      )}

      <SettingsDialog
        open={settingsOpen}
        snapshot={snapshot}
        settingsDraft={settingsDraft}
        setSettingsDraft={setSettingsDraft}
        settingsDialogRef={settingsDialogRef}
        busy={busy}
        customApiKey={customApiKey}
        setCustomApiKey={setCustomApiKey}
        customApiModels={customApiModels}
        setCustomApiModels={setCustomApiModels}
        customApiModelsText={customApiModelsText}
        setCustomApiModelsText={setCustomApiModelsText}
        customApiSyncCatalog={customApiSyncCatalog}
        setCustomApiSyncCatalog={setCustomApiSyncCatalog}
        customApiModelsNote={customApiModelsNote}
        setCustomApiModelsNote={setCustomApiModelsNote}
        updateState={updateState}
        closeSettingsDialog={closeSettingsDialog}
        run={run}
        requestConfirmation={requestConfirmation}
        reload={reload}
        setMessage={setMessage}
        downloadUpdate={downloadUpdate}
        installUpdate={installUpdate}
        checkForUpdates={checkForUpdates}
      />

      {healthReport && (
        <LibraryHealthDialog
          report={healthReport}
          busy={busy}
          onClose={() => { if (!busy) setHealthReport(null) }}
          onRefresh={() => void inspectLibraries()}
          onRepair={(issueIds) => void repairLibraries(issueIds)}
        />
      )}
      {confirmationDialog}
    </div>
    </AppSessionProvider>
  )
}
