export type ThemeMode = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'codex-account-switcher/theme'
export const ACTIVE_VIEW_STORAGE_KEY = 'codex-account-switcher/active-view'

export function initialTheme(): ThemeMode {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function applyTheme(theme: ThemeMode): void {
  document.documentElement.dataset.theme = theme
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // ignore storage failures in restricted environments
  }
}

export function toggleTheme(theme: ThemeMode): ThemeMode {
  return theme === 'light' ? 'dark' : 'light'
}