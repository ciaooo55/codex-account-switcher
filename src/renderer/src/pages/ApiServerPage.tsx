import {
  Activity,
  Check,
  CircleAlert,
  Clipboard,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Network,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Route,
  Save,
  Server,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
  WandSparkles,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  ApiUpstreamInput,
  ApiUpstreamAuthMode,
  ApiUpstreamProtocol,
  CredentialSourceInput,
  LocalApiAccessKeyInput,
  LocalApiServerConfigInput,
  LocalApiServerState,
  ModelRoute,
  ModelRouteSourceMode,
  ModelRouteStrategy,
  ModelRouteTarget
} from '../../../shared/api-server'
import { parseCustomApiPaste } from '../../../shared/custom-api'
import {
  Button,
  DialogActions,
  DialogBackdrop,
  DialogHeader,
  DialogPanel,
  Input,
  PageView,
  SegmentedButton,
  SegmentedControl,
  Select
} from '@/components/ui'
import { cn } from '@/lib/cn'
import { codexApi } from '@/services/codexApi'

type Notice = { kind: 'ok' | 'warn' | 'error'; text: string }
type SectionId = 'overview' | 'access-keys' | 'upstreams' | 'credentials' | 'routes'
type UpstreamDialogMode = 'quick' | 'manual' | null

type AccessKeyDraft = LocalApiAccessKeyInput & {
  hasKey: boolean
  keyPreview: string
  isShort?: boolean
  reveal: boolean
}

type UpstreamDraft = ApiUpstreamInput & {
  hasApiKey: boolean
  keyPreview: string
  expanded: boolean
  reveal: boolean
}

type ApiServerDraft = Omit<LocalApiServerConfigInput, 'accessKeys' | 'upstreams'> & {
  accessKeys: AccessKeyDraft[]
  upstreams: UpstreamDraft[]
  credentialSources: CredentialSourceInput[]
}

type UpstreamProbe = {
  loading: boolean
  catalogOk?: boolean
  probeOk?: boolean | null
  message?: string
  latencyMs?: number
}

const textareaClass =
  'min-h-20 w-full resize-y rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-0)] px-2.5 py-2 font-[var(--font-mono)] text-[12px] leading-5 text-[var(--color-text)] outline-none transition-[border-color,box-shadow] placeholder:text-[var(--color-text-muted)] focus-visible:border-[var(--color-accent-strong)] focus-visible:ring-2 focus-visible:ring-[var(--ui-focus)] disabled:opacity-50'

