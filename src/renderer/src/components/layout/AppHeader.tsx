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
import type { AppView } from '../../lib/navigation'
import type { ThemeMode } from '../../lib/theme'

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
  return (
    <header className="app-header">
      <div className="app-identity">
        <div className="identity-title">
          <span className="product-mark"><Code2 size={17} /></span>
          <div className="identity-copy">
            <h1>Codex Account Switcher</h1>
            <span className="app-version" title={version ? `当前版本 v${version}` : '正在读取版本'}>
              {version ? `v${version}` : 'v…'}
            </span>
          </div>
        </div>
      </div>
      <nav className="view-tabs" aria-label="主页面">
        <button className={activeView === 'accounts' ? 'active' : ''} aria-pressed={activeView === 'accounts'} onClick={() => onViewChange('accounts')}>
          <ListChecks size={16} />Codex 账号库 <span className="tab-count">{accountsCount}</span>
        </button>
        <button className={activeView === 'grok' ? 'active' : ''} aria-pressed={activeView === 'grok'} onClick={() => onViewChange('grok')}>
          <Zap size={16} />Grok 账号库 <span className="tab-count grok">{grokCount}</span>
        </button>
        <button className={activeView === 'cpa' ? 'active' : ''} aria-pressed={activeView === 'cpa'} onClick={() => onViewChange('cpa')}>
          <PackageOpen size={16} />CPA 账号管理 <span className="tab-count">{cpaCount}</span>
        </button>
        <button className={activeView === 'automation' ? 'active' : ''} aria-pressed={activeView === 'automation'} onClick={() => onViewChange('automation')}>
          <TimerReset size={16} />定时切换
        </button>
      </nav>
      <button className="header-import-button" aria-label="导入账号" onClick={onImport} disabled={busy}>
        <Import size={17} />导入账号
      </button>
      <button
        className="icon-button"
        title={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'}
        aria-label={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'}
        onClick={onToggleTheme}
      >
        {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
      </button>
      <button className="icon-button" title="设置" aria-label="设置" onClick={onOpenSettings} disabled={busy}>
        <Settings size={19} />
      </button>
    </header>
  )
}