import type { CodexSwitcherApi } from '../../../shared/ipc'

/** Thin IPC facade — all renderer code should prefer this over raw window access. */
export function codexApi(): CodexSwitcherApi {
  if (!window.codexSwitcher) {
    throw new Error('Codex Switcher preload bridge is not available')
  }
  return window.codexSwitcher
}

export type { CodexSwitcherApi }