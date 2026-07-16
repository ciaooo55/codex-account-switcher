import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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

export interface InstallerResult {
  status: 'succeeded' | 'failed'
  message: string
  at: string
}

export function getInstallerResultPath(): string {
  return `${process.env.TEMP ?? process.env.TMP ?? '.'}\\CodexAccountSwitcher-update-result.json`
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
  installDirectory: string,
  readyPath = `${installerPath}.update-ready`,
  logPath = `${process.env.TEMP ?? dirname(installerPath)}\\CodexAccountSwitcher-update.log`,
  resultPath = getInstallerResultPath(),
  machineInstallOverride?: boolean,
  helperPath?: string
): string {
  const escapedPath = installerPath.replaceAll("'", "''")
  const escapedDirectory = installDirectory.replaceAll("'", "''")
  const escapedReadyPath = readyPath.replaceAll("'", "''")
  const escapedLogPath = logPath.replaceAll("'", "''")
  const escapedResultPath = resultPath.replaceAll("'", "''")
  const escapedHelperPath = helperPath?.replaceAll("'", "''") ?? ''
  const machineInstallLine = machineInstallOverride === undefined
    ? '  $machineInstall = Test-Path -LiteralPath $machineKey'
    : `  $machineInstall = $${machineInstallOverride ? 'true' : 'false'}`
  return [
    "$ErrorActionPreference = 'Stop'",
    `$installer = '${escapedPath}'`,
    `$installDirectory = '${escapedDirectory}'`,
    `$readyPath = '${escapedReadyPath}'`,
    `$logPath = '${escapedLogPath}'`,
    `$resultPath = '${escapedResultPath}'`,
    `$helperPath = '${escapedHelperPath}'`,
    "$application = Join-Path $installDirectory 'Codex Account Switcher.exe'",
    'try {',
    "  Set-Content -LiteralPath $readyPath -Value 'ready' -Encoding ascii -Force",
    "  Set-Content -LiteralPath $logPath -Value \"[$([DateTime]::Now.ToString('s'))] Update helper started\" -Encoding utf8 -Force",
    '  $deadline = [DateTime]::UtcNow.AddSeconds(20)',
    '  do {',
    "    $running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and [StringComparer]::OrdinalIgnoreCase.Equals($_.ExecutablePath, $application) })",
    '    if ($running.Count -eq 0) { break }',
    '    Start-Sleep -Milliseconds 250',
    '  } while ([DateTime]::UtcNow -lt $deadline)',
    '  if ($running.Count -gt 0) {',
    '    $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    '    Start-Sleep -Milliseconds 750',
    '  }',
    "  $machineKey = 'Registry::HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ca637cc9-81db-5210-aea1-8b5539723f26'",
    machineInstallLine,
    "  $argumentLine = if ($machineInstall) { \"/S /allusers /D=`\"$installDirectory`\"\" } else { \"/S /currentuser /D=`\"$installDirectory`\"\" }",
    '  $start = @{ FilePath = $installer; ArgumentList = $argumentLine; PassThru = $true; Wait = $true }',
    "  if ($machineInstall) { $start['Verb'] = 'RunAs' }",
    '  $process = Start-Process @start',
    "  if ($process.ExitCode -ne 0) { throw \"Installer exited with code $($process.ExitCode)\" }",
    '  Start-Sleep -Seconds 1',
    "  if (-not (Test-Path -LiteralPath $application)) { throw 'Installed application executable was not found' }",
    '  Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue',
    "  Add-Content -LiteralPath $logPath -Value \"[$([DateTime]::Now.ToString('s'))] Update installed successfully\" -Encoding utf8 -ErrorAction SilentlyContinue",
    "  @{ status = 'succeeded'; message = '更新安装成功'; at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath $resultPath -Encoding utf8 -Force",
    '  Start-Process -FilePath $application',
    '} catch {',
    '  $failureMessage = $_.Exception.Message',
    "  Add-Content -LiteralPath $logPath -Value \"[$([DateTime]::Now.ToString('s'))] $failureMessage\" -Encoding utf8 -ErrorAction SilentlyContinue",
    "  @{ status = 'failed'; message = $failureMessage; at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress | Set-Content -LiteralPath $resultPath -Encoding utf8 -Force -ErrorAction SilentlyContinue",
    '  if (Test-Path -LiteralPath $application) { Start-Process -FilePath $application }',
    '  exit 1',
    '} finally {',
    "  if ($helperPath) { Remove-Item -LiteralPath $helperPath -Force -ErrorAction SilentlyContinue }",
    '}'
  ].join('\r\n')
}