function uniqueId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 16)
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`
  return `${prefix}-${random}`
}

function parseModelList(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/u).map((entry) => entry.trim()).filter(Boolean))]
}

function draftFromState(state: LocalApiServerState): ApiServerDraft {
  return {
    port: state.config.port,
    autoStart: state.config.autoStart,
    requestTimeoutMs: state.config.requestTimeoutMs,
    maxRetrySources: state.config.maxRetrySources,
    retryDelayMs: state.config.retryDelayMs,
    sessionAffinity: state.config.sessionAffinity,
    codexBinding: state.config.codexBinding ?? null,
    accessKeys: state.config.accessKeys.map((entry) => ({ ...entry, reveal: false })),
    upstreams: state.config.upstreams.map((entry) => ({ ...entry, expanded: false, reveal: false })),
    credentialSources: (state.config.credentialSources ?? []).map((entry) => ({ ...entry, models: [...entry.models] })),
    routes: state.config.routes.map((route) => ({
      ...route,
      targets: route.targets.map((target) => ({ ...target }))
    }))
  }
}

function configFromDraft(draft: ApiServerDraft): LocalApiServerConfigInput {
  return {
    port: draft.port,
    autoStart: draft.autoStart,
    requestTimeoutMs: draft.requestTimeoutMs,
    maxRetrySources: draft.maxRetrySources,
    retryDelayMs: draft.retryDelayMs,
    sessionAffinity: draft.sessionAffinity,
    codexBinding: draft.codexBinding ?? null,
    accessKeys: draft.accessKeys.map(({
      hasKey: _hasKey,
      keyPreview: _keyPreview,
      isShort: _isShort,
      reveal: _reveal,
      ...entry
    }) => entry),
    upstreams: draft.upstreams.map(({
      hasApiKey: _hasApiKey,
      keyPreview: _keyPreview,
      expanded: _expanded,
      reveal: _reveal,
      ...entry
    }) => entry),
    credentialSources: draft.credentialSources,
    routes: draft.routes
  }
}

function upstreamInputFromDraft(entry: UpstreamDraft): ApiUpstreamInput {
  const {
    hasApiKey: _hasApiKey,
    keyPreview: _keyPreview,
    expanded: _expanded,
    reveal: _reveal,
    ...upstream
  } = entry
  return upstream
}

function Toggle({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <label className="api-toggle inline-flex min-h-8 cursor-pointer items-center gap-2 text-[12.5px] font-medium text-[var(--color-text-secondary)]">
      <span>{label}</span>
      <span className="switch-control">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-label={label}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span />
      </span>
    </label>
  )
}

function Field({
  label,
  hint,
  children,
  className
}: {
  label: string
  hint?: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <label className={cn('grid min-w-0 gap-1 text-[12px] font-medium text-[var(--color-text-secondary)]', className)}>
      <span>{label}</span>
      {children}
      {hint ? <span className="text-[11px] font-normal leading-4 text-[var(--color-text-muted)]">{hint}</span> : null}
    </label>
  )
}

function EmptyState({ icon: Icon, title, detail, action }: {
  icon: typeof KeyRound
  title: string
  detail: string
  action: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-h-44 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-lg)] bg-[var(--color-surface-2)] text-[var(--color-text-secondary)]">
        <Icon size={19} />
      </span>
      <strong className="text-[13px] font-semibold text-[var(--color-text)]">{title}</strong>
      <span className="max-w-[52ch] text-[12px] leading-5 text-[var(--color-text-muted)]">{detail}</span>
      <div className="mt-1">{action}</div>
    </div>
  )
}

export function ApiServerPage(): React.JSX.Element {
  const [state, setState] = useState<LocalApiServerState | null>(null)
  const [draft, setDraft] = useState<ApiServerDraft | null>(null)
  const [activeSection, setActiveSection] = useState<SectionId>('overview')
  const [activityDialogOpen, setActivityDialogOpen] = useState(false)
  const [tuningDialogOpen, setTuningDialogOpen] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [action, setAction] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [probes, setProbes] = useState<Record<string, UpstreamProbe>>({})
  const [upstreamDialogMode, setUpstreamDialogMode] = useState<UpstreamDialogMode>(null)
  const [pasteText, setPasteText] = useState('')
  const [pasteTargetId, setPasteTargetId] = useState<'new' | string>('new')
  const [pasteNote, setPasteNote] = useState('')
  const [manualUpstream, setManualUpstream] = useState<UpstreamDraft | null>(null)
  const [editingUpstreamId, setEditingUpstreamId] = useState<string | null>(null)
  const [editingRouteIndex, setEditingRouteIndex] = useState<number | null>(null)
  const [codexKeyId, setCodexKeyId] = useState('')
  const [codexModel, setCodexModel] = useState('')
  const [restartCodex, setRestartCodex] = useState(true)

  const acceptState = (next: LocalApiServerState): void => {
    setState(next)
    setDraft(draftFromState(next))
    setDirty(false)
    const binding = next.config.codexBinding
    const usableKey = next.config.accessKeys.find((entry) => entry.enabled)
    const selectedKeyId = next.config.accessKeys.some((entry) => entry.id === codexKeyId && entry.enabled)
      ? codexKeyId
      : (next.config.accessKeys.some((entry) => entry.id === binding?.accessKeyId && entry.enabled)
          ? binding?.accessKeyId ?? ''
          : usableKey?.id ?? '')
    const selectedKey = next.config.accessKeys.find((entry) => entry.id === selectedKeyId)
    const visibleModels = next.config.routes
      .filter((route) => (
        (!selectedKey?.allowedModels.length || selectedKey.allowedModels.includes(route.publicModel))
        && (!(selectedKey?.allowedSourceIds?.length) || route.targets.some((target) => selectedKey.allowedSourceIds?.includes(target.sourceId)))
      ))
      .map((route) => route.publicModel)
    setCodexKeyId(selectedKeyId)
    setCodexModel(visibleModels.includes(codexModel)
      ? codexModel
      : (binding?.model && visibleModels.includes(binding.model) ? binding.model : visibleModels[0] ?? ''))
  }

  const createUpstreamDraft = (): UpstreamDraft => ({
    id: uniqueId('api'),
    name: `API ${(draft?.upstreams.length ?? 0) + 1}`,
    baseUrl: 'https://api.example.com/v1',
    apiKey: undefined,
    protocol: 'auto',
    authMode: 'auto',
    authHeaderName: '',
    authHeaderPrefix: '',
    authQueryParam: 'api_key',
    models: [],
    priority: (draft?.upstreams.length ?? 0) + 1,
    enabled: true,
    hasApiKey: false,
    keyPreview: '',
    expanded: true,
    reveal: true
  })

  const closeUpstreamDialog = (): void => {
    setUpstreamDialogMode(null)
    setPasteText('')
    setPasteTargetId('new')
    setPasteNote('')
    setManualUpstream(null)
  }

  const openQuickImport = (): void => {
    setPasteTargetId('new')
    setPasteNote('')
    setUpstreamDialogMode('quick')
  }

  const openManualUpstream = (): void => {
    setManualUpstream(createUpstreamDraft())
    setUpstreamDialogMode('manual')
  }

  const openManagementSection = (section: SectionId): void => {
    setActiveSection(section)
  }

  const openUpstreamEditor = (id: string): void => {
    setEditingUpstreamId(id)
  }

  const closeUpstreamEditor = (): void => {
    setEditingUpstreamId(null)
  }

  const pasteFromClipboard = async (): Promise<void> => {
    setAction('paste-upstream')
    try {
      const value = await navigator.clipboard.readText()
      if (!value.trim()) {
        setPasteNote('剪贴板没有可识别的文本，请直接粘贴 URL、Key 或 JSON。')
        return
      }
      setPasteText(value)
      setPasteNote(parseCustomApiPaste(value).note)
    } catch {
      setPasteNote('无法读取剪贴板；请在输入框中按 Ctrl + V 粘贴。')
    } finally {
      setAction(null)
    }
  }

  const load = async (): Promise<void> => {
    setLoading(true)
    setNotice(null)
    try {
      acceptState(await codexApi().getLocalApiServerState())
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  useEffect(() => {
    const handleOpenImport = (): void => {
      setActiveSection('upstreams')
      openQuickImport()
    }
    window.addEventListener('codex-account-switcher:open-api-import', handleOpenImport)
    return () => window.removeEventListener('codex-account-switcher:open-api-import', handleOpenImport)
  }, [])

  const updateDraft = (recipe: (current: ApiServerDraft) => ApiServerDraft): void => {
    setDraft((current) => current ? recipe(current) : current)
    setDirty(true)
  }

  const runStateAction = async (
    name: string,
    operation: () => Promise<LocalApiServerState>,
    success: string
  ): Promise<void> => {
    setAction(name)
    setNotice(null)
    try {
      acceptState(await operation())
      setNotice({ kind: 'ok', text: success })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setAction(null)
    }
  }

  const save = async (): Promise<boolean> => {
    if (!draft) return false
    setAction('save')
    setNotice(null)
    try {
      acceptState(await codexApi().saveLocalApiServerConfig(configFromDraft(draft)))
      setNotice({ kind: 'ok', text: 'API 服务配置已安全保存并热更新。' })
      return true
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
      return false
    } finally {
      setAction(null)
    }
  }

  const addAccessKey = async (): Promise<void> => {
    setAction('generate-key')
    try {
      const key = await codexApi().generateLocalApiAccessKey()
      const entry: AccessKeyDraft = {
        id: uniqueId('key'),
        label: `本软件密钥 ${draft ? draft.accessKeys.length + 1 : 1}`,
        key,
        enabled: true,
        allowedModels: [],
        allowedSourceIds: [],
        hasKey: true,
        keyPreview: key,
        reveal: true
      }
      updateDraft((current) => ({ ...current, accessKeys: [...current.accessKeys, entry] }))
      setNotice({ kind: 'ok', text: '已生成本软件客户端密钥。保存后仍可通过复制按钮安全取回。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setAction(null)
    }
  }

  const addManualAccessKey = (): void => {
    const entry: AccessKeyDraft = {
      id: uniqueId('key'),
      label: `本软件密钥 ${draft ? draft.accessKeys.length + 1 : 1}`,
      key: '',
      enabled: true,
      allowedModels: [],
      allowedSourceIds: [],
      hasKey: false,
      keyPreview: '',
      reveal: true
    }
    updateDraft((current) => ({ ...current, accessKeys: [...current.accessKeys, entry] }))
  }

  const copyText = async (value: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      setNotice({ kind: 'ok', text: `${label}已复制到剪贴板。` })
    } catch {
      setNotice({ kind: 'error', text: '复制失败，请手动选择并复制。' })
    }
  }

  const regenerateKey = async (id: string): Promise<void> => {
    setAction(`regenerate-${id}`)
    try {
      const key = await codexApi().generateLocalApiAccessKey()
      updateDraft((current) => ({
        ...current,
        accessKeys: current.accessKeys.map((entry) => entry.id === id
          ? { ...entry, key, hasKey: true, keyPreview: key, reveal: true }
          : entry)
      }))
      setNotice({ kind: 'warn', text: '密钥已在草稿中重新生成。保存后旧密钥立即失效，请先复制新密钥。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setAction(null)
    }
  }

  const copyAccessKey = async (entry: AccessKeyDraft): Promise<void> => {
    if (entry.key) {
      await copyText(entry.key, '访问密钥')
      return
    }
    const bridge = codexApi() as ReturnType<typeof codexApi> & {
      revealLocalApiAccessKey?: (id: string) => Promise<string>
    }
    if (!bridge.revealLocalApiAccessKey) {
      setNotice({ kind: 'warn', text: '当前主进程未提供密钥复制能力；请重新生成后立即复制。' })
      return
    }
    setAction(`copy-${entry.id}`)
    try {
      // The plaintext is copied immediately and deliberately never written into React state.
      await copyText(await bridge.revealLocalApiAccessKey(entry.id), '访问密钥')
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setAction(null)
    }
  }

  const toggleAccessKeyVisibility = async (entry: AccessKeyDraft): Promise<void> => {
    if (entry.key) {
      updateDraft((current) => ({
        ...current,
        accessKeys: current.accessKeys.map((item) => item.id === entry.id ? { ...item, reveal: !item.reveal } : item)
      }))
      return
    }
    const bridge = codexApi() as ReturnType<typeof codexApi> & {
      revealLocalApiAccessKey?: (id: string) => Promise<string>
    }
    if (!bridge.revealLocalApiAccessKey) {
      setNotice({ kind: 'warn', text: '当前主进程未提供明文显示能力；请重新生成后立即复制。' })
      return
    }
    setAction(`reveal-${entry.id}`)
    try {
      const key = await bridge.revealLocalApiAccessKey(entry.id)
      updateDraft((current) => ({
        ...current,
        accessKeys: current.accessKeys.map((item) => item.id === entry.id
          ? { ...item, key, keyPreview: key, hasKey: true, reveal: true }
          : item)
      }))
      setNotice({ kind: 'ok', text: '已显示完整本软件密钥。关闭或刷新页面后会重新脱敏显示。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setAction(null)
    }
  }

  const copyUpstreamKey = async (entry: UpstreamDraft): Promise<void> => {
    if (entry.apiKey) {
      await copyText(entry.apiKey, 'API Key')
      return
    }
    const bridge = codexApi() as ReturnType<typeof codexApi> & {
      revealLocalApiUpstreamKey?: (id: string) => Promise<string>
    }
    if (!bridge.revealLocalApiUpstreamKey) {
      setNotice({ kind: 'warn', text: '当前主进程未提供 API Key 复制能力；请重新填写后保存。' })
      return
    }
    setAction(`copy-upstream-${entry.id}`)
    try {
      // The plaintext only crosses the bridge to be copied and is never stored in React state.
      await copyText(await bridge.revealLocalApiUpstreamKey(entry.id), 'API Key')
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setAction(null)
    }
  }

  const toggleUpstreamKeyVisibility = async (entry: UpstreamDraft): Promise<void> => {
    if (entry.apiKey !== undefined) {
      updateDraft((current) => ({
        ...current,
        upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, reveal: !item.reveal } : item)
      }))
      return
    }
    const bridge = codexApi() as ReturnType<typeof codexApi> & {
      revealLocalApiUpstreamKey?: (id: string) => Promise<string>
    }
    if (!bridge.revealLocalApiUpstreamKey) {
      setNotice({ kind: 'warn', text: '当前主进程未提供 API Key 明文显示能力；请重新填写后保存。' })
      return
    }
    setAction(`reveal-upstream-${entry.id}`)
    try {
      const apiKey = await bridge.revealLocalApiUpstreamKey(entry.id)
      updateDraft((current) => ({
        ...current,
        upstreams: current.upstreams.map((item) => item.id === entry.id
          ? { ...item, apiKey, keyPreview: apiKey, hasApiKey: true, reveal: true }
          : item)
      }))
      setNotice({ kind: 'ok', text: '已显示完整 API Key。关闭或刷新页面后会重新脱敏显示。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setAction(null)
    }
  }

  const addUpstream = (): void => openManualUpstream()

  const refreshModels = async ({
    upstreams,
    testUpstreams,
    refreshCredentials
  }: {
    upstreams: UpstreamDraft[]
    testUpstreams: boolean
    refreshCredentials: boolean
  }): Promise<void> => {
    if (!draft) return
    const actionName = upstreams.length === 1
      ? `test-${upstreams[0].id}`
      : refreshCredentials ? 'refresh-all-models' : 'refresh-models'
    setAction(actionName)
    setNotice(null)
    setProbes((current) => ({
      ...current,
      ...Object.fromEntries(upstreams.map((upstream) => [upstream.id, { loading: true }]))
    }))
    try {
      const result = await codexApi().refreshLocalApiServerModels({
        upstreams: upstreams.map(upstreamInputFromDraft),
        testUpstreams,
        refreshCredentials
      })
      setProbes((current) => ({
        ...current,
        ...Object.fromEntries(result.upstreams.map((upstream) => [upstream.id, {
          loading: false,
          catalogOk: upstream.catalogOk,
          probeOk: upstream.probeOk,
          message: upstream.message,
          latencyMs: upstream.latencyMs
        }]))
      }))
      updateDraft((current) => ({
        ...current,
        upstreams: current.upstreams.map((entry) => {
          const discovered = result.upstreams.find((item) => item.id === entry.id)
          return discovered?.catalogOk
            ? { ...entry, baseUrl: discovered.baseUrl, protocol: discovered.protocol, models: discovered.models }
            : entry
        }),
        credentialSources: refreshCredentials
          ? result.credentialSources.map((source) => ({ ...source, models: [...source.models] }))
          : current.credentialSources,
        // A fetched upstream catalog is useless to Codex until its models are
        // public routes. Cockpit keeps discovery and model visibility in one
        // runtime collection; mirror that behavior here so a successful test
        // immediately prepares the exact list that /v1/models and Codex use.
        routes: (() => {
          const nextUpstreams = current.upstreams.map((entry) => {
            const discovered = result.upstreams.find((item) => item.id === entry.id)
            return discovered?.catalogOk
              ? { ...entry, baseUrl: discovered.baseUrl, protocol: discovered.protocol, models: discovered.models }
              : entry
          })
          const nextCredentials = refreshCredentials
            ? result.credentialSources.map((source) => ({ ...source, models: [...source.models] }))
            : current.credentialSources
          const routes = current.routes.map((route) => ({
            ...route,
            targets: route.targets.map((target) => ({ ...target }))
          }))
          const discovered = [
            ...nextUpstreams.filter((source) => source.enabled).flatMap((source) =>
              source.models.map((model) => ({ sourceId: source.id, model, kind: 'api' as const }))
            ),
            ...nextCredentials.filter((source) => source.enabled).flatMap((source) =>
              source.models.map((model) => ({ sourceId: source.id, model, kind: 'credential' as const }))
            )
          ]
          for (const item of discovered) {
            const route = routes.find((candidate) => candidate.publicModel === item.model)
            if (!route) {
              routes.push({
                publicModel: item.model,
                strategy: 'priority',
                sourceMode: item.kind === 'api' ? 'api_only' : 'credential_only',
                targets: [{ sourceId: item.sourceId, upstreamModel: item.model, priority: 1, enabled: true }]
              })
              continue
            }
            if (route.targets.some((target) => target.sourceId === item.sourceId && target.upstreamModel === item.model)) continue
            if (item.kind === 'api' && route.sourceMode === 'credential_only') route.sourceMode = 'mixed'
            if (item.kind === 'credential' && route.sourceMode === 'api_only') route.sourceMode = 'mixed'
            route.targets.push({ sourceId: item.sourceId, upstreamModel: item.model, priority: route.targets.length + 1, enabled: true })
          }
          return routes
        })()
      }))
      const catalogCount = result.upstreams.filter((upstream) => upstream.catalogOk).length
      const failedCount = result.upstreams.filter((upstream) => !upstream.catalogOk || upstream.probeOk === false).length
      const credentialText = refreshCredentials ? `；已刷新 ${result.credentialSources.length} 个凭证来源的模型映射` : ''
      setNotice({
        kind: failedCount > 0 ? 'warn' : 'ok',
        text: upstreams.length > 0
          ? `已获取 ${catalogCount}/${upstreams.length} 个 API 的模型${failedCount > 0 ? `，${failedCount} 个需要检查测试结果` : ''}${credentialText}。已自动加入公开模型目录草稿，保存后会同步到 Codex。`
          : `已刷新 ${result.credentialSources.length} 个凭证来源的模型映射；已自动加入公开模型目录草稿，保存后会同步到 Codex。`
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setProbes((current) => ({
        ...current,
        ...Object.fromEntries(upstreams.map((upstream) => [upstream.id, { loading: false, catalogOk: false, message }]))
      }))
      setNotice({ kind: 'error', text: message })
    } finally {
      setAction(null)
    }
  }

  const testUpstream = async (upstream: UpstreamDraft): Promise<void> => {
    await refreshModels({ upstreams: [upstream], testUpstreams: true, refreshCredentials: false })
  }

  const saveManualUpstream = async (andTest: boolean): Promise<void> => {
    if (!manualUpstream) return
    if (!manualUpstream.name.trim() || !manualUpstream.baseUrl.trim()) {
      setNotice({ kind: 'error', text: '请填写 API 名称和 API Base URL。' })
      return
    }
    const next = { ...manualUpstream, expanded: true }
    updateDraft((current) => ({ ...current, upstreams: [...current.upstreams, next] }))
    closeUpstreamDialog()
    setNotice({ kind: 'ok', text: `已添加 ${next.name}。${andTest ? '正在获取模型并进行真实测试…' : '保存后即可加入公开模型路由。'}` })
    if (andTest) await testUpstream(next)
  }

  const applyUpstreamPaste = async (andTest: boolean): Promise<void> => {
    if (!draft) return
    const parsed = parseCustomApiPaste(pasteText)
    setPasteNote(parsed.note)
    const current = pasteTargetId === 'new' ? undefined : draft.upstreams.find((entry) => entry.id === pasteTargetId)
    if (!parsed.baseUrl && !current) {
      setNotice({ kind: 'error', text: '未识别到 API 地址，无法创建 API。' })
      return
    }
    if (!parsed.baseUrl && !parsed.apiKey) {
      setNotice({ kind: 'error', text: parsed.note })
      return
    }
    let next: UpstreamDraft
    if (current) {
      next = {
        ...current,
        ...(parsed.baseUrl ? { baseUrl: parsed.baseUrl } : {}),
        ...(parsed.apiKey ? { apiKey: parsed.apiKey, hasApiKey: true, keyPreview: '待保存的新密钥' } : {}),
        expanded: true
      }
      updateDraft((value) => ({ ...value, upstreams: value.upstreams.map((entry) => entry.id === next.id ? next : entry) }))
    } else {
      let host = '粘贴导入的 API'
      try { host = new URL(parsed.baseUrl ?? '').hostname } catch { /* validated when saving/testing */ }
      next = {
        id: uniqueId('api'),
        name: host,
        baseUrl: parsed.baseUrl ?? '',
        ...(parsed.apiKey ? { apiKey: parsed.apiKey } : {}),
        protocol: 'auto',
        authMode: 'auto',
        authHeaderName: '',
        authHeaderPrefix: '',
        authQueryParam: 'api_key',
        models: [],
        priority: draft.upstreams.length + 1,
        enabled: true,
        hasApiKey: Boolean(parsed.apiKey),
        keyPreview: parsed.apiKey ? '待保存的新密钥' : '',
        expanded: true,
        reveal: Boolean(parsed.apiKey)
      }
      updateDraft((value) => ({ ...value, upstreams: [...value.upstreams, next] }))
      setPasteTargetId(next.id)
    }
    closeUpstreamDialog()
    setNotice({ kind: 'ok', text: `${parsed.note}，已填入 ${next.name}。${andTest ? '正在进行真实测试…' : ''}` })
    if (andTest) await testUpstream(next)
  }

  const addRoute = (): void => {
    const source = draft?.upstreams.find((entry) => entry.enabled) ?? draft?.upstreams[0]
    const publicModel = `model-${(draft?.routes.length ?? 0) + 1}`
    const route: ModelRoute = {
      publicModel,
      strategy: 'priority',
      sourceMode: 'api_only',
      targets: source ? [{ sourceId: source.id, upstreamModel: source.models[0] ?? publicModel, priority: 1, enabled: true }] : []
    }
    updateDraft((current) => ({ ...current, routes: [...current.routes, route] }))
  }

  const importDiscoveredModelsToRoutes = (): void => {
    if (!draft) return
    setNotice({ kind: 'ok', text: '已将已发现模型加入公开路由；保存后会出现在 /v1/models，并可应用到 Codex。' })
    updateDraft((current) => {
      const discovered = [
        ...current.upstreams
          .filter((source) => source.enabled)
          .flatMap((source) => source.models.map((model) => ({ sourceId: source.id, model, kind: 'api' as const }))),
        ...current.credentialSources
          .filter((source) => source.enabled)
          .flatMap((source) => source.models.map((model) => ({ sourceId: source.id, model, kind: 'credential' as const })))
      ]
      const routes = current.routes.map((route) => ({ ...route, targets: route.targets.map((target) => ({ ...target })) }))
      for (const item of discovered) {
        const existing = routes.find((route) => route.publicModel === item.model)
        if (!existing) {
          routes.push({
            publicModel: item.model,
            strategy: 'priority',
            sourceMode: item.kind === 'api' ? 'api_only' : 'credential_only',
            targets: [{ sourceId: item.sourceId, upstreamModel: item.model, priority: 1, enabled: true }]
          })
          continue
        }
        const targetExists = existing.targets.some((target) => target.sourceId === item.sourceId && target.upstreamModel === item.model)
        if (targetExists) continue
        if (item.kind === 'api' && existing.sourceMode === 'credential_only') existing.sourceMode = 'mixed'
        if (item.kind === 'credential' && existing.sourceMode === 'api_only') existing.sourceMode = 'mixed'
        existing.targets.push({
          sourceId: item.sourceId,
          upstreamModel: item.model,
          priority: existing.targets.length + 1,
          enabled: true
        })
      }
      return { ...current, routes }
    })
  }

  const routeSources = (route: ModelRoute): Array<{ id: string; label: string; models: string[]; kind: 'api' | 'credential' }> => [
    ...(route.sourceMode === 'credential_only' ? [] : draft?.upstreams.map((entry) => ({ id: entry.id, label: entry.name, models: entry.models, kind: 'api' as const })) ?? []),
    ...(route.sourceMode === 'api_only' ? [] : draft?.credentialSources.map((entry) => ({ id: entry.id, label: entry.label, models: entry.models, kind: 'credential' as const })) ?? [])
  ]

  const updateRoute = (index: number, patch: Partial<ModelRoute>): void => {
    updateDraft((current) => ({
      ...current,
      routes: current.routes.map((route, routeIndex) => routeIndex === index ? { ...route, ...patch } : route)
    }))
  }

  const updateTarget = (routeIndex: number, targetIndex: number, patch: Partial<ModelRouteTarget>): void => {
    updateDraft((current) => ({
      ...current,
      routes: current.routes.map((route, currentRouteIndex) => currentRouteIndex !== routeIndex ? route : {
        ...route,
        targets: route.targets.map((target, currentTargetIndex) => currentTargetIndex === targetIndex ? { ...target, ...patch } : target)
      })
    }))
  }

  const selectedCodexKey = draft?.accessKeys.find((entry) => entry.id === codexKeyId)
  const codexModels = useMemo(() => {
    if (!draft) return []
    const models = draft.routes.map((route) => route.publicModel)
    return selectedCodexKey?.allowedModels.length
      ? models.filter((model) => selectedCodexKey.allowedModels.includes(model))
      : models
  }, [draft, selectedCodexKey])
  const pasteAnalysis = useMemo(() => pasteText.trim() ? parseCustomApiPaste(pasteText) : null, [pasteText])

  const applyToCodex = async (): Promise<void> => {
    if (!codexKeyId || !codexModel) return
    if (dirty && !(await save())) return
    setAction('codex')
    setNotice(null)
    try {
      const result = await codexApi().applyLocalApiServerToCodex({ accessKeyId: codexKeyId, model: codexModel, restart: restartCodex })
      if (!result.ok) {
        setNotice({ kind: 'error', text: result.message })
        return
      }
      const refreshed = await codexApi().getLocalApiServerState()
      acceptState(refreshed)
      const integration = refreshed.codexIntegration
      const stillOverridden = integration && integration.state !== 'active'
      setNotice(stillOverridden
        ? {
            kind: 'warn',
            text: `${result.message}；${integration.message}`
          }
        : { kind: 'ok', text: result.message })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setAction(null)
    }
  }

  const clearSourceCooldown = async (sourceId?: string): Promise<void> => {
    setAction(sourceId ? `recover-${sourceId}` : 'recover-all-sources')
    setNotice(null)
    try {
      const next = await codexApi().clearLocalApiServerCooldowns(sourceId ? [sourceId] : undefined)
      acceptState(next)
      setNotice({ kind: 'ok', text: sourceId ? '已恢复该来源，可立即重新尝试请求。' : '已恢复全部来源，可立即重新尝试请求。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setAction(null)
    }
  }

  if (loading && !draft) {
    return (
      <PageView className="api-server-view items-center justify-center">
        <LoaderCircle className="spin text-[var(--color-accent)]" size={26} aria-hidden="true" />
        <span className="text-[13px] text-[var(--color-text-secondary)]">正在读取 API 服务配置…</span>
      </PageView>
    )
  }

  if (!draft || !state) {
    return (
      <PageView className="api-server-view items-center justify-center">
        <CircleAlert size={28} className="text-[var(--color-danger)]" aria-hidden="true" />
        <strong className="text-[14px]">无法加载 API 服务</strong>
        <span role="alert" className="max-w-[60ch] text-center text-[12px] text-[var(--color-text-secondary)]">{notice?.text ?? '主进程没有返回有效配置。'}</span>
        <Button onClick={() => void load()}><RefreshCw size={15} />重试</Button>
      </PageView>
    )
  }

  const address = `http://127.0.0.1:${state.status.port}`
  const metrics = state.metrics
  const sourceOptions = [
    ...draft.upstreams.map((entry) => ({ id: entry.id, label: entry.name, kind: 'API' })),
    ...draft.credentialSources.map((entry) => ({ id: entry.id, label: entry.label, kind: '凭证' }))
  ]
  const isBusy = action !== null
  const shortKeys = draft.accessKeys.filter((entry) =>
    entry.key ? entry.key.length < 20 : entry.isShort === true
  )
  const modelUsage = Object.entries((metrics?.recentRequests ?? []).reduce<Record<string, { total: number; succeeded: number; failed: number; cost: number; priced: number }>>((result, entry) => {
    const model = entry.model ?? '未声明模型'
    const current = result[model] ?? { total: 0, succeeded: 0, failed: 0, cost: 0, priced: 0 }
    current.total += 1
    if (entry.status >= 200 && entry.status < 400) current.succeeded += 1
    else current.failed += 1
    if (entry.estimatedCostUsd !== undefined) {
      current.cost += entry.estimatedCostUsd
      current.priced += 1
    }
    result[model] = current
    return result
  }, {})).slice(0, 6)
  const codexIntegration = state.codexIntegration
  const codexIntegrationTone = codexIntegration?.state === 'active'
    ? 'is-active'
    : codexIntegration?.state === 'external_override' || codexIntegration?.state === 'binding_mismatch' || codexIntegration?.state === 'model_mismatch' || codexIntegration?.state === 'catalog_missing'
      ? 'is-warning'
      : codexIntegration?.state === 'unavailable'
        ? 'is-error'
        : 'is-neutral'
  const codexActionLabel = codexIntegration && codexIntegration.state !== 'active' && codexIntegration.state !== 'not_bound'
    ? '重新应用到 Codex'
    : '应用到 Codex'
  const sectionTitle = {
    overview: '总览',
    'access-keys': '客户端密钥',
    upstreams: '第三方 API',
    credentials: '账号凭证源',
    routes: '模型总览'
  }[activeSection]

  const renderRouteEditor = (route: ModelRoute, routeIndex: number): React.JSX.Element => (
    <div className="api-route-editor grid gap-3">
      <div className="api-route-config grid grid-cols-[minmax(180px,1.2fr)_minmax(140px,.8fr)_minmax(150px,.8fr)_32px] items-end gap-2.5">
        <Field label="公开模型名"><Input aria-label="公开模型名" className="font-[var(--font-mono)] font-semibold" value={route.publicModel} onChange={(event) => updateRoute(routeIndex, { publicModel: event.target.value })} /></Field>
        <Field label="路由策略"><Select className="w-full" value={route.strategy} onChange={(event) => updateRoute(routeIndex, { strategy: event.target.value as ModelRouteStrategy })}><option value="single">固定单一来源</option><option value="priority">优先级故障转移</option><option value="round_robin">轮询</option></Select></Field>
        <Field label="来源范围"><Select className="w-full" value={route.sourceMode} onChange={(event) => {
          const sourceMode = event.target.value as ModelRouteSourceMode
          const apiIds = new Set(draft.upstreams.map((entry) => entry.id))
          const credentialIds = new Set(draft.credentialSources.map((entry) => entry.id))
          updateRoute(routeIndex, { sourceMode, targets: route.targets.filter((target) => sourceMode === 'api_only' ? apiIds.has(target.sourceId) : sourceMode === 'credential_only' ? credentialIds.has(target.sourceId) : apiIds.has(target.sourceId) || credentialIds.has(target.sourceId)) })
        }}><option value="api_only">仅第三方 API</option><option value="credential_only">仅账号凭证</option><option value="mixed">API + 凭证混合</option></Select></Field>
        <Button variant="danger" size="icon" aria-label={`删除公开模型 ${route.publicModel}`} onClick={() => { updateDraft((current) => ({ ...current, routes: current.routes.filter((_, index) => index !== routeIndex) })); setEditingRouteIndex(null) }}><Trash2 size={15} /></Button>
      </div>
      <section className="api-editor-section">
        <header><strong>模型价格</strong><span>美元 / 100 万 Token；留空表示不估算费用，绝不使用猜测价格。</span></header>
        <div className="api-editor-fields three-columns">
          <Field label="输入单价"><Input type="number" min={0} step="0.0001" value={route.pricing?.inputPerMillion ?? ''} placeholder="未配置" onChange={(event) => updateRoute(routeIndex, { pricing: { inputPerMillion: Number(event.target.value || 0), cachedInputPerMillion: route.pricing?.cachedInputPerMillion ?? 0, outputPerMillion: route.pricing?.outputPerMillion ?? 0 } })} /></Field>
          <Field label="缓存输入单价"><Input type="number" min={0} step="0.0001" value={route.pricing?.cachedInputPerMillion ?? ''} placeholder="未配置" onChange={(event) => updateRoute(routeIndex, { pricing: { inputPerMillion: route.pricing?.inputPerMillion ?? 0, cachedInputPerMillion: Number(event.target.value || 0), outputPerMillion: route.pricing?.outputPerMillion ?? 0 } })} /></Field>
          <Field label="输出单价"><Input type="number" min={0} step="0.0001" value={route.pricing?.outputPerMillion ?? ''} placeholder="未配置" onChange={(event) => updateRoute(routeIndex, { pricing: { inputPerMillion: route.pricing?.inputPerMillion ?? 0, cachedInputPerMillion: route.pricing?.cachedInputPerMillion ?? 0, outputPerMillion: Number(event.target.value || 0) } })} /></Field>
        </div>
        {route.pricing ? <Button size="sm" variant="ghost" onClick={() => updateRoute(routeIndex, { pricing: undefined })}>清除价格配置</Button> : null}
      </section>
      <div className="api-entity-summary"><span>{route.strategy === 'single' ? '固定来源' : route.strategy === 'round_robin' ? '轮询' : '优先级故障转移'}</span><span>{route.targets.filter((target) => target.enabled).length}/{route.targets.length} 个目标启用</span><span>{route.sourceMode === 'api_only' ? '仅 API' : route.sourceMode === 'credential_only' ? '仅凭证' : 'API + 凭证'}</span></div>
      <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]">
        <div className="api-route-heading grid grid-cols-[minmax(140px,1fr)_minmax(150px,1fr)_90px_72px_32px] gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-[10.5px] font-medium text-[var(--color-text-muted)]"><span>来源</span><span>目标模型</span><span>优先级</span><span>状态</span><span /></div>
        {route.targets.map((target, targetIndex) => <div key={`${target.sourceId}-${targetIndex}`} className="api-route-target grid grid-cols-[minmax(140px,1fr)_minmax(150px,1fr)_90px_72px_32px] items-center gap-2 border-b border-[var(--color-border)] px-2 py-2 last:border-b-0">
          <Select aria-label={`${route.publicModel} 路由来源`} className="w-full" value={target.sourceId} onChange={(event) => { const source = routeSources(route).find((entry) => entry.id === event.target.value); updateTarget(routeIndex, targetIndex, { sourceId: event.target.value, upstreamModel: source?.models[0] ?? target.upstreamModel }) }}>{routeSources(route).map((source) => <option key={source.id} value={source.id}>{source.kind === 'credential' ? '凭证 · ' : 'API · '}{source.label}</option>)}</Select>
          <Input aria-label={`${route.publicModel} 目标模型`} className="font-[var(--font-mono)]" list={`models-${routeIndex}-${targetIndex}`} value={target.upstreamModel} onChange={(event) => updateTarget(routeIndex, targetIndex, { upstreamModel: event.target.value })} />
          <datalist id={`models-${routeIndex}-${targetIndex}`}>{routeSources(route).find((entry) => entry.id === target.sourceId)?.models.map((model) => <option value={model} key={model} />)}</datalist>
          <Input aria-label={`${route.publicModel} 目标优先级`} type="number" value={target.priority} onChange={(event) => updateTarget(routeIndex, targetIndex, { priority: Number(event.target.value) })} />
          <Toggle checked={target.enabled} onChange={(enabled) => updateTarget(routeIndex, targetIndex, { enabled })} label={target.enabled ? '启用' : '停用'} />
          <Button size="icon" variant="ghost" aria-label="删除路由目标" onClick={() => updateRoute(routeIndex, { targets: route.targets.filter((_, index) => index !== targetIndex) })}><Trash2 size={14} /></Button>
        </div>)}
        <button type="button" disabled={routeSources(route).length === 0} className="flex min-h-8 w-full items-center justify-center gap-1.5 text-[11.5px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ui-focus)] disabled:cursor-not-allowed disabled:text-[var(--color-text-muted)]" onClick={() => { const sources = routeSources(route); const source = sources.find((entry) => !route.targets.some((target) => target.sourceId === entry.id)) ?? sources[0]; if (!source) return; updateRoute(routeIndex, { targets: [...route.targets, { sourceId: source.id, upstreamModel: source.models[0] ?? route.publicModel, priority: route.targets.length + 1, enabled: true }] }) }}><Plus size={13} />添加目标</button>
      </div>
    </div>
  )

  return (
    <PageView className="api-server-view overflow-y-auto p-0">
      <div className="api-server-status flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-[var(--color-border)] bg-[var(--color-surface-0)] px-4 py-3">
        <div className="flex min-w-[220px] items-center gap-3">
          <span className={cn(
            'flex h-9 w-9 items-center justify-center rounded-[var(--radius-lg)]',
            state.status.running
              ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
              : 'bg-[var(--color-surface-2)] text-[var(--color-text-muted)]'
          )}>
            <Server size={18} aria-hidden="true" />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <strong className="text-[14px]">本地 API 服务</strong>
              <span className={cn(
                'inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-2 py-0.5 text-[11px] font-semibold',
                state.status.running
                  ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]'
                  : 'bg-[var(--color-surface-2)] text-[var(--color-text-secondary)]'
              )}>
                <span className={cn('h-1.5 w-1.5 rounded-full', state.status.running ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-text-muted)]')} />
                {state.status.running ? '运行中' : '已停止'}
              </span>
            </div>
            <button
              type="button"
              className="mt-0.5 font-[var(--font-mono)] text-[11.5px] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ui-focus)]"
              title="复制 API Base URL"
              onClick={() => void copyText(`${address}/v1`, 'API Base URL')}
            >
              {address}/v1 <Copy className="ml-1 inline" size={11} />
            </button>
          </div>
        </div>

        <dl className="flex min-w-0 flex-1 flex-wrap items-center gap-x-6 gap-y-1 text-[11.5px]">
          <div><dt className="text-[var(--color-text-muted)]">PID</dt><dd className="font-[var(--font-mono)] text-[var(--color-text)]">{state.status.pid ?? '—'}</dd></div>
          <div><dt className="text-[var(--color-text-muted)]">启动时间</dt><dd className="text-[var(--color-text)]">{state.status.startedAt ? new Date(state.status.startedAt).toLocaleString() : '—'}</dd></div>
          <div className="min-w-[180px] flex-1"><dt className="text-[var(--color-text-muted)]">最近错误</dt><dd className={cn('truncate', state.status.error ? 'text-[var(--color-danger)]' : 'text-[var(--color-text)]')} title={state.status.error ?? ''}>{state.status.error ?? '无'}</dd></div>
        </dl>

        <div className="flex items-center gap-1.5">
          {state.status.running ? (
            <Button onClick={() => void runStateAction('stop', () => codexApi().stopLocalApiServer(), 'API 服务已停止。')} disabled={isBusy}>
              {action === 'stop' ? <LoaderCircle className="spin" size={15} /> : <Square size={14} />}停止
            </Button>
          ) : (
            <Button variant="default" onClick={() => void runStateAction('start', () => codexApi().startLocalApiServer(), 'API 服务已在固定端口启动。')} disabled={isBusy || dirty} title={dirty ? '请先保存配置' : undefined}>
              {action === 'start' ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}启动
            </Button>
          )}
          <Button onClick={() => void runStateAction('restart', () => codexApi().restartLocalApiServer(), 'API 服务已重启。')} disabled={isBusy || dirty} title={dirty ? '请先保存配置' : undefined}>
            {action === 'restart' ? <LoaderCircle className="spin" size={15} /> : <RotateCcw size={15} />}重启
          </Button>
        </div>
      </div>

      <div className="api-server-workbench mx-auto flex w-full max-w-[1500px] flex-col gap-3 p-3">
        {notice ? (
          <div
            role={notice.kind === 'error' ? 'alert' : 'status'}
            aria-live="polite"
            className={cn(
              'flex items-start gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-[12px] leading-5',
              notice.kind === 'ok' && 'border-[rgba(90,212,143,.28)] bg-[var(--color-accent-soft)] text-[var(--color-text)]',
              notice.kind === 'warn' && 'border-[rgba(227,179,65,.35)] bg-[rgba(227,179,65,.1)] text-[var(--color-text)]',
              notice.kind === 'error' && 'border-[rgba(255,123,114,.32)] bg-[rgba(255,123,114,.1)] text-[var(--color-text)]'
            )}
          >
            {notice.kind === 'ok' ? <Check size={15} className="mt-0.5 shrink-0 text-[var(--color-accent)]" /> : <CircleAlert size={15} className={cn('mt-0.5 shrink-0', notice.kind === 'error' ? 'text-[var(--color-danger)]' : 'text-[var(--color-warn)]')} />}
            <span>{notice.text}</span>
          </div>
        ) : null}

        <section className="api-service-settings" aria-labelledby="service-settings-title">
          <div className="api-service-settings-heading">
            <h2 id="service-settings-title" className="flex items-center gap-2 text-[13px] font-semibold"><Activity size={16} className="text-[var(--color-accent)]" />服务设置</h2>
            <p>固定监听 127.0.0.1，端口冲突时直接提示，不会自动换端口。</p>
          </div>
          <Field label="监听端口" hint={state.status.running && draft.port !== state.status.port ? `当前 ${state.status.port}` : undefined} className="api-service-port">
            <Input aria-label="监听端口" type="number" min={1} max={65535} value={draft.port} onChange={(event) => updateDraft((current) => ({ ...current, port: Number(event.target.value) }))} />
          </Field>
          <Toggle checked={draft.autoStart} onChange={(autoStart) => updateDraft((current) => ({ ...current, autoStart }))} label="随应用自动启动" />
          <Button variant="soft" aria-label="超时与故障切换" onClick={() => setTuningDialogOpen(true)}><Settings2 size={15} />高级设置</Button>
          <Button variant="default" onClick={() => void save()} disabled={!dirty || isBusy}>
            {action === 'save' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{dirty ? '保存并热更新' : '已保存'}
          </Button>
        </section>

        <section className="api-codex-panel" aria-labelledby="codex-api-title">
          <div className="api-codex-heading">
            <h2 id="codex-api-title" className="flex items-center gap-2 text-[13px] font-semibold"><Clipboard size={16} className="text-[var(--color-accent)]" />Codex 接管</h2>
            {codexIntegration ? (
              <div className={cn('api-codex-integration', codexIntegrationTone)} role="status" title={codexIntegration.message}>
                <span className="font-medium">{codexIntegration.state === 'active' ? 'Codex 正在使用本项目 API 服务' : codexIntegration.state === 'external_override' ? 'Codex 已被其他工具接管' : codexIntegration.state === 'binding_mismatch' ? 'Codex 接管配置不一致' : '尚未接管 Codex'}</span>
                <span className="sr-only">{codexIntegration.message}</span>
                {codexIntegration.state === 'external_override' && codexIntegration.configuredProvider ? (
                  <span className="api-codex-conflict font-[var(--font-mono)]">实际使用：{codexIntegration.configuredProvider} / {codexIntegration.configuredModel ?? '未设置模型'}。</span>
                ) : null}
              </div>
            ) : <p>写入固定本地地址、项目密钥和公开模型。</p>}
          </div>
          <div className="api-codex-controls">
            <Field label="Codex 项目密钥"><Select className="w-full" value={codexKeyId} onChange={(event) => { setCodexKeyId(event.target.value); setCodexModel('') }}><option value="">选择已启用密钥</option>{draft.accessKeys.filter((entry) => entry.enabled).map((entry) => <option value={entry.id} key={entry.id}>{entry.label}</option>)}</Select></Field>
            <Field label={`默认公开模型 · ${codexModels.length}`}><Select className="w-full" value={codexModel} onChange={(event) => setCodexModel(event.target.value)}><option value="">选择模型</option>{codexModels.map((model) => <option key={model} value={model}>{model}</option>)}</Select></Field>
            <Toggle checked={restartCodex} onChange={setRestartCodex} label="重启并修复会话" />
            <Button variant="default" size="lg" disabled={isBusy || !codexKeyId || !codexModel} onClick={() => void applyToCodex()}>{action === 'codex' ? <LoaderCircle className="spin" size={15} /> : <ClipboardPasteIcon />}{codexActionLabel}</Button>
          </div>
        </section>

        {shortKeys.length > 0 ? (
          <div role="status" className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[rgba(227,179,65,.35)] bg-[rgba(227,179,65,.08)] px-3 py-2 text-[11.5px] leading-5">
            <ShieldCheck size={15} className="mt-0.5 shrink-0 text-[var(--color-warn)]" />
            <span>检测到 {shortKeys.length} 个短密钥。短密钥可用于本机临时测试，但更容易被猜中；正式使用建议一键生成安全随机密钥。</span>
          </div>
        ) : null}

        <div className="api-server-layout grid min-h-[430px] grid-cols-[190px_minmax(0,1fr)] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-0)]">
          <nav className="flex flex-col gap-1 border-r border-[var(--color-border)] bg-[var(--color-surface-1)] p-2" aria-label="API 服务配置">
            {([
              ['overview', Activity, '总览', metrics?.totalRequests ?? 0],
              ['access-keys', KeyRound, '客户端密钥', draft.accessKeys.length],
              ['upstreams', Network, '第三方 API', draft.upstreams.length],
              ['credentials', ShieldCheck, '账号凭证源', draft.credentialSources.length],
              ['routes', Route, '模型总览', draft.routes.length]
            ] as const).map(([id, Icon, label, count]) => (
              <button
                type="button"
                key={id}
                onClick={() => openManagementSection(id)}
                aria-label={`打开 ${id === 'upstreams' ? 'API' : id === 'routes' ? '公开模型路由' : label}`}
                aria-current={activeSection === id ? 'page' : undefined}
                className={cn(
                  'flex min-h-9 items-center gap-2 rounded-[var(--radius-md)] px-2.5 text-left text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ui-focus)]',
                  activeSection === id
                    ? 'bg-[var(--color-surface-3)] text-[var(--color-text)]'
                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]'
                )}
              >
                <Icon size={15} className={activeSection === id ? 'text-[var(--color-accent)]' : undefined} />
                <span className="flex-1">{label}</span>
                <span className="rounded-[var(--radius-pill)] bg-[var(--color-surface-0)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-text-muted)]">{count}</span>
              </button>
            ))}
            <div className="mt-auto rounded-[var(--radius-md)] bg-[var(--color-surface-2)] p-2.5 text-[10.5px] leading-4 text-[var(--color-text-muted)]">
              <ShieldCheck size={14} className="mb-1.5 text-[var(--color-accent)]" />
              客户端使用本软件密钥访问本地 API；本软件转发请求时，再使用每个第三方 API 自己的 Key。两者互不替代。
            </div>
          </nav>

          {activeSection === 'overview' ? <section className="api-management-overview" aria-label="API 服务管理总览">
            <header className="api-overview-header">
              <div>
                <strong>服务总览</strong>
                <p>本地服务使用一个固定地址，将客户端请求路由到已启用的 API 或账号凭证。</p>
              </div>
              <Button size="sm" variant="soft" disabled={isBusy} onClick={() => void refreshModels({ upstreams: draft.upstreams.filter((entry) => entry.enabled), testUpstreams: false, refreshCredentials: true })}>
                {action === 'refresh-all-models' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}刷新模型目录
              </Button>
            </header>

            <div className="api-overview-summary" aria-label="API 服务资源统计">
              {([
                ['access-keys', '客户端密钥', draft.accessKeys.filter((entry) => entry.enabled).length, `${draft.accessKeys.length} 枚已配置`],
                ['upstreams', 'API', draft.upstreams.filter((entry) => entry.enabled).length, `${draft.upstreams.length} 个已配置`],
                ['credentials', '凭证池', draft.credentialSources.filter((entry) => entry.enabled).length, `${draft.credentialSources.length} 个可选来源`],
                ['routes', '公开模型', draft.routes.length, '与 /v1/models 一致']
              ] as const).map(([id, label, value, detail]) => (
                <button key={id} type="button" className="api-overview-summary-item" onClick={() => openManagementSection(id)}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                  <small>{detail}</small>
                </button>
              ))}
            </div>

            <div className="api-overview-grid">
              <section className="api-overview-panel api-overview-access" aria-labelledby="api-overview-access-title">
                <header>
                  <div><strong id="api-overview-access-title">服务访问</strong><span>客户端只需要本地地址、本软件密钥和公开模型名。</span></div>
                  <span className={cn('api-overview-state', state.status.running ? 'is-running' : 'is-stopped')}>{state.status.running ? '服务在线' : '服务离线'}</span>
                </header>
                <dl className="api-overview-config-list">
                  <div><dt>API Base URL</dt><dd><code>{address}/v1</code><Button size="icon" variant="ghost" aria-label="复制总览 API Base URL" title="复制" onClick={() => void copyText(`${address}/v1`, 'API Base URL')}><Copy size={13} /></Button></dd></div>
                  <div><dt>Codex 状态</dt><dd><span>{codexIntegration?.state === 'active' ? '已接管' : codexIntegration?.state === 'external_override' ? '被其他工具覆盖' : '未接管'}</span><small>{codexIntegration?.configuredModel || codexModel || '未选择默认模型'}</small></dd></div>
                  <div><dt>客户端密钥</dt><dd><span>{draft.accessKeys.find((entry) => entry.id === codexKeyId)?.label ?? '未选择'}</span><Button size="sm" variant="ghost" onClick={() => openManagementSection('access-keys')}>管理</Button></dd></div>
                  <div><dt>监听</dt><dd><code>127.0.0.1:{draft.port}</code><span>{draft.autoStart ? '随应用启动' : '手动启动'}</span></dd></div>
                </dl>
              </section>

              <section className="api-overview-panel api-overview-sources" aria-labelledby="api-overview-sources-title">
                <header>
                  <div><strong id="api-overview-sources-title">来源池</strong><span>启用状态、优先级和故障切换由同一运行配置控制。</span></div>
                  <Button size="sm" variant="ghost" onClick={() => openManagementSection('upstreams')}>管理 API</Button>
                </header>
                <div className="api-overview-source-list">
                  {draft.upstreams.length === 0 && draft.credentialSources.length === 0 ? <span className="api-overview-empty">尚未添加 API 或账号凭证来源</span> : null}
                  {draft.upstreams.slice(0, 3).map((entry) => (
                    <button key={entry.id} type="button" onClick={() => { openManagementSection('upstreams'); setEditingUpstreamId(entry.id) }}>
                      <span className={cn('api-overview-dot', entry.enabled ? 'is-enabled' : 'is-disabled')} />
                      <span><strong>{entry.name}</strong><small>{entry.models.length} 个模型 · 优先级 {entry.priority}</small></span>
                      <em>API</em>
                    </button>
                  ))}
                  {draft.credentialSources.slice(0, Math.max(0, 4 - Math.min(3, draft.upstreams.length))).map((entry) => (
                    <button key={entry.id} type="button" onClick={() => openManagementSection('credentials')}>
                      <span className={cn('api-overview-dot', entry.enabled ? 'is-enabled' : 'is-disabled')} />
                      <span><strong>{entry.label}</strong><small>{entry.models.length} 个模型 · 优先级 {entry.priority}</small></span>
                      <em>凭证</em>
                    </button>
                  ))}
                </div>
                {draft.upstreams.length + draft.credentialSources.length > 4 ? <button type="button" className="api-overview-more" onClick={() => openManagementSection('credentials')}>查看全部 {draft.upstreams.length + draft.credentialSources.length} 个来源</button> : null}
              </section>

              <section className="api-overview-panel api-overview-health" aria-labelledby="api-overview-health-title">
                <header>
                  <div><strong id="api-overview-health-title">服务健康</strong><span>请求记录只保留在内存中，不记录消息内容、密钥或上游地址。</span></div>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="ghost" onClick={() => setActivityDialogOpen(true)}>查看请求</Button>
                    <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>刷新状态</Button>
                  </div>
                </header>
                <div className="api-overview-health-grid">
                  <div><span>请求</span><strong>{metrics?.totalRequests ?? 0}</strong></div>
                  <div><span>成功</span><strong>{metrics?.successfulRequests ?? 0}</strong></div>
                  <div><span>失败</span><strong>{metrics?.failedRequests ?? 0}</strong></div>
                  <div><span>冷却</span><strong>{metrics?.sourceHealth.filter((item) => item.state === 'cooling_down').length ?? 0}</strong></div>
                </div>
                <div className="api-overview-health-list" aria-label="最近 API 请求">
                  {metrics?.recentRequests?.length ? metrics.recentRequests.slice(0, 3).map((entry) => (
                    <div key={entry.id}><code>{entry.model ?? entry.endpoint}</code><span>{entry.sourceId ?? '未选择来源'}</span><em className={entry.status >= 200 && entry.status < 400 ? 'is-success' : 'is-error'}>{entry.status} · {entry.durationMs} ms</em></div>
                  )) : <span className="api-overview-empty">服务启动后，这里会显示最近请求和来源健康状态</span>}
                </div>
              </section>

              <section className="api-overview-panel api-overview-model-usage" aria-labelledby="api-overview-model-usage-title">
                <header>
                  <div><strong id="api-overview-model-usage-title">模型使用</strong><span>基于当前应用运行期间的真实请求记录；上游没有返回计费数据时不会虚构费用。</span></div>
                  <Button size="sm" variant="ghost" onClick={() => setActivityDialogOpen(true)}>查看明细</Button>
                </header>
                {modelUsage.length ? <div className="api-overview-model-usage-list">
                  {modelUsage.map(([model, usage]) => <div key={model}><code title={model}>{model}</code><span>{usage.total} 次</span><span className="is-success">成功 {usage.succeeded}</span><span className={usage.failed ? 'is-error' : undefined}>失败 {usage.failed}</span><small>{usage.priced ? `预估 $${usage.cost.toFixed(6)}` : '暂无计费数据'}</small></div>)}
                </div> : <span className="api-overview-empty">服务收到请求后，这里会按公开模型显示成功、失败和可用的计费信息。</span>}
              </section>

              <section className="api-overview-panel api-overview-models" aria-labelledby="api-overview-models-title">
                <header>
                  <div><strong id="api-overview-models-title">公开模型目录</strong><span>这里显示的模型与本地 `/v1/models` 和 Codex 可选目录一致。</span></div>
                  <Button size="sm" variant="ghost" onClick={() => openManagementSection('routes')}>管理路由</Button>
                </header>
                <div className="api-overview-model-list">
                  {draft.routes.length > 0 ? draft.routes.slice(0, 12).map((route) => <code key={route.publicModel} title={route.publicModel}>{route.publicModel}</code>) : <span className="api-overview-empty">尚未配置公开模型</span>}
                  {draft.routes.length > 12 ? <button type="button" onClick={() => openManagementSection('routes')}>+{draft.routes.length - 12}</button> : null}
                </div>
              </section>

              <section className="api-overview-panel api-overview-compat" aria-labelledby="api-overview-compat-title">
                <header><div><strong id="api-overview-compat-title">兼容协议</strong><span>同一固定端口提供常用客户端协议，不额外启动随机端口。</span></div></header>
                <div className="api-overview-endpoints">
                  <div><span>OpenAI</span><code>/v1/responses · /v1/chat/completions · /v1/models</code></div>
                  <div><span>Anthropic</span><code>/v1/messages</code></div>
                  <div><span>Gemini</span><code>/v1beta/models · generateContent</code></div>
                  <div><span>Ollama</span><code>/api/tags · /api/chat · /api/generate</code></div>
                </div>
              </section>
            </div>
          </section> : null}

          {activityDialogOpen ? createPortal(
            <div className="api-activity-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setActivityDialogOpen(false) }}>
              <section className="api-activity-dialog" role="dialog" aria-modal="true" aria-label="API 服务活动">
                <header>
                  <div><span>本次应用运行期间</span><strong>服务健康与最近请求</strong><p>不保存消息内容、访问密钥、上游 URL 或凭证。退出应用后记录自动清除。</p></div>
                  <Button size="icon" variant="ghost" aria-label="关闭 API 服务活动" title="关闭" onClick={() => setActivityDialogOpen(false)}><X size={17} /></Button>
                </header>
                <div className="api-activity-body">
                  <section aria-labelledby="api-source-health-title">
                    <div className="api-activity-section-head"><strong id="api-source-health-title">来源健康</strong><span>{metrics?.sourceHealth.filter((item) => item.state === 'cooling_down').length ?? 0} 个来源处于冷却</span></div>
                    <div className="api-activity-source-grid">
                      {metrics?.sourceHealth.length ? metrics.sourceHealth.map((source) => <div key={source.sourceId} className={cn(source.state === 'cooling_down' ? 'is-cooling' : 'is-ready')}><span /><strong>{sourceOptions.find((entry) => entry.id === source.sourceId)?.label ?? source.sourceId}</strong><small>{source.state === 'cooling_down' ? `冷却至 ${source.cooldownUntil ? new Date(source.cooldownUntil).toLocaleTimeString() : '—'}` : '可用'}</small>{source.state === 'cooling_down' ? <Button size="sm" variant="ghost" disabled={action === `recover-${source.sourceId}`} onClick={() => void clearSourceCooldown(source.sourceId)}>{action === `recover-${source.sourceId}` ? <LoaderCircle className="spin" size={12} /> : <RotateCcw size={12} />}恢复</Button> : null}</div>) : <span className="api-activity-empty">暂无已配置来源</span>}
                    </div>
                  </section>
                  <section aria-labelledby="api-request-log-title">
                    <div className="api-activity-section-head"><strong id="api-request-log-title">最近请求</strong><span>{metrics?.totalRequests ?? 0} 次请求 · {metrics?.successfulRequests ?? 0} 成功 · {metrics?.failedRequests ?? 0} 失败</span></div>
                    {metrics?.recentRequests.length ? <div className="api-activity-log" role="table" aria-label="最近 API 请求">
                      <div className="api-activity-log-head" role="row"><span>时间</span><span>模型 / 接口</span><span>来源</span><span>状态</span></div>
                      {metrics.recentRequests.map((entry) => <div key={entry.id} role="row"><time>{new Date(entry.at).toLocaleTimeString()}</time><code title={entry.endpoint}>{entry.model ?? entry.endpoint}</code><span title={entry.sourceId ?? ''}>{sourceOptions.find((source) => source.id === entry.sourceId)?.label ?? entry.sourceId ?? '—'}</span><em className={entry.status >= 200 && entry.status < 400 ? 'is-success' : 'is-error'}>{entry.status} · {entry.durationMs} ms</em></div>)}
                    </div> : <div className="api-activity-empty">尚未收到本地 API 请求。启动服务后，客户端请求会显示在这里。</div>}
                  </section>
                </div>
              </section>
            </div>, document.body
          ) : null}

          {activeSection !== 'overview' ? <section className={cn('api-management-section min-w-0', `is-${activeSection}`)} aria-label={sectionTitle}>
            <div className="api-management-section-header">
              <div><span>API 服务管理</span><strong>{sectionTitle}</strong></div>
              <div className="api-management-section-actions">
                <span>{dirty ? '存在未保存的更改' : '所有更改已保存'}</span>
                <Button variant="default" disabled={!dirty || isBusy} onClick={() => void save()}>{action === 'save' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{dirty ? '保存更改' : '已保存'}</Button>
              </div>
            </div>
            {activeSection === 'access-keys' ? (
              <section aria-labelledby="access-keys-title">
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
                  <div><h2 id="access-keys-title" className="text-[13px] font-semibold">本软件访问密钥</h2><p className="mt-0.5 max-w-[72ch] text-[11px] text-[var(--color-text-muted)]">Codex 或其他客户端请求本软件 API 时使用，相当于本软件的门禁密钥；它与第三方 API Key 完全独立。</p></div>
                  <div className="flex items-center gap-1.5">
                    <Button onClick={addManualAccessKey} disabled={isBusy}><Plus size={15} />手动添加</Button>
                    <Button variant="soft" onClick={() => void addAccessKey()} disabled={isBusy}>{action === 'generate-key' ? <LoaderCircle className="spin" size={15} /> : <WandSparkles size={15} />}生成安全密钥</Button>
                  </div>
                </header>
                {draft.accessKeys.length === 0 ? (
                  <EmptyState icon={KeyRound} title="还没有访问密钥" detail="创建一枚项目密钥后，Codex 或其他客户端才能访问本地 API 服务。" action={<div className="flex gap-1.5"><Button onClick={addManualAccessKey}><Plus size={15} />手动添加</Button><Button variant="default" onClick={() => void addAccessKey()}><WandSparkles size={15} />生成安全密钥</Button></div>} />
                ) : (
                  <div className="api-key-list">
                    {draft.accessKeys.map((entry) => {
                      const storedKey = entry.key === undefined && entry.hasKey
                      const allowedSourceIds = entry.allowedSourceIds ?? []
                      return (
                       <article key={entry.id} className="api-key-card grid gap-2.5 px-3 py-3">
                         <div className="flex flex-wrap items-center gap-2">
                          <Input aria-label="密钥名称" className="max-w-[260px] font-medium" value={entry.label} onChange={(event) => updateDraft((current) => ({ ...current, accessKeys: current.accessKeys.map((item) => item.id === entry.id ? { ...item, label: event.target.value } : item) }))} />
                          <Toggle checked={entry.enabled} onChange={(enabled) => updateDraft((current) => ({ ...current, accessKeys: current.accessKeys.map((item) => item.id === entry.id ? { ...item, enabled } : item) }))} label={entry.enabled ? '已启用' : '已禁用'} />
                          <div className="ml-auto flex items-center gap-1">
                            <Button size="sm" onClick={() => void regenerateKey(entry.id)} disabled={isBusy}>{action === `regenerate-${entry.id}` ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}重新生成</Button>
                            <Button size="icon" variant="danger" aria-label={`删除密钥 ${entry.label}`} title="删除密钥" onClick={() => updateDraft((current) => ({ ...current, accessKeys: current.accessKeys.filter((item) => item.id !== entry.id) }))}><Trash2 size={15} /></Button>
                           </div>
                         </div>
                         <div className="api-entity-summary" aria-label={`${entry.label} 密钥摘要`}>
                            <span>{entry.enabled ? '可用' : '已停用'}</span>
                            <span>{entry.allowedModels.length > 0 ? `${entry.allowedModels.length} 个模型限制` : '全部公开模型'}</span>
                            <span>{allowedSourceIds.length > 0 ? `${allowedSourceIds.length} 个来源池限制` : '全部 API 与凭证来源'}</span>
                            <span>{storedKey ? entry.keyPreview : '待保存的新密钥'}</span>
                         </div>
                        <div className="grid grid-cols-[minmax(210px,1fr)_minmax(220px,1.2fr)] gap-2.5">
                          <Field label="本软件客户端密钥" hint={storedKey ? '已安全保存：当前显示脱敏摘要；点击眼睛可显示完整值，复制按钮可一键复制' : '可直接填写、显示完整值或一键复制'}>
                            <div className="flex gap-1">
                              <Input
                                aria-label={`${entry.label} 密钥值`}
                                type={entry.reveal || storedKey ? 'text' : 'password'}
                                className="font-[var(--font-mono)]"
                                value={entry.key ?? entry.keyPreview}
                                readOnly={storedKey}
                                placeholder="sk-cas-… 或手动输入"
                                onChange={(event) => updateDraft((current) => ({ ...current, accessKeys: current.accessKeys.map((item) => item.id === entry.id ? { ...item, key: event.target.value, keyPreview: event.target.value, reveal: true } : item) }))}
                              />
                              <Button size="icon" variant="ghost" aria-label={entry.reveal ? `隐藏 ${entry.label}` : `显示 ${entry.label}`} title={entry.reveal ? '隐藏密钥' : '显示完整密钥'} disabled={action === `reveal-${entry.id}`} onClick={() => void toggleAccessKeyVisibility(entry)}>{action === `reveal-${entry.id}` ? <LoaderCircle className="spin" size={14} /> : entry.reveal ? <EyeOff size={14} /> : <Eye size={14} />}</Button>
                              <Button size="icon" aria-label={`复制 ${entry.label}`} title="复制密钥" disabled={action === `copy-${entry.id}`} onClick={() => void copyAccessKey(entry)}>{action === `copy-${entry.id}` ? <LoaderCircle className="spin" size={14} /> : <Copy size={14} />}</Button>
                              {storedKey ? <Button size="sm" onClick={() => updateDraft((current) => ({ ...current, accessKeys: current.accessKeys.map((item) => item.id === entry.id ? { ...item, key: '', keyPreview: '', hasKey: false, reveal: true } : item) }))}>更换</Button> : null}
                            </div>
                          </Field>
                           <Field label="模型白名单" hint="逗号或换行分隔；留空允许访问全部公开模型">
                            <Input
                              aria-label={`${entry.label} 模型白名单`}
                              value={entry.allowedModels.join(', ')}
                              placeholder="留空 = 全部公开模型"
                              onChange={(event) => updateDraft((current) => ({ ...current, accessKeys: current.accessKeys.map((item) => item.id === entry.id ? { ...item, allowedModels: parseModelList(event.target.value) } : item) }))}
                             />
                           </Field>
                           <Field className="col-span-2" label="来源池" hint="留空按公开模型路由使用全部来源；选择后，这枚本软件密钥只能使用选中的 API 或账号凭证来源">
                             <div className="api-key-source-pool" role="group" aria-label={`${entry.label} 来源池`}>
                               {sourceOptions.length === 0 ? <span className="text-[11px] text-[var(--color-text-muted)]">请先添加 API 或在账号库导入凭证来源</span> : sourceOptions.map((source) => {
                                 const checked = allowedSourceIds.includes(source.id)
                                 return <label key={source.id} className={cn('api-key-source-option', checked && 'is-selected')}>
                                   <input
                                     type="checkbox"
                                     checked={checked}
                                     onChange={(event) => updateDraft((current) => ({
                                       ...current,
                                       accessKeys: current.accessKeys.map((item) => item.id === entry.id ? {
                                         ...item,
                                         allowedSourceIds: event.target.checked
                                           ? [...new Set([...(item.allowedSourceIds ?? []), source.id])]
                                           : (item.allowedSourceIds ?? []).filter((id) => id !== source.id)
                                       } : item)
                                     }))}
                                   />
                                   <span><strong>{source.label}</strong><small>{source.kind}</small></span>
                                 </label>
                               })}
                             </div>
                           </Field>
                         </div>
                      </article>
                      )
                    })}
                  </div>
                )}
              </section>
            ) : null}

            {activeSection === 'upstreams' ? (
              <section aria-labelledby="upstreams-title">
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
                  <div><h2 id="upstreams-title" className="text-[13px] font-semibold">第三方 API</h2><p className="mt-0.5 max-w-[72ch] text-[11px] text-[var(--color-text-muted)]">每一张卡片独立保存真实服务 URL、Key、协议与模型目录。本软件只在转发时使用这些 Key；测试会自动尝试带 /v1 与不带 /v1。</p></div>
                  <div className="flex items-center gap-1.5">
                    <Button variant="soft" disabled={isBusy || draft.upstreams.filter((entry) => entry.enabled).length === 0} onClick={() => void refreshModels({ upstreams: draft.upstreams.filter((entry) => entry.enabled), testUpstreams: true, refreshCredentials: true })}>{action === 'refresh-all-models' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}刷新全部模型并检查</Button>
                    <Button onClick={openQuickImport}><Clipboard size={15} />快速导入</Button>
                    <Button variant="soft" onClick={addUpstream}><Plus size={15} />添加 API</Button>
                  </div>
                </header>
                {draft.upstreams.length === 0 ? (
                  <EmptyState icon={Network} title="还没有 API" detail="快速导入可识别 URL、Key、JSON 和 Base64；手动填写适合已知参数的 API。" action={<div className="flex gap-1.5"><Button onClick={openQuickImport}><Clipboard size={15} />快速导入 API</Button><Button variant="default" onClick={addUpstream}><Plus size={15} />添加 API</Button></div>} />
                ) : (
                  <div className="api-api-list">
                    {draft.upstreams.map((entry) => {
                      const probe = probes[entry.id]
                      return (
                        <article key={entry.id} className="api-api-card">
                          <div className="api-api-card-head">
                            <button type="button" className="api-api-card-primary" aria-expanded={editingUpstreamId === entry.id} onClick={() => openUpstreamEditor(entry.id)}>
                              <span className={cn('h-2 w-2 shrink-0 rounded-full', entry.enabled ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-text-muted)]')} />
                              <span className="api-api-card-identity">
                                <strong title={entry.name}>{entry.name}</strong>
                                <code title={entry.baseUrl}>{entry.baseUrl}</code>
                              </span>
                            </button>
                            <div className="api-api-card-actions">
                              <Toggle checked={entry.enabled} onChange={(enabled) => updateDraft((current) => ({ ...current, upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, enabled } : item) }))} label={entry.enabled ? '启用' : '停用'} />
                              <Button size="icon" variant="ghost" aria-label={`编辑 API ${entry.name}`} title="编辑 API" onClick={() => openUpstreamEditor(entry.id)}><Pencil size={14} /></Button>
                              <Button size="icon" variant="ghost" aria-label="测试并获取模型" title={`测试 ${entry.name} 并获取模型`} onClick={() => void testUpstream(entry)} disabled={probe?.loading}>{probe?.loading ? <LoaderCircle className="spin" size={14} /> : <Activity size={14} />}</Button>
                              <Button size="icon" variant="danger" aria-label={`删除 API ${entry.name}`} title="删除 API" onClick={() => updateDraft((current) => ({ ...current, upstreams: current.upstreams.filter((item) => item.id !== entry.id), routes: current.routes.map((route) => ({ ...route, targets: route.targets.filter((target) => target.sourceId !== entry.id) })) }))}><Trash2 size={15} /></Button>
                            </div>
                          </div>
                          <div className="api-api-card-meta" aria-label={`${entry.name} API 摘要`}>
                            <span>{entry.models.length} 个模型</span>
                            <span>{entry.protocol === 'auto' ? '自动识别协议' : entry.protocol}</span>
                            <span title={entry.hasApiKey || entry.apiKey ? '点击卡片可显示或复制完整 API Key' : undefined}>{entry.apiKey || entry.keyPreview || (entry.hasApiKey ? 'API Key 已保存' : '无需 Key')}</span>
                            <span>优先级 {entry.priority}</span>
                          </div>
                          <div className={cn('api-api-card-result', probe?.loading ? 'is-loading' : probe && !probe.catalogOk ? 'is-error' : probe?.probeOk === false ? 'is-warning' : probe?.catalogOk ? 'is-success' : 'is-idle')}>
                            {probe?.loading ? <LoaderCircle className="spin" size={13} /> : probe?.catalogOk ? <Check size={13} /> : probe && !probe.catalogOk ? <CircleAlert size={13} /> : <Activity size={13} />}
                            <span>{probe?.loading ? '正在检查 API' : probe ? `${probe.catalogOk ? probe.probeOk === false ? '模型已获取，对话测试失败' : 'API 已验证' : 'API 检查失败'} · ${probe.latencyMs ?? 0} ms` : '尚未测试连接'}</span>
                          </div>
                          <div className="api-api-card-models">
                            {entry.models.length > 0 ? entry.models.slice(0, 5).map((model) => <code key={model} title={model}>{model}</code>) : <span>测试后将在这里显示可用模型</span>}
                            {entry.models.length > 5 ? <small>+{entry.models.length - 5}</small> : null}
                          </div>
                        </article>
                      )
                    })}
                  </div>
                )}
              </section>
            ) : null}

            {activeSection === 'credentials' ? (
              <section aria-labelledby="credential-sources-title">
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
                  <div>
                    <h2 id="credential-sources-title" className="text-[13px] font-semibold">账号凭证 API 源</h2>
                    <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">来自 Codex、Grok 与 CPA 账号库的安全引用；Token 不会进入 Renderer 或 API 服务配置。</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--color-accent-soft)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-accent)]"><ShieldCheck size={13} />已隔离秘密</span>
                    <Button variant="soft" disabled={isBusy} onClick={() => void refreshModels({ upstreams: [], testUpstreams: false, refreshCredentials: true })}>{action === 'refresh-all-models' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}刷新凭证模型</Button>
                  </div>
                </header>
                {draft.credentialSources.length === 0 ? (
                  <EmptyState icon={ShieldCheck} title="账号库中没有可用凭证" detail="先在 Codex、Grok 或 CPA 账号页导入凭证，再回到此处启用它作为 API 服务来源。" action={<Button onClick={() => void refreshModels({ upstreams: [], testUpstreams: false, refreshCredentials: true })}><RefreshCw size={14} />刷新凭证源</Button>} />
                ) : (
                  <div className="api-credential-list">
                    {draft.credentialSources.map((source) => {
                      const providerLabel = {
                        codex: 'Codex',
                        'cpa-codex': 'CPA · Codex',
                        grok: 'Grok',
                        'cpa-grok': 'CPA · Grok'
                      }[source.provider]
                      return (
                        <article key={source.id} className="api-credential-row grid grid-cols-[minmax(180px,1.3fr)_100px_110px_minmax(220px,1.5fr)] items-center gap-3 px-3 py-3">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className={cn('h-2 w-2 shrink-0 rounded-full', source.enabled ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-text-muted)]')} />
                              <strong className="truncate text-[12.5px]" title={source.label}>{source.label}</strong>
                            </div>
                            <span className="ml-4 block truncate font-[var(--font-mono)] text-[10px] text-[var(--color-text-muted)]" title={source.credentialId}>{source.credentialId}</span>
                          </div>
                          <span className="w-fit rounded-[var(--radius-pill)] bg-[var(--color-surface-2)] px-2 py-1 text-[10.5px] font-medium text-[var(--color-text-secondary)]">{providerLabel}</span>
                          <Field label="优先级">
                            <Input aria-label={`${source.label} 优先级`} type="number" value={source.priority} onChange={(event) => updateDraft((current) => ({ ...current, credentialSources: current.credentialSources.map((entry) => entry.id === source.id ? { ...entry, priority: Number(event.target.value) } : entry) }))} />
                          </Field>
                          <div className="grid min-w-0 gap-2">
                            <Field label={`可用模型 · ${source.models.length}`} hint="凭证映射会自动发现；也可手动补充，逗号或换行分隔">
                              <Input
                                aria-label={`${source.label} 可用模型`}
                                className="font-[var(--font-mono)] text-[11px]"
                                value={source.models.join(', ')}
                                placeholder="未声明模型，路由时手动填写"
                                onChange={(event) => updateDraft((current) => ({ ...current, credentialSources: current.credentialSources.map((entry) => entry.id === source.id ? { ...entry, models: parseModelList(event.target.value) } : entry) }))}
                              />
                            </Field>
                            <Toggle checked={source.enabled} onChange={(enabled) => updateDraft((current) => ({ ...current, credentialSources: current.credentialSources.map((entry) => entry.id === source.id ? { ...entry, enabled } : entry) }))} label={source.enabled ? '已加入 API 池' : '仅账号切换'} />
                          </div>
                          <div className="api-entity-summary">
                            <span>{source.enabled ? '已加入 API 服务' : '仅账号切换'}</span>
                            <span>{source.models.length} 个可用模型</span>
                            <span>优先级 {source.priority}</span>
                          </div>
                        </article>
                      )
                    })}
                  </div>
                )}
              </section>
            ) : null}

            {activeSection === 'routes' ? (
              <section aria-labelledby="routes-title">
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
                  <div><h2 id="routes-title" className="text-[13px] font-semibold">公开模型与路由</h2><p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">客户端只看到公开模型名；每个目标映射到真实 API 或账号凭证的模型。</p></div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button variant="soft" disabled={!draft.upstreams.some((source) => source.enabled && source.models.length > 0) && !draft.credentialSources.some((source) => source.enabled && source.models.length > 0)} onClick={importDiscoveredModelsToRoutes}><WandSparkles size={15} />导入已发现模型</Button>
                    <Button variant="soft" onClick={addRoute}><Plus size={15} />添加公开模型</Button>
                  </div>
                </header>
                {draft.routes.length === 0 ? (
                  <EmptyState icon={Route} title="还没有公开模型" detail="创建公开模型后，/v1/models 与 Codex 模型目录才会显示它。没有路由的模型会返回 model_not_found。" action={<Button variant="default" onClick={addRoute}><Plus size={15} />添加第一个模型</Button>} />
                ) : (
                  <div className="api-route-list">
                    {draft.routes.map((route, routeIndex) => {
                      const enabledTargets = route.targets.filter((target) => target.enabled)
                      const sourceLabels = enabledTargets.map((target) => sourceOptions.find((source) => source.id === target.sourceId)?.label ?? target.sourceId)
                      return <article key={`${route.publicModel}-${routeIndex}`} className="api-route-card api-route-summary-card">
                        <button type="button" className="api-route-summary-main" onClick={() => setEditingRouteIndex(routeIndex)} aria-label={`编辑模型 ${route.publicModel}`}>
                          <code title={route.publicModel}>{route.publicModel}</code>
                          <span>{route.strategy === 'single' ? '固定单一来源' : route.strategy === 'round_robin' ? '轮询' : '优先级故障转移'}</span>
                          <span title={sourceLabels.join('、')}>{sourceLabels.join('、') || '尚未启用来源'}</span>
                          <small>{enabledTargets.map((target) => target.upstreamModel).join('、') || '未映射'}</small>
                        </button>
                        <div className="api-route-summary-actions"><span>{enabledTargets.length}/{route.targets.length} 来源启用</span><Button size="icon" variant="ghost" aria-label={`编辑模型 ${route.publicModel}`} title="编辑模型路由" onClick={() => setEditingRouteIndex(routeIndex)}><Pencil size={14} /></Button></div>
                      </article>
                    })}
                  </div>
                )}
              </section>
            ) : null}
          </section> : null}
        </div>

        {tuningDialogOpen ? createPortal(
          <DialogBackdrop className="api-upstream-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setTuningDialogOpen(false) }}>
            <DialogPanel className="api-upstream-dialog max-w-[680px]" role="dialog" aria-modal="true" aria-labelledby="api-tuning-title">
              <DialogHeader>
                <div><h2 id="api-tuning-title" className="text-[15px] font-semibold text-[var(--color-text)]">超时、重试与会话路由</h2><p className="mt-1 text-[11px] text-[var(--color-text-muted)]">这些设置直接作用于运行中的 API 服务，保存后热更新。</p></div>
                <Button size="icon" variant="ghost" aria-label="关闭超时与故障切换窗口" onClick={() => setTuningDialogOpen(false)}><X size={17} /></Button>
              </DialogHeader>
              <div className="api-upstream-dialog-body api-editor-dialog-body">
                <section className="api-editor-section">
                  <header><strong>上游请求</strong><span>只限制建立上游响应的等待时间；流已经开始后不会因为该值被中途截断。</span></header>
                  <div className="api-editor-fields three-columns">
                    <Field label="请求超时（秒）" hint="5–1800 秒"><Input type="number" min={5} max={1800} value={Math.round((draft.requestTimeoutMs ?? 120000) / 1000)} onChange={(event) => updateDraft((current) => ({ ...current, requestTimeoutMs: Number(event.target.value) * 1000 }))} /></Field>
                    <Field label="最多尝试来源" hint="0 = 尝试全部可用来源"><Input type="number" min={0} max={100} value={draft.maxRetrySources ?? 0} onChange={(event) => updateDraft((current) => ({ ...current, maxRetrySources: Number(event.target.value) }))} /></Field>
                    <Field label="切换等待（毫秒）" hint="0–30000"><Input type="number" min={0} max={30000} value={draft.retryDelayMs ?? 0} onChange={(event) => updateDraft((current) => ({ ...current, retryDelayMs: Number(event.target.value) }))} /></Field>
                  </div>
                </section>
                <section className="api-editor-section">
                  <header><strong>会话亲和</strong><span>同一对话优先沿用已经成功的来源；来源冷却或失效时仍自动切换备用。</span></header>
                  <Toggle checked={draft.sessionAffinity !== false} onChange={(sessionAffinity) => updateDraft((current) => ({ ...current, sessionAffinity }))} label="保持同一会话使用相同来源" />
                </section>
              </div>
              <DialogActions><Button variant="ghost" onClick={() => setTuningDialogOpen(false)}>完成</Button><Button variant="default" disabled={!dirty || isBusy} onClick={() => void save()}>{action === 'save' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{dirty ? '保存并热更新' : '已保存'}</Button></DialogActions>
            </DialogPanel>
          </DialogBackdrop>, document.body
        ) : null}

        {editingRouteIndex !== null ? createPortal((() => {
          const route = draft.routes[editingRouteIndex]
          if (!route) return null
          return (
            <DialogBackdrop className="api-upstream-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditingRouteIndex(null) }}>
              <DialogPanel className="api-upstream-dialog api-editor-dialog max-w-[860px]" role="dialog" aria-modal="true" aria-labelledby="route-editor-title">
                <DialogHeader>
                  <div><h2 id="route-editor-title" className="text-[15px] font-semibold text-[var(--color-text)]">模型路由</h2><p className="mt-1 truncate text-[11px] text-[var(--color-text-muted)]">客户端名称与每个 API 或凭证来源的真实模型映射。</p></div>
                  <Button size="icon" variant="ghost" aria-label="关闭模型路由窗口" title="关闭" onClick={() => setEditingRouteIndex(null)}><X size={17} /></Button>
                </DialogHeader>
                <div className="api-upstream-dialog-body api-editor-dialog-body">{renderRouteEditor(route, editingRouteIndex)}</div>
                <DialogActions>
                  <span className="mr-auto text-[11px] text-[var(--color-text-muted)]">{dirty ? '存在未保存的更改，保存后立即热更新路由。' : '当前路由已保存。'}</span>
                  <Button variant="ghost" onClick={() => setEditingRouteIndex(null)}>完成</Button>
                  <Button variant="default" disabled={!dirty || isBusy} onClick={() => void save()}>{action === 'save' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{dirty ? '保存更改' : '已保存'}</Button>
                </DialogActions>
              </DialogPanel>
            </DialogBackdrop>
          )
        })(), document.body) : null}

        {editingUpstreamId ? createPortal((() => {
          const entry = draft.upstreams.find((item) => item.id === editingUpstreamId)
          if (!entry) return null
          const probe = probes[entry.id]
          const storedUpstreamKey = entry.apiKey === undefined && entry.hasApiKey
          return (
            <DialogBackdrop className="api-upstream-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeUpstreamEditor() }}>
              <DialogPanel className="api-upstream-dialog api-editor-dialog max-w-[860px]" role="dialog" aria-modal="true" aria-labelledby="api-editor-title">
                <DialogHeader>
                  <div>
                    <h2 id="api-editor-title" className="text-[15px] font-semibold text-[var(--color-text)]">编辑 API</h2>
                    <p className="mt-1 truncate text-[11px] text-[var(--color-text-muted)]">{entry.baseUrl}</p>
                  </div>
                  <Button size="icon" variant="ghost" aria-label="关闭 API 编辑窗口" title="关闭" onClick={closeUpstreamEditor}><X size={17} /></Button>
                </DialogHeader>
                <div className="api-upstream-dialog-body api-editor-dialog-body">
                  <section className="api-editor-section">
                    <header><strong>连接信息</strong><span>本软件请求该 API 时使用，不会写入 Codex 配置。</span></header>
                    <div className="api-editor-fields two-columns">
                      <Field label="名称"><Input autoFocus value={entry.name} onChange={(event) => updateDraft((current) => ({ ...current, upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, name: event.target.value } : item) }))} /></Field>
                      <Field label="API Base URL" hint="可填写域名或 /v1"><Input className="font-[var(--font-mono)]" value={entry.baseUrl} onChange={(event) => updateDraft((current) => ({ ...current, upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, baseUrl: event.target.value } : item) }))} /></Field>
                      <Field label="API Key" hint={storedUpstreamKey ? '已安全保存；可显示完整值、复制或更换' : '本地无鉴权 API 可留空'} className="span-two">
                        <div className="flex min-w-0 gap-1">
                          <Input className="min-w-0 flex-1 font-[var(--font-mono)]" type={entry.reveal || storedUpstreamKey ? 'text' : 'password'} value={entry.apiKey ?? entry.keyPreview} readOnly={storedUpstreamKey} placeholder={entry.hasApiKey ? entry.keyPreview : 'sk-…'} autoComplete="off" onChange={(event) => updateDraft((current) => ({ ...current, upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, apiKey: event.target.value || undefined, reveal: true } : item) }))} />
                          <Button size="icon" variant="ghost" aria-label={entry.reveal ? `隐藏 ${entry.name} API Key` : `显示 ${entry.name} API Key`} title={entry.reveal ? '隐藏 API Key' : '显示完整 API Key'} disabled={action === `reveal-upstream-${entry.id}` || (!entry.apiKey && !entry.hasApiKey)} onClick={() => void toggleUpstreamKeyVisibility(entry)}>{action === `reveal-upstream-${entry.id}` ? <LoaderCircle className="spin" size={14} /> : entry.reveal ? <EyeOff size={14} /> : <Eye size={14} />}</Button>
                          <Button size="icon" aria-label={`复制 ${entry.name} API Key`} title="复制 API Key" disabled={action === `copy-upstream-${entry.id}` || (!entry.apiKey && !entry.hasApiKey)} onClick={() => void copyUpstreamKey(entry)}>{action === `copy-upstream-${entry.id}` ? <LoaderCircle className="spin" size={14} /> : <Copy size={14} />}</Button>
                          {storedUpstreamKey ? <Button size="sm" onClick={() => updateDraft((current) => ({ ...current, upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, apiKey: '', hasApiKey: false, keyPreview: '', reveal: true } : item) }))}>更换</Button> : null}
                        </div>
                      </Field>
                    </div>
                  </section>
                  <section className="api-editor-section">
                    <header><strong>协议与路由</strong><span>自动识别适合大多数 OpenAI 兼容 API，也可指定原生协议。</span></header>
                    <div className="api-editor-fields three-columns">
                      <Field label="协议能力"><Select className="w-full" value={entry.protocol} onChange={(event) => updateDraft((current) => ({ ...current, upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, protocol: event.target.value as ApiUpstreamProtocol } : item) }))}><option value="auto">自动识别（OpenAI）</option><option value="responses">OpenAI Responses</option><option value="chat_completions">OpenAI Chat Completions</option><option value="completions">OpenAI Legacy Completions</option><option value="anthropic_messages">Anthropic Messages</option><option value="gemini">Gemini v1beta GenerateContent</option><option value="gemini_interactions">Gemini v1beta Interactions</option><option value="ollama">Ollama</option></Select></Field>
                      <Field label="API 鉴权"><Select className="w-full" value={entry.authMode ?? 'auto'} onChange={(event) => updateDraft((current) => ({ ...current, upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, authMode: event.target.value as ApiUpstreamAuthMode } : item) }))}><option value="auto">自动识别</option><option value="bearer">Bearer Token</option><option value="x_api_key">x-api-key</option><option value="api_key">api-key</option><option value="x_goog_api_key">x-goog-api-key</option><option value="query">URL 查询参数</option><option value="custom">自定义请求头</option><option value="none">无鉴权</option></Select></Field>
                      <Field label="优先级"><Input type="number" value={entry.priority} onChange={(event) => updateDraft((current) => ({ ...current, upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, priority: Number(event.target.value) } : item) }))} /></Field>
                      {entry.authMode === 'custom' ? <><Field label="自定义鉴权头名称"><Input value={entry.authHeaderName ?? ''} placeholder="x-provider-key" onChange={(event) => updateDraft((current) => ({ ...current, upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, authHeaderName: event.target.value } : item) }))} /></Field><Field label="鉴权值前缀"><Input value={entry.authHeaderPrefix ?? ''} placeholder="Token " onChange={(event) => updateDraft((current) => ({ ...current, upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, authHeaderPrefix: event.target.value } : item) }))} /></Field></> : null}
                      {entry.authMode === 'query' ? <Field label="URL 鉴权参数名"><Input value={entry.authQueryParam ?? 'api_key'} placeholder="api_key" onChange={(event) => updateDraft((current) => ({ ...current, upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, authQueryParam: event.target.value } : item) }))} /></Field> : null}
                    </div>
                  </section>
                  <section className="api-editor-section">
                    <header><strong>可用模型 · {entry.models.length}</strong><span>测试成功后自动填充，也可以逐行编辑。</span></header>
                    <textarea className={cn(textareaClass, 'api-model-editor')} value={entry.models.join('\n')} placeholder="gpt-5.4\nmy-model" onChange={(event) => updateDraft((current) => ({ ...current, upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, models: parseModelList(event.target.value) } : item) }))} />
                    {probe?.message ? <details className={cn('api-probe-details', probe.catalogOk ? probe.probeOk === false ? 'is-warning' : 'is-neutral' : 'is-error')}><summary>查看模型探测与协议诊断</summary><pre>{probe.message}</pre></details> : null}
                  </section>
                </div>
                <DialogActions>
                  <Button variant="ghost" onClick={closeUpstreamEditor}>完成</Button>
                  <Button disabled={probe?.loading} onClick={() => void testUpstream(entry)}>{probe?.loading ? <LoaderCircle className="spin" size={14} /> : <Activity size={14} />}测试并获取模型</Button>
                  <Button variant="default" disabled={!dirty || isBusy} onClick={() => void save()}>{action === 'save' ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}{dirty ? '保存更改' : '已保存'}</Button>
                </DialogActions>
              </DialogPanel>
            </DialogBackdrop>
          )
        })(), document.body) : null}

        {upstreamDialogMode ? createPortal(
          <DialogBackdrop
            className="api-upstream-dialog-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeUpstreamDialog()
            }}
          >
            <DialogPanel className="api-upstream-dialog max-w-[820px]" role="dialog" aria-modal="true" aria-labelledby="upstream-dialog-title">
              <DialogHeader>
                <div>
                  <h2 id="upstream-dialog-title" className="text-[15px] font-semibold text-[var(--color-text)]">添加 API</h2>
                  <p className="mt-1 text-[12px] leading-5 text-[var(--color-text-muted)]">选择快速导入自动识别并测试，或手动填写已知的 API 参数。</p>
                </div>
                <Button size="icon" variant="ghost" aria-label="关闭添加 API 窗口" title="关闭" onClick={closeUpstreamDialog}><span aria-hidden="true" className="text-lg leading-none">×</span></Button>
              </DialogHeader>

              <div className="api-upstream-dialog-modes border-b border-[var(--color-border)] px-4 py-2.5">
                <SegmentedControl aria-label="添加 API 方式">
                  <SegmentedButton selected={upstreamDialogMode === 'quick'} onClick={() => setUpstreamDialogMode('quick')}><WandSparkles size={14} />快速导入</SegmentedButton>
                  <SegmentedButton selected={upstreamDialogMode === 'manual'} onClick={() => { if (!manualUpstream) setManualUpstream(createUpstreamDraft()); setUpstreamDialogMode('manual') }}><Plus size={14} />手动填写</SegmentedButton>
                </SegmentedControl>
              </div>

              {upstreamDialogMode === 'quick' ? (
                <div className="api-upstream-dialog-body api-quick-import-body">
                  <div className="api-import-guide">
                    <ShieldCheck size={16} />
                    <span>支持 URL + Key、JSON、<code>url=… key=…</code>、Base64 与 URL-safe Base64。会智能尝试根路径和 <code>/v1</code>，真实获取模型并可继续发送轻量测试。</span>
                  </div>
                  <div className="api-quick-import-grid">
                    <Field label="粘贴内容" hint="原始内容只用于本次识别与测试，不写入日志。">
                      <div className="api-import-textarea-wrap">
                        <textarea
                          aria-label="API 粘贴内容"
                          className={cn(textareaClass, 'api-import-textarea')}
                          value={pasteText}
                          placeholder={'https://api.example.com/v1\nsk-...\n\n或粘贴 JSON / Base64 文本'}
                          autoFocus
                          onChange={(event) => { setPasteText(event.target.value); setPasteNote('') }}
                        />
                        <Button size="sm" variant="secondary" className="api-import-clipboard" disabled={isBusy} onClick={() => void pasteFromClipboard()}>{action === 'paste-upstream' ? <LoaderCircle className="spin" size={14} /> : <Clipboard size={14} />}从剪贴板粘贴</Button>
                      </div>
                    </Field>
                    <aside className="api-import-preview" aria-live="polite">
                      <strong>识别预览</strong>
                      {pasteAnalysis ? (
                        <>
                          <span className={pasteAnalysis.baseUrl ? 'is-ready' : undefined}>{pasteAnalysis.baseUrl ? '✓ 已识别 API 地址' : '○ 等待 API 地址'}</span>
                          <code title={pasteAnalysis.baseUrl ?? ''}>{pasteAnalysis.baseUrl ?? 'https://…'}</code>
                          <span className={pasteAnalysis.apiKey ? 'is-ready' : undefined}>{pasteAnalysis.apiKey ? '✓ 已识别 API Key' : '○ 可选：API Key'}</span>
                          <small>{pasteAnalysis.note}</small>
                        </>
                      ) : (
                        <span>粘贴后会在此预览识别结果；识别并测试会自动尝试根路径、<code>/v1</code> 与常见兼容路径。</span>
                      )}
                    </aside>
                  </div>
                  <Field label="导入位置" hint={pasteNote || '默认创建 API；也可以更新已有 API。'}>
                    <Select className="w-full" value={pasteTargetId} onChange={(event) => setPasteTargetId(event.target.value)}>
                      <option value="new">创建新 API</option>
                      {draft.upstreams.map((entry) => <option key={entry.id} value={entry.id}>更新 · {entry.name}</option>)}
                    </Select>
                  </Field>
                </div>
              ) : (
                <div className="api-upstream-dialog-body grid gap-4">
                  <div className="api-import-guide">
                    <Network size={16} />
                    <span>手动填写后可先添加，或立即测试 API 并自动填充模型。API Key 只用于本软件转发，不会写进 Codex 配置。</span>
                  </div>
                  {manualUpstream ? (
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="名称"><Input autoFocus value={manualUpstream.name} onChange={(event) => setManualUpstream((current) => current ? { ...current, name: event.target.value } : current)} /></Field>
                      <Field label="API Base URL" hint="可填域名或 /v1；测试会智能探测"><Input className="font-[var(--font-mono)]" value={manualUpstream.baseUrl} onChange={(event) => setManualUpstream((current) => current ? { ...current, baseUrl: event.target.value } : current)} /></Field>
                      <Field label="API Key" hint="可留空，例如本地 Ollama；可显示明文并一键复制，保存后仍可在 API 详情中取回">
                        <div className="flex min-w-0 gap-1">
                          <Input className="min-w-0 flex-1" type={manualUpstream.reveal ? 'text' : 'password'} autoComplete="off" value={manualUpstream.apiKey ?? ''} placeholder="sk-…" onChange={(event) => setManualUpstream((current) => current ? { ...current, apiKey: event.target.value || undefined, hasApiKey: Boolean(event.target.value), keyPreview: event.target.value, reveal: true } : current)} />
                          <Button size="icon" variant="secondary" aria-label={manualUpstream.reveal ? '隐藏 API Key' : '显示 API Key'} title={manualUpstream.reveal ? '隐藏明文' : '显示明文'} onClick={() => setManualUpstream((current) => current ? { ...current, reveal: !current.reveal } : current)}>{manualUpstream.reveal ? <EyeOff size={15} /> : <Eye size={15} />}</Button>
                          <Button size="icon" variant="secondary" aria-label="复制 API Key" title="复制 API Key" disabled={!manualUpstream.apiKey} onClick={() => void copyText(manualUpstream.apiKey ?? '', 'API Key')}><Copy size={15} /></Button>
                        </div>
                      </Field>
                      <Field label="协议能力"><Select className="w-full" value={manualUpstream.protocol} onChange={(event) => setManualUpstream((current) => current ? { ...current, protocol: event.target.value as ApiUpstreamProtocol } : current)}><option value="auto">自动识别（OpenAI）</option><option value="responses">OpenAI Responses</option><option value="chat_completions">OpenAI Chat Completions</option><option value="completions">OpenAI Legacy Completions</option><option value="anthropic_messages">Anthropic Messages</option><option value="gemini">Gemini v1beta GenerateContent</option><option value="gemini_interactions">Gemini v1beta Interactions</option><option value="ollama">Ollama</option></Select></Field>
                      <Field label="API 鉴权" hint="自动会按协议使用标准请求头"><Select className="w-full" value={manualUpstream.authMode ?? 'auto'} onChange={(event) => setManualUpstream((current) => current ? { ...current, authMode: event.target.value as ApiUpstreamAuthMode } : current)}><option value="auto">自动识别</option><option value="bearer">Bearer Token</option><option value="x_api_key">x-api-key</option><option value="api_key">api-key</option><option value="x_goog_api_key">x-goog-api-key</option><option value="query">URL 查询参数</option><option value="custom">自定义请求头</option><option value="none">无鉴权</option></Select></Field>
                      <Field label="优先级"><Input type="number" value={manualUpstream.priority} onChange={(event) => setManualUpstream((current) => current ? { ...current, priority: Number(event.target.value) } : current)} /></Field>
                      {manualUpstream.authMode === 'custom' ? <><Field label="自定义鉴权头名称"><Input value={manualUpstream.authHeaderName ?? ''} placeholder="x-provider-key" onChange={(event) => setManualUpstream((current) => current ? { ...current, authHeaderName: event.target.value } : current)} /></Field><Field label="鉴权值前缀" hint="可选，例如 Token "><Input value={manualUpstream.authHeaderPrefix ?? ''} placeholder="Token " onChange={(event) => setManualUpstream((current) => current ? { ...current, authHeaderPrefix: event.target.value } : current)} /></Field></> : null}
                      {manualUpstream.authMode === 'query' ? <Field label="URL 鉴权参数名" hint="默认 api_key；会用于 API 请求 URL"><Input value={manualUpstream.authQueryParam ?? 'api_key'} placeholder="api_key" onChange={(event) => setManualUpstream((current) => current ? { ...current, authQueryParam: event.target.value } : current)} /></Field> : null}
                    </div>
                  ) : null}
                </div>
              )}

              <DialogActions>
                <Button variant="ghost" onClick={closeUpstreamDialog}>取消</Button>
                {upstreamDialogMode === 'quick' ? (
                  <>
                    <Button disabled={!pasteText.trim() || isBusy} onClick={() => void applyUpstreamPaste(false)}>只识别填入</Button>
                    <Button variant="default" disabled={!pasteText.trim() || isBusy} onClick={() => void applyUpstreamPaste(true)}><Activity size={14} />识别并测试</Button>
                  </>
                ) : (
                  <>
                    <Button disabled={!manualUpstream || isBusy} onClick={() => void saveManualUpstream(false)}>仅添加</Button>
                    <Button variant="default" disabled={!manualUpstream || isBusy} onClick={() => void saveManualUpstream(true)}><Activity size={14} />添加并测试</Button>
                  </>
                )}
              </DialogActions>
            </DialogPanel>
          </DialogBackdrop>
        , document.body) : null}
      </div>
    </PageView>
  )
}

function ClipboardPasteIcon(): React.JSX.Element {
  return <Clipboard size={15} aria-hidden="true" />
}
