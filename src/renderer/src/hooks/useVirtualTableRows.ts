import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemo, useRef } from 'react'

const VIRTUALIZATION_THRESHOLD = 80

export interface VirtualTableRow<T> {
  index: number
  item: T
}

export function useVirtualTableRows<T>(
  items: readonly T[],
  getKey: (item: T) => string,
  estimateSize = 118
): {
  scrollRef: React.RefObject<HTMLDivElement | null>
  rows: VirtualTableRow<T>[]
  paddingTop: number
  paddingBottom: number
  enabled: boolean
  measureElement: (element: HTMLTableRowElement | null) => void
} {
  const scrollRef = useRef<HTMLDivElement>(null)
  const enabled = items.length > VIRTUALIZATION_THRESHOLD
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: enabled ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateSize,
    getItemKey: (index) => getKey(items[index]),
    overscan: 8,
    initialRect: { width: 1200, height: 720 },
    measureElement: (element) => element?.getBoundingClientRect().height ?? estimateSize
  })
  const virtualItems = enabled ? virtualizer.getVirtualItems() : []
  const rows = useMemo<VirtualTableRow<T>[]>(() => enabled
    ? virtualItems.map((row) => ({ index: row.index, item: items[row.index] }))
    : items.map((item, index) => ({ index, item })), [enabled, items, virtualItems])
  const first = virtualItems[0]
  const last = virtualItems.at(-1)

  return {
    scrollRef,
    rows,
    paddingTop: enabled && first ? first.start : 0,
    paddingBottom: enabled && last ? Math.max(0, virtualizer.getTotalSize() - last.end) : 0,
    enabled,
    measureElement: virtualizer.measureElement
  }
}
