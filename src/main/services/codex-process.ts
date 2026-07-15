import { execFile } from 'node:child_process'

type ScriptRunner = (script: string) => Promise<string | void>

export const officialCodexRestartScript = `
$ErrorActionPreference = 'Stop'
$names = @('ChatGPT.exe', 'codex.exe', 'codex-code-mode-host.exe')
$package = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending)[0]
if ($null -eq $package) { throw '未找到官方 Codex Windows 应用' }
$installRoot = [IO.Path]::GetFullPath($package.InstallLocation)

function Get-OfficialCodexProcess {
  @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $path = $_.ExecutablePath
    $_.Name -in $names -and
      $path -and
      $path.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)
  })
}

@(Get-OfficialCodexProcess) | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

$stopDeadline = [DateTime]::UtcNow.AddSeconds(12)
do {
  $remaining = @(Get-OfficialCodexProcess)
  if ($remaining.Count -eq 0) { break }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $stopDeadline)
if ($remaining.Count -gt 0) { throw '官方 Codex 进程未能完全退出' }

$appId = "$($package.PackageFamilyName)!App"
Start-Process -FilePath 'explorer.exe' -ArgumentList "shell:AppsFolder\\$appId"

$startDeadline = [DateTime]::UtcNow.AddSeconds(20)
do {
  $started = @(Get-OfficialCodexProcess | Where-Object { $_.Name -eq 'ChatGPT.exe' })
  if ($started.Count -gt 0) { 'started'; exit 0 }
  Start-Sleep -Milliseconds 300
} while ([DateTime]::UtcNow -lt $startDeadline)
throw '已发出启动命令，但 20 秒内未检测到官方 Codex 窗口'
`.trim()

export const officialCodexProcessQueryScript = `
$names = @('ChatGPT.exe', 'codex.exe', 'codex-code-mode-host.exe')
$package = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending)[0]
if ($null -eq $package) { '0'; exit 0 }
$installRoot = [IO.Path]::GetFullPath($package.InstallLocation)
$targets = Get-CimInstance Win32_Process | Where-Object {
  $path = $_.ExecutablePath
  $_.Name -in $names -and
    $path -and
    $path.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)
}
if (@($targets).Count -gt 0) { '1' } else { '0' }
`.trim()

const defaultRunner: ScriptRunner = (script) =>
  new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message))
        else resolve(stdout)
      }
    )
  })

export class CodexProcessManager {
  private restartInFlight: Promise<{ ok: boolean; message: string }> | null = null

  constructor(private readonly runner: ScriptRunner = defaultRunner) {}

  restart(): Promise<{ ok: boolean; message: string }> {
    if (process.platform !== 'win32') {
      return Promise.resolve({ ok: false, message: '自动重启目前仅支持 Windows' })
    }
    if (this.restartInFlight) return this.restartInFlight
    this.restartInFlight = this.performRestart().finally(() => {
      this.restartInFlight = null
    })
    return this.restartInFlight
  }

  private async performRestart(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.runner(officialCodexRestartScript)
      return { ok: true, message: 'Codex 已重启' }
    } catch (error) {
      const detail = error instanceof Error ? error.message.trim() : ''
      return {
        ok: false,
        message: detail ? `Codex 自动重启失败：${detail}` : 'Codex 自动重启失败'
      }
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
