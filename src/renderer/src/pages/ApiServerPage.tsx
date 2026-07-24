import {
  Activity,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clipboard,
  Copy,
  KeyRound,
  LoaderCircle,
  Network,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Route,
  Save,
  Server,
  ShieldCheck,
  Square,
  Trash2,
  WandSparkles
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type {
  ApiUpstreamInput,
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
import { Button, Input, PageView, Select } from '@/components/ui'
import { cn } from '@/lib/cn'
import { codexApi } from '@/services/codexApi'

type Notice = { kind: 'ok' | 'warn' | 'error'; text: string }
type SectionId = 'access-keys' | 'upstreams' | 'credentials' | 'routes'

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
}

type ApiServerDraft = Omit<LocalApiServerConfigInput, 'accessKeys' | 'upstreams'> & {
  accessKeys: AccessKeyDraft[]
  upstreams: UpstreamDraft[]
  credentialSources: CredentialSourceInput[]
}

type UpstreamProbe = {
  loading: boolean
  ok?: boolean
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
    accessKeys: state.config.accessKeys.map((entry) => ({ ...entry, reveal: false })),
    upstreams: state.config.upstreams.map((entry) => ({ ...entry, expanded: false })),
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
    accessKeys: draft.accessKeys.map(({
      hasKey: _hasKey,
      keyPreview: _keyPreview,
      isShort: _isShort,
      reveal: _reveal,
      ...entry
    }) => entry),
    upstreams: draft.upstreams.map(({ hasApiKey: _hasApiKey, keyPreview: _keyPreview, expanded: _expanded, ...entry }) => entry),
    credentialSources: draft.credentialSources,
    routes: draft.routes
  }
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
  const [activeSection, setActiveSection] = useState<SectionId>('access-keys')
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [action, setAction] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [probes, setProbes] = useState<Record<string, UpstreamProbe>>({})
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteTargetId, setPasteTargetId] = useState<'new' | string>('new')
  const [pasteNote, setPasteNote] = useState('')
  const [codexKeyId, setCodexKeyId] = useState('')
  const [codexModel, setCodexModel] = useState('')
  const [restartCodex, setRestartCodex] = useState(true)

  const acceptState = (next: LocalApiServerState): void => {
    setState(next)
    setDraft(draftFromState(next))
    setDirty(false)
    const usableKey = next.config.accessKeys.find((entry) => entry.enabled)
    const visibleModels = usableKey?.allowedModels.length
      ? next.config.routes.map((route) => route.publicModel).filter((model) => usableKey.allowedModels.includes(model))
      : next.config.routes.map((route) => route.publicModel)
    setCodexKeyId((current) => next.config.accessKeys.some((entry) => entry.id === current && entry.enabled) ? current : (usableKey?.id ?? ''))
    setCodexModel((current) => visibleModels.includes(current) ? current : (visibleModels[0] ?? ''))
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
        label: `项目密钥 ${draft ? draft.accessKeys.length + 1 : 1}`,
        key,
        enabled: true,
        allowedModels: [],
        hasKey: true,
        keyPreview: key,
        reveal: true
      }
      updateDraft((current) => ({ ...current, accessKeys: [...current.accessKeys, entry] }))
      setNotice({ kind: 'warn', text: '新密钥只在保存前完整显示。请立即复制并妥善保管。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setAction(null)
    }
  }

  const addManualAccessKey = (): void => {
    const entry: AccessKeyDraft = {
      id: uniqueId('key'),
      label: `项目密钥 ${draft ? draft.accessKeys.length + 1 : 1}`,
      key: '',
      enabled: true,
      allowedModels: [],
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

  const addUpstream = (): void => {
    const entry: UpstreamDraft = {
      id: uniqueId('api'),
      name: `第三方 API ${draft ? draft.upstreams.length + 1 : 1}`,
      baseUrl: 'https://api.example.com/v1',
      apiKey: undefined,
      protocol: 'auto',
      models: [],
      priority: (draft?.upstreams.length ?? 0) + 1,
      enabled: true,
      hasApiKey: false,
      keyPreview: '',
      expanded: true
    }
    updateDraft((current) => ({ ...current, upstreams: [...current.upstreams, entry] }))
  }

  const testUpstream = async (upstream: UpstreamDraft): Promise<void> => {
    const startedAt = performance.now()
    setProbes((current) => ({ ...current, [upstream.id]: { loading: true } }))
    try {
      const result = await codexApi().listCustomApiModels({
        baseUrl: upstream.baseUrl,
        ...(upstream.apiKey ? { apiKey: upstream.apiKey } : {})
      })
      const probe = { loading: false, ok: result.ok, message: result.message, latencyMs: Math.round(performance.now() - startedAt) }
      setProbes((current) => ({ ...current, [upstream.id]: probe }))
      if (result.ok) {
        updateDraft((current) => ({
          ...current,
          upstreams: current.upstreams.map((entry) => entry.id === upstream.id
            ? {
                ...entry,
                baseUrl: result.baseUrl,
                models: result.models,
                protocol: result.protocol ?? entry.protocol
              }
            : entry)
        }))
        setNotice({ kind: 'ok', text: `${upstream.name} 测试成功，获取到 ${result.models.length} 个模型。` })
      } else {
        setNotice({ kind: 'error', text: result.message })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setProbes((current) => ({
        ...current,
        [upstream.id]: { loading: false, ok: false, message, latencyMs: Math.round(performance.now() - startedAt) }
      }))
      setNotice({ kind: 'error', text: message })
    }
  }

  const applyUpstreamPaste = async (andTest: boolean): Promise<void> => {
    if (!draft) return
    const parsed = parseCustomApiPaste(pasteText)
    setPasteNote(parsed.note)
    const current = pasteTargetId === 'new' ? undefined : draft.upstreams.find((entry) => entry.id === pasteTargetId)
    if (!parsed.baseUrl && !current) {
      setNotice({ kind: 'error', text: '未识别到 API 地址，无法创建新上游。' })
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
        models: [],
        priority: draft.upstreams.length + 1,
        enabled: true,
        hasApiKey: Boolean(parsed.apiKey),
        keyPreview: parsed.apiKey ? '待保存的新密钥' : '',
        expanded: true
      }
      updateDraft((value) => ({ ...value, upstreams: [...value.upstreams, next] }))
      setPasteTargetId(next.id)
    }
    setPasteText('')
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

  const applyToCodex = async (): Promise<void> => {
    if (!codexKeyId || !codexModel) return
    if (dirty && !(await save())) return
    setAction('codex')
    setNotice(null)
    try {
      const result = await codexApi().applyLocalApiServerToCodex({ accessKeyId: codexKeyId, model: codexModel, restart: restartCodex })
      setNotice({ kind: result.ok ? 'ok' : 'error', text: result.message })
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
  const isBusy = action !== null
  const shortKeys = draft.accessKeys.filter((entry) =>
    entry.key ? entry.key.length < 20 : entry.isShort === true
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

        <section className="api-service-settings flex flex-wrap items-end gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3" aria-labelledby="service-settings-title">
          <div className="mr-auto min-w-[210px] self-center">
            <h2 id="service-settings-title" className="flex items-center gap-2 text-[13px] font-semibold"><Activity size={16} className="text-[var(--color-accent)]" />服务设置</h2>
            <p className="mt-1 max-w-[56ch] text-[11.5px] leading-4 text-[var(--color-text-muted)]">始终监听 127.0.0.1。端口被占用时明确失败，不会偷偷切换到其他端口。</p>
          </div>
          <Field label="监听端口" hint={state.status.running && draft.port !== state.status.port ? `当前 ${state.status.port}；保存成功后安全切换` : '1–65535，默认 8888'} className="w-[190px]">
            <Input aria-label="监听端口" type="number" min={1} max={65535} value={draft.port} onChange={(event) => updateDraft((current) => ({ ...current, port: Number(event.target.value) }))} />
          </Field>
          <Toggle checked={draft.autoStart} onChange={(autoStart) => updateDraft((current) => ({ ...current, autoStart }))} label="随应用自动启动" />
          <Button variant="default" onClick={() => void save()} disabled={!dirty || isBusy}>
            {action === 'save' ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}{dirty ? '保存并热更新' : '已保存'}
          </Button>
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
              ['access-keys', KeyRound, '访问密钥', draft.accessKeys.length],
              ['upstreams', Network, '第三方上游', draft.upstreams.length],
              ['credentials', ShieldCheck, '账号凭证源', draft.credentialSources.length],
              ['routes', Route, '公开模型路由', draft.routes.length]
            ] as const).map(([id, Icon, label, count]) => (
              <button
                type="button"
                key={id}
                onClick={() => setActiveSection(id)}
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
              上游 Key 仅经安全 IPC 交给主进程加密保存，不会在此页回显。
            </div>
          </nav>

          <div className="min-w-0">
            {activeSection === 'access-keys' ? (
              <section aria-labelledby="access-keys-title">
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
                  <div><h2 id="access-keys-title" className="text-[13px] font-semibold">项目访问密钥</h2><p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">用于客户端访问本地 API，不是第三方上游密钥。</p></div>
                  <div className="flex items-center gap-1.5">
                    <Button onClick={addManualAccessKey} disabled={isBusy}><Plus size={15} />手动添加</Button>
                    <Button variant="soft" onClick={() => void addAccessKey()} disabled={isBusy}>{action === 'generate-key' ? <LoaderCircle className="spin" size={15} /> : <WandSparkles size={15} />}生成安全密钥</Button>
                  </div>
                </header>
                {draft.accessKeys.length === 0 ? (
                  <EmptyState icon={KeyRound} title="还没有访问密钥" detail="创建一枚项目密钥后，Codex 或其他客户端才能访问本地 API 服务。" action={<div className="flex gap-1.5"><Button onClick={addManualAccessKey}><Plus size={15} />手动添加</Button><Button variant="default" onClick={() => void addAccessKey()}><WandSparkles size={15} />生成安全密钥</Button></div>} />
                ) : (
                  <div className="divide-y divide-[var(--color-border)]">
                    {draft.accessKeys.map((entry) => (
                      <article key={entry.id} className="grid gap-2.5 px-3 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Input aria-label="密钥名称" className="max-w-[260px] font-medium" value={entry.label} onChange={(event) => updateDraft((current) => ({ ...current, accessKeys: current.accessKeys.map((item) => item.id === entry.id ? { ...item, label: event.target.value } : item) }))} />
                          <Toggle checked={entry.enabled} onChange={(enabled) => updateDraft((current) => ({ ...current, accessKeys: current.accessKeys.map((item) => item.id === entry.id ? { ...item, enabled } : item) }))} label={entry.enabled ? '已启用' : '已禁用'} />
                          <div className="ml-auto flex items-center gap-1">
                            <Button size="sm" onClick={() => void regenerateKey(entry.id)} disabled={isBusy}>{action === `regenerate-${entry.id}` ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}重新生成</Button>
                            <Button size="icon" variant="danger" aria-label={`删除密钥 ${entry.label}`} title="删除密钥" onClick={() => updateDraft((current) => ({ ...current, accessKeys: current.accessKeys.filter((item) => item.id !== entry.id) }))}><Trash2 size={15} /></Button>
                          </div>
                        </div>
                        <div className="grid grid-cols-[minmax(210px,1fr)_minmax(220px,1.2fr)] gap-2.5">
                          <Field label="密钥值" hint={entry.key ? '保存前可复制；保存后仅显示脱敏摘要' : '已加密保存，无法从界面恢复明文'}>
                            <div className="flex gap-1">
                              <Input
                                aria-label={`${entry.label} 密钥值`}
                                type={entry.reveal ? 'text' : 'password'}
                                className="font-[var(--font-mono)]"
                                value={entry.key ?? entry.keyPreview}
                                placeholder="sk-cas-… 或手动输入"
                                onChange={(event) => updateDraft((current) => ({ ...current, accessKeys: current.accessKeys.map((item) => item.id === entry.id ? { ...item, key: event.target.value, keyPreview: event.target.value, reveal: true } : item) }))}
                              />
                              <Button size="icon" aria-label={`复制 ${entry.label}`} title="复制密钥" disabled={action === `copy-${entry.id}`} onClick={() => void copyAccessKey(entry)}>{action === `copy-${entry.id}` ? <LoaderCircle className="spin" size={14} /> : <Copy size={14} />}</Button>
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
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            ) : null}

            {activeSection === 'upstreams' ? (
              <section aria-labelledby="upstreams-title">
                <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
                  <div><h2 id="upstreams-title" className="text-[13px] font-semibold">第三方 API 上游</h2><p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">每条上游独立保存协议、模型和优先级。测试会自动尝试带 /v1 与不带 /v1。</p></div>
                  <div className="flex items-center gap-1.5">
                    <Button onClick={() => setPasteOpen((open) => !open)} aria-expanded={pasteOpen}><Clipboard size={15} />粘贴识别</Button>
                    <Button variant="soft" onClick={addUpstream}><Plus size={15} />添加上游</Button>
                  </div>
                </header>
                {pasteOpen ? (
                  <div className="api-upstream-paste grid grid-cols-[minmax(260px,1.5fr)_minmax(180px,.7fr)_auto] items-end gap-2.5 border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-3">
                    <Field label="粘贴 URL + Key、JSON、url= key= 或 Base64">
                      <textarea
                        aria-label="上游粘贴内容"
                        className={cn(textareaClass, 'min-h-16')}
                        value={pasteText}
                        placeholder={'https://api.example.com/v1\nsk-...'}
                        onChange={(event) => { setPasteText(event.target.value); setPasteNote('') }}
                      />
                    </Field>
                    <Field label="填入位置" hint={pasteNote || '原文不会写入日志'}>
                      <Select className="w-full" value={pasteTargetId} onChange={(event) => setPasteTargetId(event.target.value)}>
                        <option value="new">创建新上游</option>
                        {draft.upstreams.map((entry) => <option key={entry.id} value={entry.id}>更新 · {entry.name}</option>)}
                      </Select>
                    </Field>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button disabled={!pasteText.trim()} onClick={() => void applyUpstreamPaste(false)}>只识别填入</Button>
                      <Button variant="default" disabled={!pasteText.trim()} onClick={() => void applyUpstreamPaste(true)}><Activity size={14} />识别并测试</Button>
                    </div>
                  </div>
                ) : null}
                {draft.upstreams.length === 0 ? (
                  <EmptyState icon={Network} title="还没有第三方上游" detail="添加 OpenAI 兼容 API 后，公开模型路由才能将请求转发到真正的上游。" action={<Button variant="default" onClick={addUpstream}><Plus size={15} />添加第一条上游</Button>} />
                ) : (
                  <div className="divide-y divide-[var(--color-border)]">
                    {draft.upstreams.map((entry) => {
                      const probe = probes[entry.id]
                      return (
                        <article key={entry.id}>
                          <div className="flex min-h-12 flex-wrap items-center gap-2 px-3 py-2">
                            <button type="button" className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-md)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ui-focus)]" aria-expanded={entry.expanded} onClick={() => updateDraft((current) => ({ ...current, upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, expanded: !item.expanded } : item) }))}>
                              {entry.expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                              <span className={cn('h-2 w-2 shrink-0 rounded-full', entry.enabled ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-text-muted)]')} />
                              <span className="truncate text-[12.5px] font-semibold">{entry.name}</span>
                              <span className="truncate font-[var(--font-mono)] text-[10.5px] text-[var(--color-text-muted)]">{entry.baseUrl}</span>
                            </button>
                            {probe ? <span className={cn('inline-flex items-center gap-1 text-[11px]', probe.loading ? 'text-[var(--color-info)]' : probe.ok ? 'text-[var(--color-accent)]' : 'text-[var(--color-danger)]')}>{probe.loading ? <LoaderCircle className="spin" size={13} /> : probe.ok ? <Check size={13} /> : <CircleAlert size={13} />}{probe.loading ? '测试中' : `${probe.ok ? '可用' : '失败'} · ${probe.latencyMs ?? 0} ms`}</span> : <span className="text-[11px] text-[var(--color-text-muted)]">未测试</span>}
                            <Toggle checked={entry.enabled} onChange={(enabled) => updateDraft((current) => ({ ...current, upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, enabled } : item) }))} label={entry.enabled ? '启用' : '停用'} />
                            <Button size="sm" onClick={() => void testUpstream(entry)} disabled={probe?.loading}>{probe?.loading ? <LoaderCircle className="spin" size={14} /> : <Activity size={14} />}测试并获取模型</Button>
                            <Button size="icon" variant="danger" aria-label={`删除上游 ${entry.name}`} onClick={() => updateDraft((current) => ({ ...current, upstreams: current.upstreams.filter((item) => item.id !== entry.id), routes: current.routes.map((route) => ({ ...route, targets: route.targets.filter((target) => target.sourceId !== entry.id) })) }))}><Trash2 size={15} /></Button>
                          </div>
                          {entry.expanded ? (
                            <div className="grid grid-cols-2 gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-3">
                              <Field label="名称"><Input value={entry.name} onChange={(event) => updateDraft((current) => ({ ...current, upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, name: event.target.value } : item) }))} /></Field>
                              <Field label="API Base URL" hint="可填写到域名或 /v1"><Input className="font-[var(--font-mono)]" value={entry.baseUrl} onChange={(event) => updateDraft((current) => ({ ...current, upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, baseUrl: event.target.value } : item) }))} /></Field>
                              <Field label="上游 API Key" hint={entry.hasApiKey && !entry.apiKey ? `已安全保存：${entry.keyPreview}` : '留空不会覆盖已保存密钥'}>
                                <Input type="password" value={entry.apiKey ?? ''} placeholder={entry.hasApiKey ? entry.keyPreview : 'sk-…'} autoComplete="off" onChange={(event) => updateDraft((current) => ({ ...current, upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, apiKey: event.target.value || undefined } : item) }))} />
                              </Field>
                              <div className="grid grid-cols-[1fr_120px] gap-3">
                                <Field label="协议能力"><Select className="w-full" value={entry.protocol} onChange={(event) => updateDraft((current) => ({ ...current, upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, protocol: event.target.value as ApiUpstreamProtocol } : item) }))}><option value="auto">自动识别</option><option value="responses">Responses</option><option value="chat_completions">Chat Completions</option></Select></Field>
                                <Field label="优先级"><Input type="number" value={entry.priority} onChange={(event) => updateDraft((current) => ({ ...current, upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, priority: Number(event.target.value) } : item) }))} /></Field>
                              </div>
                              <Field label={`模型列表 · ${entry.models.length}`} hint="测试成功后自动填充，也可手动编辑" className="col-span-2">
                                <textarea className={textareaClass} value={entry.models.join('\n')} placeholder="gpt-5.4\nmy-model" onChange={(event) => updateDraft((current) => ({ ...current, upstreams: current.upstreams.map((item) => item.id === entry.id ? { ...item, models: parseModelList(event.target.value) } : item) }))} />
                              </Field>
                              {probe?.message ? <p className={cn('col-span-2 text-[11px]', probe.ok ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-danger)]')}>{probe.message}</p> : null}
                            </div>
                          ) : null}
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
                    <h2 id="credential-sources-title" className="text-[13px] font-semibold">账号凭证上游</h2>
                    <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">来自 Codex、Grok 与 CPA 账号库的安全引用；Token 不会进入 Renderer 或 API 服务配置。</p>
                  </div>
                  <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--color-accent-soft)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-accent)]"><ShieldCheck size={13} />已隔离秘密</span>
                </header>
                {draft.credentialSources.length === 0 ? (
                  <EmptyState icon={ShieldCheck} title="账号库中没有可用凭证" detail="先在 Codex、Grok 或 CPA 账号页导入凭证，再回到此处启用它作为 API 服务上游。" action={<Button onClick={() => void load()}><RefreshCw size={14} />刷新凭证源</Button>} />
                ) : (
                  <div className="divide-y divide-[var(--color-border)]">
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
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-text-muted)]" title={source.models.join(', ')}>{source.models.length > 0 ? `${source.models.length} 个模型 · ${source.models.slice(0, 3).join(', ')}` : '未声明模型，路由时手动填写'}</span>
                            <Toggle checked={source.enabled} onChange={(enabled) => updateDraft((current) => ({ ...current, credentialSources: current.credentialSources.map((entry) => entry.id === source.id ? { ...entry, enabled } : entry) }))} label={source.enabled ? '已加入 API 池' : '仅账号切换'} />
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
                  <div><h2 id="routes-title" className="text-[13px] font-semibold">公开模型与路由</h2><p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">客户端只看到公开模型名；每个目标映射到真实的上游模型。</p></div>
                  <Button variant="soft" onClick={addRoute}><Plus size={15} />添加公开模型</Button>
                </header>
                {draft.routes.length === 0 ? (
                  <EmptyState icon={Route} title="还没有公开模型" detail="创建公开模型后，/v1/models 与 Codex 模型目录才会显示它。没有路由的模型会返回 model_not_found。" action={<Button variant="default" onClick={addRoute}><Plus size={15} />添加第一个模型</Button>} />
                ) : (
                  <div className="divide-y divide-[var(--color-border)]">
                    {draft.routes.map((route, routeIndex) => (
                      <article key={`${route.publicModel}-${routeIndex}`} className="grid gap-3 px-3 py-3">
                        <div className="api-route-config grid grid-cols-[minmax(180px,1.2fr)_minmax(140px,.8fr)_minmax(150px,.8fr)_32px] items-end gap-2.5">
                          <Field label="公开模型名"><Input className="font-[var(--font-mono)] font-semibold" value={route.publicModel} onChange={(event) => updateRoute(routeIndex, { publicModel: event.target.value })} /></Field>
                          <Field label="路由策略"><Select className="w-full" value={route.strategy} onChange={(event) => updateRoute(routeIndex, { strategy: event.target.value as ModelRouteStrategy })}><option value="single">固定单一来源</option><option value="priority">优先级故障转移</option><option value="round_robin">轮询</option></Select></Field>
                          <Field label="来源范围"><Select className="w-full" value={route.sourceMode} onChange={(event) => {
                            const sourceMode = event.target.value as ModelRouteSourceMode
                            const apiIds = new Set(draft.upstreams.map((entry) => entry.id))
                            const credentialIds = new Set(draft.credentialSources.map((entry) => entry.id))
                            updateRoute(routeIndex, {
                              sourceMode,
                              targets: route.targets.filter((target) => sourceMode === 'api_only'
                                ? apiIds.has(target.sourceId)
                                : sourceMode === 'credential_only'
                                  ? credentialIds.has(target.sourceId)
                                  : apiIds.has(target.sourceId) || credentialIds.has(target.sourceId))
                            })
                          }}><option value="api_only">仅第三方 API</option><option value="credential_only">仅账号凭证</option><option value="mixed">API + 凭证混合</option></Select></Field>
                          <Button variant="danger" size="icon" aria-label={`删除公开模型 ${route.publicModel}`} onClick={() => updateDraft((current) => ({ ...current, routes: current.routes.filter((_, index) => index !== routeIndex) }))}><Trash2 size={15} /></Button>
                        </div>
                        <div className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]">
                          <div className="api-route-heading grid grid-cols-[minmax(140px,1fr)_minmax(150px,1fr)_90px_72px_32px] gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1.5 text-[10.5px] font-medium text-[var(--color-text-muted)]"><span>来源</span><span>上游模型</span><span>优先级</span><span>状态</span><span /></div>
                          {route.targets.map((target, targetIndex) => (
                            <div key={`${target.sourceId}-${targetIndex}`} className="api-route-target grid grid-cols-[minmax(140px,1fr)_minmax(150px,1fr)_90px_72px_32px] items-center gap-2 border-b border-[var(--color-border)] px-2 py-2 last:border-b-0">
                              <Select aria-label={`${route.publicModel} 路由来源`} className="w-full" value={target.sourceId} onChange={(event) => {
                                const source = routeSources(route).find((entry) => entry.id === event.target.value)
                                updateTarget(routeIndex, targetIndex, { sourceId: event.target.value, upstreamModel: source?.models[0] ?? target.upstreamModel })
                              }}>{routeSources(route).map((source) => <option key={source.id} value={source.id}>{source.kind === 'credential' ? '凭证 · ' : 'API · '}{source.label}</option>)}</Select>
                              <Input aria-label={`${route.publicModel} 上游模型`} className="font-[var(--font-mono)]" list={`models-${routeIndex}-${targetIndex}`} value={target.upstreamModel} onChange={(event) => updateTarget(routeIndex, targetIndex, { upstreamModel: event.target.value })} />
                              <datalist id={`models-${routeIndex}-${targetIndex}`}>{routeSources(route).find((entry) => entry.id === target.sourceId)?.models.map((model) => <option value={model} key={model} />)}</datalist>
                              <Input aria-label={`${route.publicModel} 目标优先级`} type="number" value={target.priority} onChange={(event) => updateTarget(routeIndex, targetIndex, { priority: Number(event.target.value) })} />
                              <Toggle checked={target.enabled} onChange={(enabled) => updateTarget(routeIndex, targetIndex, { enabled })} label={target.enabled ? '启用' : '停用'} />
                              <Button size="icon" variant="ghost" aria-label="删除路由目标" onClick={() => updateRoute(routeIndex, { targets: route.targets.filter((_, index) => index !== targetIndex) })}><Trash2 size={14} /></Button>
                            </div>
                          ))}
                          <button
                            type="button"
                            disabled={routeSources(route).length === 0}
                            className="flex min-h-8 w-full items-center justify-center gap-1.5 text-[11.5px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ui-focus)] disabled:cursor-not-allowed disabled:text-[var(--color-text-muted)]"
                            onClick={() => {
                              const sources = routeSources(route)
                              const source = sources.find((entry) => !route.targets.some((target) => target.sourceId === entry.id)) ?? sources[0]
                              if (!source) return
                              updateRoute(routeIndex, { targets: [...route.targets, { sourceId: source.id, upstreamModel: source.models[0] ?? route.publicModel, priority: route.targets.length + 1, enabled: true }] })
                            }}
                          ><Plus size={13} />添加目标</button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            ) : null}
          </div>
        </div>

        <section className="api-codex-panel grid grid-cols-[minmax(240px,1.2fr)_minmax(150px,.8fr)_minmax(180px,1fr)_auto_auto] items-end gap-3 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3" aria-labelledby="codex-api-title">
          <div className="self-center">
            <h2 id="codex-api-title" className="flex items-center gap-2 text-[13px] font-semibold"><Clipboard size={16} className="text-[var(--color-accent)]" />一键设置 Codex</h2>
            <p className="mt-1 max-w-[60ch] text-[11.5px] leading-4 text-[var(--color-text-muted)]">Codex 只保存本地地址与专用项目密钥。切换上游或路由时地址保持不变。</p>
          </div>
          <Field label="Codex 专用密钥"><Select className="w-full" value={codexKeyId} onChange={(event) => { setCodexKeyId(event.target.value); setCodexModel('') }}><option value="">选择已启用密钥</option>{draft.accessKeys.filter((entry) => entry.enabled).map((entry) => <option value={entry.id} key={entry.id}>{entry.label}</option>)}</Select></Field>
          <Field label="默认公开模型"><Select className="w-full" value={codexModel} onChange={(event) => setCodexModel(event.target.value)}><option value="">选择模型</option>{codexModels.map((model) => <option key={model} value={model}>{model}</option>)}</Select></Field>
          <Toggle checked={restartCodex} onChange={setRestartCodex} label="重启并修复会话" />
          <Button variant="default" size="lg" disabled={isBusy || !codexKeyId || !codexModel} onClick={() => void applyToCodex()}>{action === 'codex' ? <LoaderCircle className="spin" size={15} /> : <ClipboardPasteIcon />}应用到 Codex</Button>
        </section>
      </div>
    </PageView>
  )
}

function ClipboardPasteIcon(): React.JSX.Element {
  return <Clipboard size={15} aria-hidden="true" />
}
