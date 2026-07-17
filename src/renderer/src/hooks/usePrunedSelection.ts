import { useEffect, useMemo, useState } from 'react'

export function usePrunedSelection(
  validIds: readonly string[]
): [Set<string>, React.Dispatch<React.SetStateAction<Set<string>>>] {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const validKey = validIds.join('\u0000')
  const valid = useMemo(() => new Set(validIds), [validKey])

  useEffect(() => {
    setSelected((current) => {
      const next = new Set([...current].filter((id) => valid.has(id)))
      return next.size === current.size ? current : next
    })
  }, [valid])

  return [selected, setSelected]
}

export function toggleSelection(
  setter: React.Dispatch<React.SetStateAction<Set<string>>>,
  id: string
): void {
  setter((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
}