async function waitForInstallerHelper(readyPath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await stat(readyPath)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('更新安装助手未能启动，应用将保持运行')
}

interface LaunchInstallerOptions {
  helperDirectory?: string
  readyPath?: string
  logPath?: string
  resultPath?: string
  timeoutMs?: number
  machineInstallOverride?: boolean
}

export async function launchInstallerAndDelete(
  installerPath: string,
  installDirectory: string,
  options: LaunchInstallerOptions = {}
): Promise<void> {
  const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  const helperDirectory = options.helperDirectory ?? process.env.TEMP ?? dirname(installerPath)
  const nonce = `${process.pid}-${Date.now()}`
  const helperPath = join(helperDirectory, `CodexAccountSwitcher-update-${nonce}.ps1`)
  const launcherPath = join(helperDirectory, `CodexAccountSwitcher-launch-${nonce}.ps1`)
  const readyPath = options.readyPath ?? join(helperDirectory, `CodexAccountSwitcher-update-${nonce}.ready`)
  const logPath = options.logPath ?? join(helperDirectory, 'CodexAccountSwitcher-update.log')
  const resultPath = options.resultPath ?? getInstallerResultPath()
  await mkdir(helperDirectory, { recursive: true })
  await Promise.all([
    rm(readyPath, { force: true }),
    rm(resultPath, { force: true }),
    rm(helperPath, { force: true }),
    rm(launcherPath, { force: true })
  ])
  const script = buildInstallAndCleanupScript(
    installerPath,
    installDirectory,
    readyPath,
    logPath,
    resultPath,
    options.machineInstallOverride,
    helperPath
  )
  // The BOM keeps non-ASCII paths and diagnostics intact in Windows PowerShell 5.1.
  await writeFile(helperPath, `\uFEFF${script}`, 'utf8')
  const quotedHelperPath = `"${helperPath}"`.replaceAll("'", "''")
  const escapedPowerShell = powershell.replaceAll("'", "''")
  const launcherScript = [
    "$ErrorActionPreference = 'Stop'",
    `$arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', '${quotedHelperPath}')`,
    `Start-Process -FilePath '${escapedPowerShell}' -ArgumentList $arguments -WindowStyle Hidden`
  ].join('\r\n')
  await writeFile(launcherPath, `\uFEFF${launcherScript}`, 'utf8')
  const launcher = spawn(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      launcherPath
    ],
    { windowsHide: true, stdio: 'ignore' }
  )
  const launcherExit = new Promise<void>((resolve, reject) => {
    launcher.once('error', (error) => reject(error))
    launcher.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(
        `更新安装启动器退出（${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}）`
      ))
    })
  })
  let launcherTimeout: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      launcherExit,
      new Promise<never>((_resolve, reject) => {
        launcherTimeout = setTimeout(
          () => reject(new Error('更新安装启动器超时')),
          options.timeoutMs ?? 10_000
        )
      })
    ])
    if (launcherTimeout) clearTimeout(launcherTimeout)
    await rm(launcherPath, { force: true })
    await waitForInstallerHelper(readyPath, options.timeoutMs ?? 10_000)
    await rm(readyPath, { force: true })
  } catch (error) {
    if (launcherTimeout) clearTimeout(launcherTimeout)
    await Promise.all([
      rm(helperPath, { force: true }),
      rm(launcherPath, { force: true }),
      rm(readyPath, { force: true })
    ])
    const detail = error instanceof Error ? error.message : '未知错误'
    throw new Error(`${detail}；请查看日志 ${logPath}，应用将保持运行`)
  }
}

export async function consumeInstallerResult(resultPath = getInstallerResultPath()): Promise<InstallerResult | null> {
  let raw: string
  try {
    raw = await readFile(resultPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  await rm(resultPath, { force: true })
  try {
    const value = JSON.parse(raw.replace(/^\uFEFF/, '')) as Partial<InstallerResult>
    if (
      (value.status === 'succeeded' || value.status === 'failed') &&
      typeof value.message === 'string' &&
      typeof value.at === 'string'
    ) {
      return { status: value.status, message: value.message, at: value.at }
    }
  } catch {
    // Ignore a truncated result file; the diagnostic log remains available.
  }
  return null
}

export async function cleanupLegacyUpdateCache(localAppData: string | undefined): Promise<void> {
  if (!localAppData) return
  await rm(`${localAppData}\\codex-account-switcher-updater\\pending`, {
    recursive: true,
    force: true
  })
}
