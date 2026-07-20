import { CheckSquare2, Power, PowerOff, TestTube2, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { DisplayAccountStatus } from '../../../shared/types'
import { STATUS_LABELS } from '../account-status'

export type StatusCategoryAction = 'select' | 'test' | 'delete' | 'enable' | 'disable'

export function StatusFilterStrip({
  value,
  counts,
  total,
  onChange,
  label,
  onAction,
  managedFiles = false,
  disabled = false
}: {
  value: DisplayAccountStatus | ''
  counts: Readonly<Partial<Record<DisplayAccountStatus, number>>>
  total: number
  onChange: (status: DisplayAccountStatus | '') => void
  label: string
  onAction?: (action: StatusCategoryAction, status: DisplayAccountStatus | '') => void
  managedFiles?: boolean
  disabled?: boolean
}): React.JSX.Element {
  const [menu, setMenu] = useState<{ status: DisplayAccountStatus | ''; x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      close()
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', closeOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [menu])
  const openMenu = (event: React.MouseEvent, status: DisplayAccountStatus | ''): void => {
    if (!onAction || disabled) return
    event.preventDefault()
    setMenu({
      status,
      x: Math.min(event.clientX, window.innerWidth - 230),
      y: Math.min(event.clientY, window.innerHeight - (managedFiles ? 250 : 170))
    })
  }
  const runAction = (action: StatusCategoryAction): void => {
    if (!menu || menuCount === 0) return
    const status = menu.status
    setMenu(null)
    onAction?.(action, status)
  }
  const menuLabel = menu?.status ? STATUS_LABELS[menu.status] : '全部账号'
  const menuCount = menu?.status ? counts[menu.status] ?? 0 : total
  return (
    <>
      <div className="status-filter-strip" aria-label={label}>
      <button
        className={value === '' ? 'active' : ''}
        aria-pressed={value === ''}
        title="左键筛选，右键批量操作"
        onClick={() => onChange('')}
        onContextMenu={(event) => openMenu(event, '')}
      >
        <span>全部</span><strong>{total}</strong>
      </button>
      {Object.entries(STATUS_LABELS).filter(([status]) =>
        (counts[status as DisplayAccountStatus] ?? 0) > 0 || value === status
      ).map(([status, statusLabel]) => (
        <button
          key={status}
          className={`${value === status ? 'active ' : ''}filter-${status}`}
          aria-pressed={value === status}
          title="左键筛选，右键批量操作"
          onClick={() => onChange(status as DisplayAccountStatus)}
          onContextMenu={(event) => openMenu(event, status as DisplayAccountStatus)}
        >
          <span>{statusLabel}</span><strong>{counts[status as DisplayAccountStatus] ?? 0}</strong>
        </button>
      ))}
      </div>
      {menu && <div ref={menuRef} className="account-context-menu category-context-menu" role="menu" aria-label={`${label}分类操作`} style={{ left: menu.x, top: menu.y }}>
        <div className="context-account">{menuLabel}<span>{menuCount} 个账号</span></div>
        <button role="menuitem" disabled={menuCount === 0} onClick={() => runAction('select')}><CheckSquare2 size={15} />选择该分类</button>
        <button className="context-test" role="menuitem" disabled={menuCount === 0} onClick={() => runAction('test')}><TestTube2 size={15} />测试该分类</button>
        {managedFiles && <button className="context-enable" role="menuitem" disabled={menuCount === 0} onClick={() => runAction('enable')}><Power size={15} />全部启用 .json</button>}
        {managedFiles && <button className="context-disable" role="menuitem" disabled={menuCount === 0} onClick={() => runAction('disable')}><PowerOff size={15} />全部停用 .json.0</button>}
        <button className="context-danger" role="menuitem" disabled={menuCount === 0} onClick={() => runAction('delete')}><Trash2 size={15} />删除该分类全部账号</button>
      </div>}
    </>
  )
}
