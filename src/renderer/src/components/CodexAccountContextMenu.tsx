import { Copy, Download, FolderOpen, RotateCcw, TestTube2, Trash2 } from 'lucide-react'
import type { RefObject } from 'react'
import type { AccountSummary } from '../../../shared/types'
import { ContextMenu, ContextMenuItem, ContextMenuLabel } from '@/components/ui'

export function CodexAccountContextMenu({
  menuRef,
  account,
  x,
  y,
  busy,
  testingActive,
  onTest,
  onSwitch,
  onExport,
  onReveal,
  onCopyEmail,
  onDelete
}: {
  menuRef: RefObject<HTMLDivElement | null>
  account: AccountSummary
  x: number
  y: number
  busy: boolean
  testingActive: boolean
  onTest: () => void
  onSwitch: () => void
  onExport: () => void
  onReveal: () => void
  onCopyEmail: () => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <ContextMenu menuRef={menuRef} label="账号管理" style={{ left: x, top: y }}>
      <ContextMenuLabel title={account.email ?? account.sourcePath}>
        {account.alias ?? account.email ?? '邮箱未知'}
      </ContextMenuLabel>
      <ContextMenuItem onClick={onTest}><TestTube2 size={15} />检测此账号</ContextMenuItem>
      <ContextMenuItem
        disabled={busy || !account.switchable}
        title={!account.switchable ? '缺少可供 Codex 使用的认证材料' : '切换后会同步当前会话并重启 Codex'}
        onClick={onSwitch}
      >
        <RotateCcw size={15} />切换并重启
      </ContextMenuItem>
      <ContextMenuItem onClick={onExport}><Download size={15} />导出此账号</ContextMenuItem>
      <ContextMenuItem onClick={onReveal}><FolderOpen size={15} />打开源文件位置</ContextMenuItem>
      <ContextMenuItem disabled={!account.email} onClick={onCopyEmail}><Copy size={15} />复制邮箱</ContextMenuItem>
      <ContextMenuItem danger disabled={busy || testingActive} onClick={onDelete}><Trash2 size={15} />删除此账号</ContextMenuItem>
    </ContextMenu>
  )
}
