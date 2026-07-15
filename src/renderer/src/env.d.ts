/// <reference types="vite/client" />

import type { CodexSwitcherApi } from '../../shared/ipc'

declare global {
  interface Window {
    codexSwitcher: CodexSwitcherApi
  }
}

export {}
