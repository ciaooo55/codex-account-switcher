import type { CodexTestMode } from '../../../shared/types'

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
    <div className="test-mode-control" role="group" aria-label={label}>
      {MODES.map((mode) => (
        <button
          key={mode.value}
          type="button"
          className={value === mode.value ? 'active' : ''}
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
