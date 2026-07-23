import { createContext, useContext, type ReactNode } from 'react'
import type { AppSnapshot, AppSnapshotPatch } from '../../../shared/ipc'
import type { ThemeMode } from '../lib/theme'
import type { AppView } from '../lib/navigation'
import type { AppToastMessage } from '../components/layout/AppToast'

export type AppSessionValue = {
  snapshot: AppSnapshot
  theme: ThemeMode
  activeView: AppView
  busy: boolean
  message: AppToastMessage | null
  applySnapshotPatch: (patch: AppSnapshotPatch, preserveSettingsDraft?: boolean) => void
  setBusy: (busy: boolean) => void
  notify: (kind: AppToastMessage['kind'], text: string) => void
  setActiveView: (view: AppView) => void
}

const AppSessionContext = createContext<AppSessionValue | null>(null)

export function AppSessionProvider({
  value,
  children
}: {
  value: AppSessionValue
  children: ReactNode
}): React.JSX.Element {
  return <AppSessionContext.Provider value={value}>{children}</AppSessionContext.Provider>
}

export function useAppSession(): AppSessionValue {
  const value = useContext(AppSessionContext)
  if (!value) throw new Error('useAppSession must be used within AppSessionProvider')
  return value
}
