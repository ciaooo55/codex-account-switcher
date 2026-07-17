// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { toggleSelection, usePrunedSelection } from './usePrunedSelection'

describe('usePrunedSelection', () => {
  it('keeps existing selections and removes ids that no longer exist', () => {
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => usePrunedSelection(ids),
      { initialProps: { ids: ['one', 'two'] } }
    )

    act(() => {
      toggleSelection(result.current[1], 'one')
      toggleSelection(result.current[1], 'two')
    })
    expect([...result.current[0]].sort()).toEqual(['one', 'two'])

    rerender({ ids: ['two'] })
    expect([...result.current[0]]).toEqual(['two'])
  })
})
