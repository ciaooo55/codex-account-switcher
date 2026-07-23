import type { AppSnapshot } from '../../../../shared/ipc'
import { Button, Progress } from '@/components/ui'
import { codexApi } from '@/services/codexApi'

function pct(done: number, total: number): number {
  return total ? (done / total) * 100 : 0
}

export function GlobalTestProgress({ snapshot }: { snapshot: AppSnapshot }): React.JSX.Element | null {
  const active =
    snapshot.testing.active ||
    snapshot.grokTesting.active ||
    snapshot.cpaGrokTesting.active ||
    snapshot.cpaCodexTesting.active
  if (!active) return null

  return (
    <div className="global-test-progress flex flex-col gap-1.5 px-3 pt-2" aria-live="polite" aria-label="账号检测进度">
      {snapshot.testing.active && (
        <Progress
          value={pct(snapshot.testing.done, snapshot.testing.total)}
          label={'Codex 检测 ' + snapshot.testing.done + ' / ' + snapshot.testing.total}
          action={
            <Button type="button" variant="ghost" size="sm" className="progress-cancel h-6 px-2" title="取消 Codex 检测" onClick={() => void codexApi().cancelTests()}>
              取消
            </Button>
          }
        />
      )}
      {snapshot.grokTesting.active && (
        <Progress
          value={pct(snapshot.grokTesting.done, snapshot.grokTesting.total)}
          label={'Grok 检测 ' + snapshot.grokTesting.done + ' / ' + snapshot.grokTesting.total}
          action={
            <Button type="button" variant="ghost" size="sm" className="progress-cancel h-6 px-2" title="取消 Grok 检测" onClick={() => void codexApi().cancelGrokTests()}>
              取消
            </Button>
          }
        />
      )}
      {snapshot.cpaCodexTesting.active && (
        <Progress
          value={pct(snapshot.cpaCodexTesting.done, snapshot.cpaCodexTesting.total)}
          label={'CPA Codex 检测 ' + snapshot.cpaCodexTesting.done + ' / ' + snapshot.cpaCodexTesting.total}
          action={
            <Button type="button" variant="ghost" size="sm" className="progress-cancel h-6 px-2" title="取消 CPA Codex 检测" onClick={() => void codexApi().cancelCpaCodexTests()}>
              取消
            </Button>
          }
        />
      )}
      {snapshot.cpaGrokTesting.active && (
        <Progress
          value={pct(snapshot.cpaGrokTesting.done, snapshot.cpaGrokTesting.total)}
          label={'CPA Grok 检测 ' + snapshot.cpaGrokTesting.done + ' / ' + snapshot.cpaGrokTesting.total}
          action={
            <Button type="button" variant="ghost" size="sm" className="progress-cancel h-6 px-2" title="取消 CPA Grok 检测" onClick={() => void codexApi().cancelCpaGrokTests()}>
              取消
            </Button>
          }
        />
      )}
    </div>
  )
}
