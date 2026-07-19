import {
  Bot,
  CheckCircle2,
  CheckSquare2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CornerUpLeft,
  FilterX,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  MessagesSquare,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  Trash2,
  UserRound,
  Wrench,
  X
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ConversationDetail,
  ConversationKind,
  ConversationLifecycleStatus,
  ConversationListResult,
  ConversationSearchScope,
  ConversationSubagentKind,
  ConversationSummary,
  DeleteConversationsResult
} from '../../../shared/types'
import { useDialogFocus } from '../hooks/useDialogFocus'
import type { RequestConfirmation } from '../hooks/useConfirmation'

interface Props {
  onClose: () => void
  onSync: (threadIds?: string[]) => void
  requestConfirmation: RequestConfirmation
}

function dateTime(value: string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function fileSize(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function kindLabel(value: ConversationKind): string {
  if (value === 'main') return '主对话'
  if (value === 'subagent') return '子代理'
  if (value === 'internal') return '内部任务'
  return '未知来源'
}

function subagentLabel(value: ConversationSubagentKind): string {
  if (value === 'thread_spawn') return '派生代理'
  if (value === 'review') return '代码审查'
  if (value === 'compact') return '上下文压缩'
  if (value === 'memory_consolidation') return '记忆整理'
  return '其他代理'
}

function lifecycleLabel(value: ConversationLifecycleStatus): string {
  if (value === 'open') return '可恢复'
  if (value === 'closed') return '已关闭'
  return '状态未知'
}

export function ConversationManagerDialog({ onClose, onSync, requestConfirmation }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [searchScope, setSearchScope] = useState<ConversationSearchScope>('metadata')
  const [kind, setKind] = useState('all')
  const [subagentKind, setSubagentKind] = useState('all')
  const [lifecycleStatus, setLifecycleStatus] = useState('all')
  const [archive, setArchive] = useState('all')
  const [provider, setProvider] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [updatedWithinDays, setUpdatedWithinDays] = useState('')
  const [sort, setSort] = useState<'updated' | 'hierarchy'>('updated')
  const [result, setResult] = useState<ConversationListResult | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [loadingList, setLoadingList] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [cleaning, setCleaning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null)
  const requestVersion = useRef(0)
  const detailRequestVersion = useRef(0)
  const busy = deleting || cleaning
  const closeDialog = (): void => {
    if (!busy) onClose()
  }
  const dialogRef = useDialogFocus<HTMLElement>(true, closeDialog)

  const load = async (force = false, append = false): Promise<void> => {
    const version = ++requestVersion.current
    setLoadingList(true)
    setError(null)
    try {
      const offset = append ? result?.items.length ?? 0 : 0
      const next = await window.codexSwitcher.listConversations({
        query,
        searchScope: searchScope === 'content' && query.trim().length >= 2 ? 'content' : 'metadata',
        kind: kind as 'all' | ConversationKind,
        subagentKind: subagentKind as 'all' | Exclude<ConversationSubagentKind, null>,
        lifecycleStatus: lifecycleStatus as 'all' | ConversationLifecycleStatus,
        archive: archive as 'all' | 'active' | 'archived',
        provider: provider || undefined,
        workspace: workspace || undefined,
        updatedWithinDays: updatedWithinDays ? Number(updatedWithinDays) : null,
        sort,
        offset,
        limit: 200,
        force
      })
      if (version !== requestVersion.current) return
      setResult((current) => append && current
        ? { ...next, items: [...current.items, ...next.items] }
        : next)
    } catch (reason) {
      if (version === requestVersion.current) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (version === requestVersion.current) setLoadingList(false)
    }
  }

  useEffect(() => {
    const delay = searchScope === 'content' ? 500 : 220
    const timer = window.setTimeout(() => void load(false, false), delay)
    return () => window.clearTimeout(timer)
  // `result` is intentionally excluded so pagination does not restart the search.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, searchScope, kind, subagentKind, lifecycleStatus, archive, provider, workspace, updatedWithinDays, sort])

  useEffect(() => {
    if (!result) return
    if (kind !== 'all' && !result.facets.kinds.some((option) => option.value === kind)) setKind('all')
    if (subagentKind !== 'all' && !result.facets.subagentKinds.some((option) => option.value === subagentKind)) {
      setSubagentKind('all')
    }
    if (lifecycleStatus !== 'all' && !result.facets.lifecycleStatuses.some((option) => option.value === lifecycleStatus)) {
      setLifecycleStatus('all')
    }
    if (archive !== 'all' && !result.facets.archives.some((option) => option.value === archive)) setArchive('all')
    if (provider && !result.facets.providers.some((option) => option.value === provider)) setProvider('')
    if (workspace && !result.facets.workspaces.some((option) => option.value === workspace)) setWorkspace('')
  }, [archive, kind, lifecycleStatus, provider, result, subagentKind, workspace])

  const openById = async (id: string): Promise<void> => {
    const version = ++detailRequestVersion.current
    setLoadingDetail(true)
    setError(null)
    try {
      const next = await window.codexSwitcher.getConversation(id)
      if (version === detailRequestVersion.current) setDetail(next)
    } catch (reason) {
      if (version === detailRequestVersion.current) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (version === detailRequestVersion.current) setLoadingDetail(false)
    }
  }

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleParent = (id: string): void => {
    setCollapsedParents((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const applyDeletion = async (outcome: DeleteConversationsResult): Promise<void> => {
    const deleted = new Set(outcome.deletedIds)
    setSelected((current) => new Set([...current].filter((id) => !deleted.has(id))))
    if (detail && deleted.has(detail.conversation.id)) {
      detailRequestVersion.current += 1
      setDetail(null)
    }
    await load(true, false)
    setNotice({
      kind: outcome.failed > 0 || outcome.errors.length > 0 ? 'warn' : 'ok',
      text: outcome.errors.length > 0
        ? `${outcome.message} 首项：${outcome.errors[0]}`
        : outcome.message
    })
  }

  const deleteConversations = async (ids: string[]): Promise<void> => {
    const uniqueIds = [...new Set(ids)]
    if (uniqueIds.length === 0) return
    const confirmed = await requestConfirmation({
      title: `删除 ${uniqueIds.length} 个 Codex 对话`,
      message: '对话文件会移入 Windows 回收站，同时清理 Codex 本地索引。',
      detail: '工作区和项目文件不会被删除；仍在回收站中的对话文件可以手动还原。',
      confirmLabel: '删除对话',
      tone: 'danger'
    })
    if (!confirmed) return

    setDeleting(true)
    setError(null)
    setNotice(null)
    try {
      await applyDeletion(await window.codexSwitcher.deleteConversations(uniqueIds))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDeleting(false)
    }
  }

  const cleanupSafeConversations = async (): Promise<void> => {
    setCleaning(true)
    setError(null)
    setNotice(null)
    try {
      const preview = await window.codexSwitcher.previewSafeConversationCleanup()
      if (preview.count === 0) {
        setNotice({ kind: 'ok', text: '没有符合保守清理条件的已关闭子代理对话。' })
        return
      }
      const confirmed = await requestConfirmation({
        title: `保守清理 ${preview.count} 个子代理对话`,
        message: `共 ${fileSize(preview.sizeBytes)}，只包含 Codex 标记为 closed、超过 ${preview.graceMinutes} 分钟未写入且没有开放子任务的派生代理。`,
        detail: '主对话、可恢复代理和状态不明确的对话不会处理。文件会进入 Windows 回收站。',
        confirmLabel: '开始清理',
        tone: 'warning'
      })
      if (!confirmed) return
      await applyDeletion(await window.codexSwitcher.cleanupSafeConversations())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCleaning(false)
    }
  }

  const activeFilterCount = [kind, subagentKind, lifecycleStatus, archive]
    .filter((value) => value !== 'all').length +
    [provider, workspace, updatedWithinDays].filter(Boolean).length +
    (sort === 'hierarchy' ? 1 : 0)

  const clearFilters = (): void => {
    setKind('all')
    setSubagentKind('all')
    setLifecycleStatus('all')
    setArchive('all')
    setProvider('')
    setWorkspace('')
    setUpdatedWithinDays('')
    setSort('updated')
    setCollapsedParents(new Set())
  }

  const visibleItems = useMemo(() => {
    if (!result || sort !== 'hierarchy') return result?.items ?? []
    return result.items.filter((item) => !item.parentId || !collapsedParents.has(item.parentId))
  }, [collapsedParents, result, sort])
  const pageIds = result?.items.map((item) => item.id) ?? []
  const pageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id))

  const togglePage = (): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (pageSelected) pageIds.forEach((id) => next.delete(id))
      else pageIds.forEach((id) => next.add(id))
      return next
    })
  }

  return (
    <div className="repair-backdrop" role="presentation">
      <section ref={dialogRef} className="conversation-dialog" role="dialog" aria-modal="true" aria-labelledby="conversation-title" tabIndex={-1}>
        <header className="panel-header">
          <div>
            <h2 id="conversation-title">Codex 对话管理</h2>
            <span>{result ? `${result.total} 个结果 / ${result.allTotal} 个对话` : '正在读取对话索引'}</span>
          </div>
          <button className="icon-button" title="关闭" aria-label="关闭对话管理" onClick={closeDialog} disabled={busy}>
            <X size={18} />
          </button>
        </header>

        <div className="conversation-controls">
          <div className="conversation-search-row">
            <label className="search-field">
              <Search size={16} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、任务 ID、工作区、代理或正文" />
            </label>
            <select aria-label="搜索范围" value={searchScope} onChange={(event) => setSearchScope(event.target.value as ConversationSearchScope)}>
              <option value="metadata">资料</option>
              <option value="content">正文</option>
            </select>
            <button title="重新扫描" aria-label="重新扫描对话" onClick={() => void load(true, false)} disabled={loadingList || busy}>
              {loadingList ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
            </button>
            <button className="safe-cleanup-button" onClick={() => void cleanupSafeConversations()} disabled={busy || loadingList}>
              {cleaning ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}
              {cleaning ? '正在清理' : `保守清理 ${result?.safeCleanupCount ?? 0}`}
            </button>
          </div>

          <div className="conversation-filter-row">
            <select aria-label="对话来源" value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="all">全部来源</option>
              {result?.facets.kinds.map((option) => <option key={option.value} value={option.value}>{option.label} ({option.count})</option>)}
            </select>
            <select aria-label="子代理类型" value={subagentKind} onChange={(event) => setSubagentKind(event.target.value)}>
              <option value="all">全部代理类型</option>
              {result?.facets.subagentKinds.map((option) => <option key={option.value} value={option.value}>{option.label} ({option.count})</option>)}
            </select>
            <select aria-label="代理状态" value={lifecycleStatus} onChange={(event) => setLifecycleStatus(event.target.value)}>
              <option value="all">全部代理状态</option>
              {result?.facets.lifecycleStatuses.map((option) => <option key={option.value} value={option.value}>{option.label} ({option.count})</option>)}
            </select>
            <select aria-label="归档状态" value={archive} onChange={(event) => setArchive(event.target.value)}>
              <option value="all">全部归档状态</option>
              {result?.facets.archives.map((option) => <option key={option.value} value={option.value}>{option.label} ({option.count})</option>)}
            </select>
            <select aria-label="对话供应商" value={provider} onChange={(event) => setProvider(event.target.value)}>
              <option value="">全部供应商</option>
              {result?.facets.providers.map((option) => <option key={option.value} value={option.value}>{option.label} ({option.count})</option>)}
            </select>
            <select aria-label="对话工作区" value={workspace} onChange={(event) => setWorkspace(event.target.value)}>
              <option value="">全部工作区</option>
              {result?.facets.workspaces.map((option) => <option key={option.value} value={option.value}>{option.label} ({option.count})</option>)}
            </select>
            <select aria-label="更新时间" value={updatedWithinDays} onChange={(event) => setUpdatedWithinDays(event.target.value)}>
              <option value="">全部时间</option>
              <option value="1">最近 1 天</option>
              <option value="7">最近 7 天</option>
              <option value="30">最近 30 天</option>
              <option value="90">最近 90 天</option>
            </select>
            <select aria-label="对话排序" value={sort} onChange={(event) => setSort(event.target.value as 'updated' | 'hierarchy')}>
              <option value="updated">按更新时间</option>
              <option value="hierarchy">按父任务分组</option>
            </select>
            <button title="清除筛选" aria-label="清除对话筛选" onClick={clearFilters} disabled={activeFilterCount === 0}>
              <FilterX size={16} />
            </button>
          </div>

          <div className="conversation-action-row">
            <button onClick={togglePage} disabled={pageIds.length === 0 || busy}>
              {pageSelected ? <CheckSquare2 size={16} /> : <Square size={16} />}
              {pageSelected ? '取消本页' : '选择本页'}
            </button>
            <span className="conversation-selection">已选 {selected.size}</span>
            <button onClick={() => onSync([...selected])} disabled={selected.size === 0 || busy}>
              <Wrench size={16} />同步选中
            </button>
            <button className="danger-button" onClick={() => void deleteConversations([...selected])} disabled={selected.size === 0 || busy}>
              {deleting ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
              {deleting ? '正在删除' : '删除选中'}
            </button>
            <span className="conversation-action-spacer" />
            <button className="primary-button" onClick={() => onSync()} disabled={busy}>
              <Wrench size={16} />同步全部
            </button>
          </div>
        </div>

        {searchScope === 'content' && query.trim().length === 1 && (
          <div className="conversation-warning">正文搜索至少输入 2 个字符，当前暂按标题和资料搜索。</div>
        )}
        {notice && (
          <div className={`conversation-notice ${notice.kind}`}>
            {notice.kind === 'ok' ? <CheckCircle2 size={15} /> : <CircleAlert size={15} />}
            <span>{notice.text}</span>
          </div>
        )}
        {error && <div className="conversation-error"><CircleAlert size={15} /><span>{error}</span></div>}
        <div className="conversation-layout">
          <aside className="conversation-list" aria-label="Codex 对话列表">
            {visibleItems.map((conversation) => (
              <div
                key={`${conversation.id}:${conversation.sourcePath}`}
                className={`conversation-row ${conversation.kind}-row${selected.has(conversation.id) ? ' selected' : ''}${detail?.conversation.id === conversation.id ? ' active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => void openById(conversation.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') void openById(conversation.id)
                }}
              >
                <button
                  className="conversation-check"
                  aria-label={`${selected.has(conversation.id) ? '取消选择' : '选择'} ${conversation.title}`}
                  disabled={busy}
                  onClick={(event) => { event.stopPropagation(); toggle(conversation.id) }}
                >
                  {selected.has(conversation.id) ? <CheckSquare2 size={17} /> : <Square size={17} />}
                </button>
                <div className="conversation-row-main">
                  <div className="conversation-title-line">
                    {conversation.kind === 'subagent' ? <GitBranch size={14} /> : <UserRound size={14} />}
                    <strong>{conversation.title}</strong>
                    <em className={`conversation-kind-badge ${conversation.kind}`}>{kindLabel(conversation.kind)}</em>
                    {conversation.kind === 'subagent' && (
                      <em className={`conversation-state-badge ${conversation.lifecycleStatus}`}>{lifecycleLabel(conversation.lifecycleStatus)}</em>
                    )}
                    {conversation.safeToClean && <ShieldCheck className="safe-cleanup-mark" size={14} aria-label="可保守清理" />}
                    {conversation.childCount > 0 && sort === 'hierarchy' && (
                      <button
                        className="conversation-collapse"
                        title={collapsedParents.has(conversation.id) ? '展开子代理' : '收起子代理'}
                        aria-label={collapsedParents.has(conversation.id) ? '展开子代理' : '收起子代理'}
                        onClick={(event) => { event.stopPropagation(); toggleParent(conversation.id) }}
                      >
                        {collapsedParents.has(conversation.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                        {conversation.childCount}
                      </button>
                    )}
                  </div>
                  {conversation.kind === 'subagent' && (
                    <span className="conversation-agent-line">
                      <Bot size={12} />
                      {conversation.agentNickname ?? subagentLabel(conversation.subagentKind)}
                      {conversation.agentRole ? ` · ${conversation.agentRole}` : ''}
                      {conversation.depth !== null ? ` · 第 ${conversation.depth} 层` : ''}
                    </span>
                  )}
                  {conversation.parentId && (
                    <button
                      className="conversation-parent-link"
                      title="查看父任务"
                      onClick={(event) => { event.stopPropagation(); void openById(conversation.parentId!) }}
                    >
                      <CornerUpLeft size={12} />{conversation.parentTitle ?? `父任务 ${conversation.parentId.slice(0, 8)}`}
                    </button>
                  )}
                  <span>{conversation.cwd ?? '无工作区'} · {conversation.provider}</span>
                  <small>{dateTime(conversation.updatedAt)} · {fileSize(conversation.sizeBytes)}{conversation.archived ? ' · 已归档' : ''}</small>
                  {conversation.matchExcerpt && <p className="conversation-match-excerpt">{conversation.matchExcerpt}</p>}
                </div>
              </div>
            ))}
            {!loadingList && visibleItems.length === 0 && (
              <div className="conversation-empty">没有匹配的对话</div>
            )}
            {result?.hasMore && (
              <button className="conversation-more" onClick={() => void load(false, true)} disabled={loadingList}>
                加载更多
              </button>
            )}
          </aside>

          <section className="conversation-detail" aria-label="对话内容">
            {loadingDetail ? (
              <div className="conversation-empty"><LoaderCircle className="spin" size={20} />正在读取对话</div>
            ) : detail ? (
              <>
                <div className="conversation-detail-header">
                  <div>
                    <strong>{detail.conversation.title}</strong>
                    <span>
                      {detail.totalMessages} 条消息 · {kindLabel(detail.conversation.kind)}
                      {detail.conversation.agentNickname ? ` · ${detail.conversation.agentNickname}` : ''}
                    </span>
                  </div>
                  <div className="conversation-detail-actions">
                    {detail.conversation.parentId && (
                      <button title="查看父任务" aria-label="查看父任务" disabled={busy} onClick={() => void openById(detail.conversation.parentId!)}>
                        <CornerUpLeft size={16} />
                      </button>
                    )}
                    <button title="打开文件位置" aria-label="打开对话文件位置" disabled={busy} onClick={() => void window.codexSwitcher.revealConversation(detail.conversation.id)}>
                      <FolderOpen size={16} />
                    </button>
                    <button className="danger-button" title="删除当前对话" aria-label="删除当前对话" disabled={busy} onClick={() => void deleteConversations([detail.conversation.id])}>
                      {deleting ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
                    </button>
                  </div>
                </div>
                {detail.truncated && <div className="conversation-warning">对话较大，仅显示前 {detail.messages.length} 条和限定长度的正文。</div>}
                <div className="conversation-messages">
                  {detail.messages.map((message) => (
                    <article key={message.id} className={`conversation-message ${message.role}`}>
                      <header><span>{message.role === 'user' ? '用户' : 'Codex'}</span><time>{dateTime(message.timestamp)}</time></header>
                      <pre>{message.text}</pre>
                    </article>
                  ))}
                  {detail.messages.length === 0 && <div className="conversation-empty">没有可显示的用户或 Codex 消息</div>}
                </div>
              </>
            ) : (
              <div className="conversation-empty"><MessagesSquare size={24} />选择一个对话查看内容</div>
            )}
          </section>
        </div>
      </section>
    </div>
  )
}
