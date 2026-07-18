// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useVirtualTableRows } from './useVirtualTableRows'

describe('useVirtualTableRows', () => {
  it('renders small lists completely', () => {
    const items = Array.from({ length: 20 }, (_, index) => ({ id: `account-${index}` }))
    const { result } = renderHook(() => useVirtualTableRows(items, (item) => item.id))

    expect(result.current.enabled).toBe(false)
    expect(result.current.rows).toHaveLength(items.length)
  })

  it('limits large lists to the visible window plus overscan', () => {
    const items = Array.from({ length: 500 }, (_, index) => ({ id: `account-${index}` }))
    const { result } = renderHook(() => useVirtualTableRows(items, (item) => item.id, 100))

    expect(result.current.enabled).toBe(true)
    expect(result.current.rows.length).toBeGreaterThan(0)
    expect(result.current.rows.length).toBeLessThan(items.length)
    expect(result.current.paddingBottom).toBeGreaterThan(0)
  })
})
