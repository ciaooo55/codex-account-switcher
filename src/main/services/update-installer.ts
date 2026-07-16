import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

interface FetchResponse {
  ok: boolean
  status: number
  statusText: string
  headers: { get(name: string): string | null }
  body: AsyncIterable<Uint8Array> | null
}

export interface DownloadInstallerOptions {
  url: string
  targetPath: string
  expectedSha512: string
  fetch: (url: string) => Promise<FetchResponse>
  onProgress?: (percent: number) => void
}

async function writeChunk(
  file: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array
): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const result = await file.write(chunk, offset, chunk.byteLength - offset)
    offset += result.bytesWritten
  }
}

export async function downloadInstaller(options: DownloadInstallerOptions): Promise<string> {
  const temporaryPath = `${options.targetPath}.download`
  await mkdir(dirname(options.targetPath), { recursive: true })
  await rm(temporaryPath, { force: true })

  const response = await options.fetch(options.url)
  if (!response.ok || !response.body) {
    throw new Error(`安装包下载失败：HTTP ${response.status} ${response.statusText}`.trim())
  }

  const total = Number(response.headers.get('content-length'))
  const hash = createHash('sha512')
  const file = await open(temporaryPath, 'w')
  let received = 0
  let lastReported = -1

  try {
    for await (const value of response.body) {
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
      await writeChunk(file, chunk)
      hash.update(chunk)
      received += chunk.byteLength
      if (Number.isFinite(total) && total > 0) {
        const percent = Math.min(100, (received / total) * 100)
        if (percent - lastReported >= 0.2 || percent === 100) {
          lastReported = percent
          options.onProgress?.(percent)
        }
      }
    }
  } catch (error) {
    await file.close()
    await rm(temporaryPath, { force: true })
    throw error
  }
  await file.close()

  const actualSha512 = hash.digest('base64')
  if (actualSha512 !== options.expectedSha512) {
    await rm(temporaryPath, { force: true })
    throw new Error('安装包校验失败，已删除不完整或不可信的下载文件')
  }

  await rm(options.targetPath, { force: true })
  await rename(temporaryPath, options.targetPath)
  options.onProgress?.(100)
  return options.targetPath
}

export function buildInstallAndCleanupScript(
  installerPath: string,
  installDirectory: string
): string {
  const escapedPath = installerPath.replaceAll("'", "''")
  const escapedDirectory = installDirectory.replaceAll("'", "''")
  return [
    "$ErrorActionPreference = 'Stop'",
    `$installer = '${escapedPath}'`,
    `$installDirectory = '${escapedDirectory}'`,
    "$application = Join-Path $installDirectory 'Codex Account Switcher.exe'",
    '$deadline = [DateTime]::UtcNow.AddSeconds(20)',
    'do {',
    "  $running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and [StringComparer]::OrdinalIgnoreCase.Equals($_.ExecutablePath, $application) })",
    '  if ($running.Count -eq 0) { break }',
    '  Start-Sleep -Milliseconds 250',
    '} while ([DateTime]::UtcNow -lt $deadline)',
    'if ($running.Count -gt 0) {',
    '  $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    '  Start-Sleep -Milliseconds 750',
    '}',
    "$machineKey = 'Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ca637cc9-81db-5210-aea1-8b5539723f26'",
    '$machineInstall = Test-Path -LiteralPath $machineKey',
    "$arguments = if ($machineInstall) { @('/S', '/allusers', \"/D=$installDirectory\") } else { @('/S', '/currentuser', \"/D=$installDirectory\") }",
    '$start = @{ FilePath = $installer; ArgumentList = $arguments; PassThru = $true; Wait = $true }',
    "if ($machineInstall) { $start['Verb'] = 'RunAs' }",
    '$process = Start-Process @start',
    "if ($process.ExitCode -ne 0) { throw \"Installer exited with code $($process.ExitCode)\" }",
    'Start-Sleep -Seconds 2',
    'Remove-Item -LiteralPath $installer -Force -ErrorAction Stop'
  ].join('; ')
}

export function launchInstallerAndDelete(installerPath: string, installDirectory: string): void {
  const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  const encodedCommand = Buffer.from(
    buildInstallAndCleanupScript(installerPath, installDirectory),
    'utf16le'
  ).toString('base64')
  const child = spawn(
    powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodedCommand],
    { detached: true, windowsHide: true, stdio: 'ignore' }
  )
  child.unref()
}

export async function cleanupLegacyUpdateCache(localAppData: string | undefined): Promise<void> {
  if (!localAppData) return
  await rm(`${localAppData}\\codex-account-switcher-updater\\pending`, {
    recursive: true,
    force: true
  })
}
