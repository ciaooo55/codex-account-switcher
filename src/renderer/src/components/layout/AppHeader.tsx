import {
  Code2,
  Import,
  ListChecks,
  Moon,
  PackageOpen,
  Settings,
  Sun,
  TimerReset,
  Zap
} from 'lucide-react'
import { Badge, Button } from '@/components/ui'
import { cn } from '@/lib/cn'
import type { AppView } from '@/lib/navigation'
import type { ThemeMode } from '@/lib/theme'

export interface AppHeaderProps {
  activeView: AppView
  onViewChange: (view: AppView) => void
  accountsCount: number
  grokCount: number | '…'
  cpaCount: number | '…'
  version: string | null
  theme: ThemeMode
  busy: boolean
  onImport: () => void
  onToggleTheme: () => void
  onOpenSettings: () => void
}

const tabs: Array<{
  id: AppView
  label: string
  icon: typeof ListChecks
  countKey?: 'accounts' | 'grok' | 'cpa'
  countVariant?: 'default' | 'accent' | 'grok'
}> = [
  { id: 'accounts', label: 'Codex 账号库', icon: ListChecks, countKey: 'accounts', countVariant: 'accent' },
  { id: 'grok', label: 'Grok 账号库', icon: Zap, countKey: 'grok', countVariant: 'grok' },
  { id: 'cpa', label: 'CPA 账号管理', icon: PackageOpen, countKey: 'cpa' },
  { id: 'automation', label: '定时切换', icon: TimerReset }
]

export function AppHeader({
  activeView,
  onViewChange,
  accountsCount,
  grokCount,
  cpaCount,
  version,
  theme,
  busy,
  onImport,
  onToggleTheme,
  onOpenSettings
}: AppHeaderProps): React.JSX.Element {
  const counts = {
    accounts: accountsCount,
    grok: grokCount,
    cpa: cpaCount
  } as const

  return (
    <header className="app-header sticky top-0 z-40 flex flex-wrap items-center gap-3 border-b border-[var(--color-border)] bg-[var(--glass-bg)] px-3 py-2 backdrop-blur-xl">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
          <Code2 size={17} />
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-semibold tracking-tight text-[var(--color-text)]">
            Codex Account Switcher
          </h1>
          <span
            className="app-version text-[11px] text-[var(--color-text-muted)]"
            title={version ? `当前版本 v${version}` : '正在读取版本'}
          >
            {version ? `v${version}` : 'v…'}
          </span>
        </div>
      </div>

      <nav
        className="flex min-w-0 flex-1 flex-wrap items-center gap-1 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-1)] p-1"
        aria-label="主页面"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon
          const active = activeView === tab.id
          const count = tab.countKey ? counts[tab.countKey] : null
          return (
            <button
              key={tab.id}
              type="button"
              aria-pressed={active}
              onClick={() => onViewChange(tab.id)}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 text-[12.5px] font-medium transition-colors',
                active
                  ? 'bg-[var(--color-surface-0)] text-[var(--color-text)] shadow-[var(--shadow-sm)]'
                  : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]'
              )}
            >
              <Icon size={15} className={active ? 'text-[var(--color-accent)]' : undefined} />
              <span className="whitespace-nowrap">{tab.label}</span>
              {count !== null && count !== undefined ? (
                <Badge variant={active ? (tab.countVariant ?? 'default') : 'default'}>{count}</Badge>
              ) : null}
            </button>
          )
        })}
      </nav>

      <div className="ml-auto flex items-center gap-1.5">
        <Button variant="soft" onClick={onImport} disabled={busy} aria-label="导入账号">
          <Import size={16} />
          导入账号
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'}
          aria-label={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'}
          onClick={onToggleTheme}
        >
          {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title="设置"
          aria-label="设置"
          onClick={onOpenSettings}
          disabled={busy}
        >
          <Settings size={18} />
        </Button>
      </div>
    </header>
  )
}
