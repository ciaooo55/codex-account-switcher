import type { AppSnapshot } from '../../../../shared/ipc'
import { codexApi } from '../../services/codexApi'

export function GlobalTestProgress({ snapshot }: { snapshot: AppSnapshot }): React.JSX.Element | null {
  const active =
    snapshot.testing.active ||
    snapshot.grokTesting.active ||
    snapshot.cpaGrokTesting.active ||
    snapshot.cpaCodexTesting.active
  if (!active) return null

  return (
    <div className="global-test-progress" aria-live="polite" aria-label="账号检测进度">
      {snapshot.testing.active && (
        <div className="task-progress">
          <div style={{ width: `${snapshot.testing.total ? (snapshot.testing.done / snapshot.testing.total) * 100 : 0}%` }} />
          <span>Codex 检测 {snapshot.testing.done} / {snapshot.testing.total}</span>
          <button type="button" className="progress-cancel" title="取消 Codex 检测" onClick={() => void codexApi().cancelTests()}>取消</button>
        </div>
      )}
      {snapshot.grokTesting.active && (
        <div className="task-progress">
          <div style={{ width: `${snapshot.grokTesting.total ? (snapshot.grokTesting.done / snapshot.grokTesting.total) * 100 : 0}%` }} />
          <span>Grok 检测 {snapshot.grokTesting.done} / {snapshot.grokTesting.total}</span>
          <button type="button" className="progress-cancel" title="取消 Grok 检测" onClick={() => void codexApi().cancelGrokTests()}>取消</button>
        </div>
      )}
      {snapshot.cpaCodexTesting.active && (
        <div className="task-progress">
          <div style={{ width: `${snapshot.cpaCodexTesting.total ? (snapshot.cpaCodexTesting.done / snapshot.cpaCodexTesting.total) * 100 : 0}%` }} />
          <span>CPA Codex 检测 {snapshot.cpaCodexTesting.done} / {snapshot.cpaCodexTesting.total}</span>
          <button type="button" className="progress-cancel" title="取消 CPA Codex 检测" onClick={() => void codexApi().cancelCpaCodexTests()}>取消</button>
        </div>
      )}
      {snapshot.cpaGrokTesting.active && (
        <div className="task-progress">
          <div style={{ width: `${snapshot.cpaGrokTesting.total ? (snapshot.cpaGrokTesting.done / snapshot.cpaGrokTesting.total) * 100 : 0}%` }} />
          <span>CPA Grok 检测 {snapshot.cpaGrokTesting.done} / {snapshot.cpaGrokTesting.total}</span>
          <button type="button" className="progress-cancel" title="取消 CPA Grok 检测" onClick={() => void codexApi().cancelCpaGrokTests()}>取消</button>
        </div>
      )}
    </div>
  )
}