import { CheckSquare2, Power, PowerOff, TestTube2, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { DisplayAccountStatus } from '../../../shared/types'
import type { AccountFacetOption } from '../account-filters'
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
  disabled = false,
  groups = [],
  groupValue = '',
  onGroupChange,
  onGroupAction
}: {
  value: DisplayAccountStatus | ''
  counts: Readonly<Partial<Record<DisplayAccountStatus, number>>>
  total: number
  onChange: (status: DisplayAccountStatus | '') => void
  label: string
  onAction?: (action: StatusCategoryAction, status: DisplayAccountStatus | '') => void
  managedFiles?: boolean
  disabled?: boolean
  groups?: readonly AccountFacetOption[]
  groupValue?: string
  onGroupChange?: (group: string) => void
  onGroupAction?: (action: StatusCategoryAction, group: string) => void
}): React.JSX.Element {
  const [menu, setMenu] = useState<{
    target: 'status' | 'group'
    value: DisplayAccountStatus | string
    label: string
    count: number
    x: number
    y: number
  } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menu) return
    menuRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus()
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
  const menuPosition = (event: React.MouseEvent): { x: number; y: number } => ({
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - 238)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - (managedFiles ? 250 : 170)))
  })
  const openStatusMenu = (event: React.MouseEvent, status: DisplayAccountStatus | ''): void => {
    if (!onAction || disabled) return
    event.preventDefault()
    setMenu({
      target: 'status',
      value: status,
      label: status ? STATUS_LABELS[status] : '全部账号',
      count: status ? counts[status] ?? 0 : total,
      ...menuPosition(event)
    })
  }
  const openGroupMenu = (event: React.MouseEvent, group: AccountFacetOption | null): void => {
    if (!onGroupAction || disabled) return
    event.preventDefault()
    setMenu({
      target: 'group',
      value: group?.value ?? '',
      label: group?.label ?? '全部分组',
      count: group?.count ?? (value ? counts[value] ?? 0 : total),
      ...menuPosition(event)
    })
  }
  const runAction = (action: StatusCategoryAction): void => {
    if (!menu || menu.count === 0) return
    const currentMenu = menu
    setMenu(null)
    if (currentMenu.target === 'group') onGroupAction?.(action, currentMenu.value)
    else onAction?.(action, currentMenu.value as DisplayAccountStatus | '')
  }
  const menuKind = menu?.target === 'group' ? '分组' : '分类'
  return (
    <>
      <div className="status-filter-strip" aria-label={label}>
      <button
        className={value === '' ? 'active' : ''}
        aria-pressed={value === ''}
        title="左键筛选，右键批量操作"
        onClick={() => onChange('')}
        onContextMenu={(event) => openStatusMenu(event, '')}
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
          onContextMenu={(event) => openStatusMenu(event, status as DisplayAccountStatus)}
        >
          <span>{statusLabel}</span><strong>{counts[status as DisplayAccountStatus] ?? 0}</strong>
        </button>
      ))}
      {onGroupChange && groups.length > 0 && (
        <div className="group-filter-buttons" role="group" aria-label={`${label}分组筛选`}>
          <button
            className={groupValue === '' ? 'active' : ''}
            aria-pressed={groupValue === ''}
            title="左键筛选，右键批量操作"
            onClick={() => onGroupChange('')}
            onContextMenu={(event) => openGroupMenu(event, null)}
          >
            <span>全部分组</span>
          </button>
          {groups.map((group) => (
            <button
              key={group.value}
              className={groupValue === group.value ? 'active' : ''}
              aria-pressed={groupValue === group.value}
              title="左键筛选，右键批量操作"
              onClick={() => onGroupChange(group.value)}
              onContextMenu={(event) => openGroupMenu(event, group)}
            >
              <span>{group.label}</span><strong>{group.count}</strong>
            </button>
          ))}
        </div>
      )}
      </div>
      {menu && <div ref={menuRef} className="account-context-menu category-context-menu" role="menu" aria-label={`${label}${menuKind}操作`} style={{ left: menu.x, top: menu.y }}>
        <div className="context-account">{menu.label}<span>{menu.count} 个账号</span></div>
        <button role="menuitem" disabled={menu.count === 0} onClick={() => runAction('select')}><CheckSquare2 size={15} />选择该{menuKind}</button>
        <button className="context-test" role="menuitem" disabled={menu.count === 0} onClick={() => runAction('test')}><TestTube2 size={15} />测试该{menuKind}</button>
        {managedFiles && <button className="context-enable" role="menuitem" disabled={menu.count === 0} onClick={() => runAction('enable')}><Power size={15} />全部启用 .json</button>}
        {managedFiles && <button className="context-disable" role="menuitem" disabled={menu.count === 0} onClick={() => runAction('disable')}><PowerOff size={15} />全部停用 .json.0</button>}
        <button className="context-danger" role="menuitem" disabled={menu.count === 0} onClick={() => runAction('delete')}><Trash2 size={15} />删除该{menuKind}全部账号</button>
      </div>}
    </>
  )
}
