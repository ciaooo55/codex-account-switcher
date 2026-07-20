// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StatusFilterStrip } from './StatusFilterStrip'

describe('StatusFilterStrip', () => {
  it('opens category actions on right click without changing the active filter', () => {
    const onChange = vi.fn()
    const onAction = vi.fn()
    render(
      <StatusFilterStrip
        value=""
        counts={{ valid: 3 }}
        total={5}
        onChange={onChange}
        onAction={onAction}
        label="Codex 账号状态"
      />
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: '有效 3' }), { clientX: 100, clientY: 80 })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: '测试该分类' }))
    expect(onAction).toHaveBeenCalledWith('test', 'valid')
  })

  it('offers CPA file enable and disable actions for a managed category', () => {
    const onAction = vi.fn()
    render(
      <StatusFilterStrip
        value="quota_exhausted_weekly"
        counts={{ quota_exhausted_weekly: 4 }}
        total={4}
        onChange={vi.fn()}
        onAction={onAction}
        managedFiles
        label="CPA Codex 账号状态"
      />
    )

    fireEvent.contextMenu(screen.getByRole('button', { name: '周额度耗尽 4' }))
    fireEvent.click(screen.getByRole('menuitem', { name: '全部停用 .json.0' }))
    expect(onAction).toHaveBeenCalledWith('disable', 'quota_exhausted_weekly')
  })

  it('renders dynamic groups as right-side filter buttons', () => {
    const onGroupChange = vi.fn()
    render(
      <StatusFilterStrip
        value=""
        counts={{ valid: 3 }}
        total={5}
        onChange={vi.fn()}
        label="Codex 账号状态"
        groups={[
          { value: 'primary', label: '主力', count: 2 },
          { value: 'backup', label: '备用', count: 3 }
        ]}
        groupValue="primary"
        onGroupChange={onGroupChange}
      />
    )

    const groupFilters = screen.getByRole('group', { name: 'Codex 账号状态分组筛选' })
    expect(groupFilters).toHaveClass('group-filter-buttons')
    expect(screen.getByRole('button', { name: '主力 2' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '备用 3' }))
    expect(onGroupChange).toHaveBeenCalledWith('backup')
    fireEvent.click(screen.getByRole('button', { name: '全部分组' }))
    expect(onGroupChange).toHaveBeenCalledWith('')
  })
})
