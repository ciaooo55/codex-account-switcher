import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ConfirmationDialog,
  type ConfirmationOptions
} from '../components/ConfirmationDialog'

export type RequestConfirmation = (options: ConfirmationOptions) => Promise<boolean>

export function useConfirmation(): {
  requestConfirmation: RequestConfirmation
  confirmationDialog: React.JSX.Element | null
} {
  const [options, setOptions] = useState<ConfirmationOptions | null>(null)
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null)

  const settle = useCallback((confirmed: boolean): void => {
    const resolve = resolverRef.current
    resolverRef.current = null
    setOptions(null)
    resolve?.(confirmed)
  }, [])

  const requestConfirmation = useCallback<RequestConfirmation>((nextOptions) => {
    resolverRef.current?.(false)
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve
      setOptions(nextOptions)
    })
  }, [])

  useEffect(() => () => {
    resolverRef.current?.(false)
    resolverRef.current = null
  }, [])

  return {
    requestConfirmation,
    confirmationDialog: options
      ? <ConfirmationDialog {...options} onCancel={() => settle(false)} onConfirm={() => settle(true)} />
      : null
  }
}
