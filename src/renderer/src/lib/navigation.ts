export type AppView = 'accounts' | 'grok' | 'cpa' | 'automation'

export const APP_VIEWS = ['accounts', 'grok', 'cpa', 'automation'] as const

export function isAppView(value: unknown): value is AppView {
  return typeof value === 'string' && (APP_VIEWS as readonly string[]).includes(value)
}