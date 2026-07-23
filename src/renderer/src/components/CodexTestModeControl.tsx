import type { CodexTestMode } from '../../../shared/types'
import { cn } from '@/lib/cn'

const MODES: ReadonlyArray<{ value: CodexTestMode; label: string; title: string }> = [
  { value: 'usage', label: '仅额度', title: '只查询额度和重置时间，不发送真实模型请求' },
  { value: 'full', label: '完整测试', title: '查询额度并发送一次 Codex compact 请求验证真实可用性' },
  { value: 'refresh', label: '仅刷新', title: '只刷新 OAuth 凭据，保留上次额度结果' }
]

export const CODEX_TEST_MODE_SUCCESS: Record<CodexTestMode, string> = {
  usage: '额度查询完成',
  full: '完整检测完成',
  refresh: '凭据刷新完成'
}

export const CODEX_TEST_MODE_RUNNING: Record<CodexTestMode, string> = {
  usage: '正在查询额度与重置时间',
  full: '正在查询额度并验证真实请求',
  refresh: '正在刷新 OAuth 凭据'
}

export function CodexTestModeControl({
  value,
  onChange,
  disabled = false,
  label = '检测模式'
}: {
  value: CodexTestMode
  onChange: (value: CodexTestMode) => void
  disabled?: boolean
  label?: string
}): React.JSX.Element {
  return (
    <div
      className="test-mode-control inline-flex items-center gap-0.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-0)] p-0.5"
      role="group"
      aria-label={label}
    >
      {MODES.map((mode) => (
        <button
          key={mode.value}
          type="button"
          className={cn(
            'h-7 rounded-[calc(var(--radius-md)-2px)] px-2.5 text-[12px] font-medium transition-colors',
            value === mode.value
              ? 'active bg-[var(--color-surface-2)] text-[var(--color-text)] shadow-[var(--shadow-sm)]'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-1)] hover:text-[var(--color-text)]'
          )}
          aria-pressed={value === mode.value}
          title={mode.title}
          disabled={disabled}
          onClick={() => onChange(mode.value)}
        >
          {mode.label}
        </button>
      ))}
    </div>
  )
}
