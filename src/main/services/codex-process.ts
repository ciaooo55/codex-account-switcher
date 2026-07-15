import { execFile } from 'node:child_process'

type ScriptRunner = (script: string) => Promise<string | void>

export const officialCodexRestartScript = `
$names = @('ChatGPT.exe', 'codex.exe', 'codex-code-mode-host.exe')
$targets = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -in $names -and $_.ExecutablePath -like '*\\WindowsApps\\OpenAI.Codex_*'
}
$targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 800
Start-Process explorer.exe -ArgumentList 'shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App'
`.trim()

export const officialCodexProcessQueryScript = `
$names = @('ChatGPT.exe', 'codex.exe', 'codex-code-mode-host.exe')
$targets = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -in $names -and $_.ExecutablePath -like '*\\WindowsApps\\OpenAI.Codex_*'
}
if (@($targets).Count -gt 0) { '1' } else { '0' }
`.trim()

const defaultRunner: ScriptRunner = (script) =>
  new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true },
      (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      }
    )
  })

export class CodexProcessManager {
  constructor(private readonly runner: ScriptRunner = defaultRunner) {}

  async restart(): Promise<{ ok: boolean; message: string }> {
    if (process.platform !== 'win32') {
      return { ok: false, message: '自动重启目前仅支持 Windows' }
    }
    try {
      await this.runner(officialCodexRestartScript)
      return { ok: true, message: 'Codex 已重启' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'Codex 重启失败' }
    }
  }

  async isOfficialRunning(): Promise<boolean> {
    if (process.platform !== 'win32') return false
    try {
      return String(await this.runner(officialCodexProcessQueryScript)).trim() === '1'
    } catch {
      return true
    }
  }
}
