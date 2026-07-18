import {
  CheckSquare2,
  FolderOpen,
  LoaderCircle,
  MessagesSquare,
  RefreshCw,
  Search,
  Square,
  Wrench,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type {
  ConversationDetail,
  ConversationListResult,
  ConversationSummary
} from '../../../shared/types'
import { useDialogFocus } from '../hooks/useDialogFocus'

interface Props {
  onClose: () => void
  onSync: (threadIds?: string[]) => void
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

export function ConversationManagerDialog({ onClose, onSync }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<ConversationListResult | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<ConversationDetail | null>(null)
  const [loadingList, setLoadingList] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestVersion = useRef(0)
  const detailRequestVersion = useRef(0)
  const dialogRef = useDialogFocus<HTMLElement>(true, onClose)

  const load = async (force = false, append = false): Promise<void> => {
    const version = ++requestVersion.current
    setLoadingList(true)
    setError(null)
    try {
      const offset = append ? result?.items.length ?? 0 : 0
      const next = await window.codexSwitcher.listConversations(query, offset, 200, force)
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
    const timer = window.setTimeout(() => void load(false, false), 220)
    return () => window.clearTimeout(timer)
  // `result` is intentionally excluded so pagination does not restart the search.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  const openDetail = async (conversation: ConversationSummary): Promise<void> => {
    const version = ++detailRequestVersion.current
    setLoadingDetail(true)
    setError(null)
    try {
      const next = await window.codexSwitcher.getConversation(conversation.id)
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

  return (
    <div className="repair-backdrop" role="presentation">
      <section ref={dialogRef} className="conversation-dialog" role="dialog" aria-modal="true" aria-labelledby="conversation-title" tabIndex={-1}>
        <header className="panel-header">
          <div>
            <h2 id="conversation-title">Codex 对话管理</h2>
            <span>{result ? `${result.total} 个对话` : '正在读取对话索引'}</span>
          </div>
          <button className="icon-button" title="关闭" aria-label="关闭对话管理" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="conversation-toolbar">
          <label className="search-field">
            <Search size={16} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题、工作区或供应商" />
          </label>
          <button title="重新扫描" aria-label="重新扫描对话" onClick={() => void load(true, false)} disabled={loadingList}>
            {loadingList ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}
          </button>
          <span className="conversation-selection">已选 {selected.size}</span>
          <button onClick={() => onSync([...selected])} disabled={selected.size === 0}>
            <Wrench size={16} />同步选中
          </button>
          <button className="primary-button" onClick={() => onSync()}>
            <Wrench size={16} />同步全部
          </button>
        </div>

        {error && <div className="conversation-error">{error}</div>}
        <div className="conversation-layout">
          <aside className="conversation-list" aria-label="Codex 对话列表">
            {result?.items.map((conversation) => (
              <div
                key={`${conversation.id}:${conversation.sourcePath}`}
                className={`conversation-row${selected.has(conversation.id) ? ' selected' : ''}${detail?.conversation.id === conversation.id ? ' active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => void openDetail(conversation)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') void openDetail(conversation)
                }}
              >
                <button
                  className="conversation-check"
                  aria-label={`${selected.has(conversation.id) ? '取消选择' : '选择'} ${conversation.title}`}
                  onClick={(event) => { event.stopPropagation(); toggle(conversation.id) }}
                >
                  {selected.has(conversation.id) ? <CheckSquare2 size={17} /> : <Square size={17} />}
                </button>
                <div className="conversation-row-main">
                  <strong>{conversation.title}</strong>
                  <span>{conversation.cwd ?? '无工作区'} · {conversation.provider}</span>
                  <small>{dateTime(conversation.updatedAt)} · {fileSize(conversation.sizeBytes)}{conversation.archived ? ' · 已归档' : ''}</small>
                </div>
              </div>
            ))}
            {!loadingList && result?.items.length === 0 && (
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
                  <div><strong>{detail.conversation.title}</strong><span>{detail.totalMessages} 条消息</span></div>
                  <button title="打开文件位置" aria-label="打开对话文件位置" onClick={() => void window.codexSwitcher.revealConversation(detail.conversation.id)}>
                    <FolderOpen size={16} />
                  </button>
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
