import {
  ClipboardPaste,
  Code2,
  FolderInput,
  Import,
  KeyRound,
  LoaderCircle,
  X,
  Zap
} from 'lucide-react'
import type { RefObject } from 'react'
import {
  Button,
  DialogActions,
  DialogBackdrop,
  DialogHeader,
  DialogPanel,
  SegmentedButton,
  SegmentedControl
} from '@/components/ui'

export type PasteImportMode = 'auto' | 'oauth' | 'codex' | 'mobile'

export function ImportSourceDialog(props: {
  dialogRef: RefObject<HTMLElement | null>
  busy: boolean
  pasteImportMode: PasteImportMode
  setPasteImportMode: (mode: PasteImportMode) => void
  pasteText: string
  setPasteText: (value: string) => void
  oauthSession: unknown
  onClose: () => void
  onImportFiles: () => void
  onImportDirectory: () => void
  onStartOAuth: () => void
  onSubmitPaste: () => void
}): React.JSX.Element {
  const {
    dialogRef, busy, pasteImportMode, setPasteImportMode, pasteText, setPasteText,
    oauthSession, onClose, onImportFiles, onImportDirectory, onStartOAuth, onSubmitPaste
  } = props

  const modeHint =
    pasteImportMode === 'auto'
      ? '同时识别 Codex 与 Grok 的 JSON、JSONL、CPA、Sub2API、裸 AT/PAT；仅写入本地 aa 分类目录'
      : pasteImportMode === 'oauth'
        ? '使用 Codex CLI 的 PKCE 参数打开 OpenAI 官方授权页，token 仅在主进程中交换'
        : pasteImportMode === 'codex'
          ? '每行一个 rt.1...，使用 Codex CLI 客户端刷新并保存旋转后的新 RT'
          : '每行一个 rt.1...，使用 OpenAI 移动端客户端刷新并保存对应 client_id'

  const placeholder =
    pasteImportMode === 'auto'
      ? '粘贴 Codex / Grok JSON、JSONL、CPA、SubAPI、裸 AT/PAT/RT、键值文本或静态 JS'
      : pasteImportMode === 'oauth'
        ? '粘贴浏览器最后的 http://localhost:1455/auth/callback?code=...&state=... 地址'
        : '每行粘贴一个 OpenAI Refresh Token（rt.1...）'

  return (
    <DialogBackdrop>
      <DialogPanel ref={dialogRef} className="import-dialog max-w-[720px]" role="dialog" aria-modal="true" aria-label="导入账号" tabIndex={-1}>
        <DialogHeader>
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--color-text)]">导入账号到本地库</h2>
            <div className="provider-detection mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--color-text-muted)]">
              <span className="provider-label codex inline-flex items-center gap-1 rounded-full bg-[var(--color-accent-soft)] px-1.5 py-0.5 text-[var(--color-accent)]"><Code2 size={11} />Codex</span>
              <span className="provider-label grok inline-flex items-center gap-1 rounded-full bg-[rgba(167,139,250,0.16)] px-1.5 py-0.5 text-[#c4b5fd]"><Zap size={11} />Grok</span>
              <span>自动分类保存到 aa，不修改 CPA 目录</span>
            </div>
          </div>
          <Button variant="ghost" size="icon" title="关闭" aria-label="关闭导入账号" onClick={onClose} disabled={busy}><X size={18} /></Button>
        </DialogHeader>
        <div className="import-source-actions grid grid-cols-2 gap-2 px-4 py-3">
          <Button aria-label="导入多个文件" className="h-auto flex-col items-start gap-1 px-3 py-3" onClick={onImportFiles} disabled={busy}>
            <Import size={17} /><span className="text-left"><strong className="block text-[13px]">导入文件</strong><small className="text-[11px] text-[var(--color-text-muted)]">先识别、去重并预览</small></span>
          </Button>
          <Button aria-label="导入文件夹" className="h-auto flex-col items-start gap-1 px-3 py-3" onClick={onImportDirectory} disabled={busy}>
            <FolderInput size={17} /><span className="text-left"><strong className="block text-[13px]">导入文件夹</strong><small className="text-[11px] text-[var(--color-text-muted)]">递归识别后确认写入</small></span>
          </Button>
        </div>
        <div className="import-divider px-4 text-center text-[12px] text-[var(--color-text-muted)]"><span>或粘贴凭据</span></div>
        <div className="option-group import-method-group space-y-2 px-4 py-3">
          <span className="text-[12px] text-[var(--color-text-secondary)]">识别方式</span>
          <SegmentedControl className="import-mode-control">
            <SegmentedButton selected={pasteImportMode === 'auto'} onClick={() => setPasteImportMode('auto')}>智能识别</SegmentedButton>
            <SegmentedButton selected={pasteImportMode === 'oauth'} onClick={() => setPasteImportMode('oauth')}>浏览器授权</SegmentedButton>
            <SegmentedButton selected={pasteImportMode === 'codex'} onClick={() => setPasteImportMode('codex')}>Codex RT</SegmentedButton>
            <SegmentedButton selected={pasteImportMode === 'mobile'} onClick={() => setPasteImportMode('mobile')}>移动端 RT</SegmentedButton>
          </SegmentedControl>
          <small className="block text-[11px] leading-relaxed text-[var(--color-text-muted)]">{modeHint}</small>
        </div>
        {pasteImportMode === 'oauth' && (
          <div className="oauth-import-step flex flex-wrap items-center gap-2 px-4 pb-2">
            <Button onClick={onStartOAuth} disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />}
              {oauthSession ? '重新打开授权页' : '打开 OpenAI 授权页'}
            </Button>
            <span className="text-[12px] text-[var(--color-text-muted)]">{oauthSession ? '授权会话已就绪，粘贴回调 URL 后完成导入' : '授权会话保留 30 分钟'}</span>
          </div>
        )}
        <label className="paste-field block px-4 pb-3">
          <textarea
            aria-label="凭据文本"
            className="min-h-[140px] w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2.5 text-[13px] text-[var(--color-text)] outline-none focus-visible:border-[var(--color-accent-strong)] focus-visible:ring-2 focus-visible:ring-[var(--ui-focus)]"
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
            placeholder={placeholder}
          />
        </label>
        <DialogActions>
          <Button variant="secondary" onClick={onClose} disabled={busy}><X size={16} />取消</Button>
          <Button variant="default" onClick={onSubmitPaste} disabled={busy || !pasteText.trim() || (pasteImportMode === 'oauth' && !oauthSession)}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <ClipboardPaste size={16} />}
            {pasteImportMode === 'oauth' ? '完成授权并导入' : '清洗并导入'}
          </Button>
        </DialogActions>
      </DialogPanel>
    </DialogBackdrop>
  )
}
