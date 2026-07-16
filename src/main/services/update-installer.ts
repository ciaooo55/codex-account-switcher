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

export function buildInstallAndCleanupScript(installerPath: string): string {
  const escapedPath = installerPath.replaceAll("'", "''")
  return [
    "$ErrorActionPreference = 'Stop'",
    `$installer = '${escapedPath}'`,
    'try {',
    "  $process = Start-Process -FilePath $installer -ArgumentList '/S' -PassThru",
    '  $process.WaitForExit()',
    '} finally {',
    '  Start-Sleep -Seconds 2',
    '  Remove-Item -LiteralPath $installer -Force -ErrorAction SilentlyContinue',
    '}'
  ].join('; ')
}

export function launchInstallerAndDelete(installerPath: string): void {
  const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  const encodedCommand = Buffer.from(
    buildInstallAndCleanupScript(installerPath),
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
