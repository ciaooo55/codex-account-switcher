import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildInstallAndCleanupScript,
  cleanupLegacyUpdateCache,
  consumeInstallerResult,
  downloadInstaller,
  launchInstallerAndDelete
} from './update-installer'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  })))
})

describe('update installer', () => {
  it('downloads directly to the selected path and verifies sha512', async () => {
    const root = await mkdtemp(join(tmpdir(), 'switcher-update-'))
    roots.push(root)
    const content = Buffer.from('verified installer')
    const targetPath = join(root, 'Downloads', 'setup.exe')
    const progress: number[] = []

    await downloadInstaller({
      url: 'https://updates.test/setup.exe',
      targetPath,
      expectedSha512: createHash('sha512').update(content).digest('base64'),
      fetch: async () => new Response(content) as unknown as never,
      onProgress: (value) => progress.push(value)
    })

    expect(await readFile(targetPath)).toEqual(content)
    expect(progress.at(-1)).toBe(100)
  })

  it('deletes a download whose checksum does not match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'switcher-update-'))
    roots.push(root)
    const targetPath = join(root, 'setup.exe')

    await expect(downloadInstaller({
      url: 'https://updates.test/setup.exe',
      targetPath,
      expectedSha512: 'invalid',
      fetch: async () => new Response('tampered') as unknown as never
    })).rejects.toThrow('校验失败')
    await expect(readFile(targetPath)).rejects.toThrow()
  })

  it('builds a silent install command with handshake, result reporting, cleanup and restart', () => {
    const script = buildInstallAndCleanupScript(
      "D:\\Profiles\\Example User\\Downloads\\it's-setup.exe",
      'E:\\Apps\\Codex Account Switcher',
      'D:\\Profiles\\Example User\\Downloads\\update.ready',
      'D:\\Profiles\\Example User\\update.log',
      'D:\\Profiles\\Example User\\update-result.json'
    )
    expect(script).toContain("$installer = 'D:\\Profiles\\Example User\\Downloads\\it''s-setup.exe'")
    expect(script).toContain("$installDirectory = 'E:\\Apps\\Codex Account Switcher'")
    expect(script).toContain("$application = Join-Path $installDirectory 'Codex Account Switcher.exe'")
    expect(script).toContain('[StringComparer]::OrdinalIgnoreCase.Equals($_.ExecutablePath, $application)')
    expect(script).toContain('Stop-Process -Id $_.ProcessId')
    expect(script).toContain('$userMatch = Test-SamePath $userLocation $installDirectory')
    expect(script).toContain('$machineMatch = Test-SamePath $machineLocation $installDirectory')
    expect(script).toContain("ArgumentList = @('/S', $installModeArgument)")
    expect(script).not.toContain('/D=')
    expect(script).toContain("$start['Verb'] = 'RunAs'")
    expect(script).toContain('Installer exited with code')
    expect(script).toContain('Remove-Item -LiteralPath $installer')
    expect(script).toContain("status = 'succeeded'")
    expect(script).toContain("status = 'failed'")
    expect(script).toContain('Start-Process -FilePath $application')
    expect(script).toContain('Remove-Item -LiteralPath $helperPath')
  })

  it.runIf(process.platform === 'win32')('produces a script accepted by Windows PowerShell', async () => {
    const script = buildInstallAndCleanupScript(
      "D:\\Profiles\\Example User\\Downloads\\it's-setup.exe",
      'E:\\Apps\\Codex Account Switcher'
    )
    const root = await mkdtemp(join(tmpdir(), 'switcher-update-parser-'))
    roots.push(root)
    const scriptPath = join(root, 'update.ps1')
    await writeFile(scriptPath, script, 'utf8')
    const escapedScriptPath = scriptPath.replaceAll("'", "''")
    const parserCommand = [
      `$source = [IO.File]::ReadAllText('${escapedScriptPath}')`,
      '$tokens = $null',
      '$errors = $null',
      '[System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors) | Out-Null',
      'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }'
    ].join('; ')
    const encodedParserCommand = Buffer.from(parserCommand, 'utf16le').toString('base64')
    const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`

    expect(() => execFileSync(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodedParserCommand
    ], { stdio: 'pipe' })).not.toThrow()
  })

  it.runIf(process.platform === 'win32')('completes the detached install script lifecycle in a temporary directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'switcher-update-integration-'))
    roots.push(root)
    const installDirectory = join(root, 'Installed App')
    const installerPath = join(root, 'Downloaded Setup.exe')
    const applicationPath = join(installDirectory, 'Codex Account Switcher.exe')
    const readyPath = join(root, 'update.ready')
    const logPath = join(root, 'update.log')
    const resultPath = join(root, 'update-result.json')
    const receivedArgumentsPath = join(root, 'received-args.txt')
    const sourcePath = join(root, 'Noop.cs')
    await mkdir(installDirectory, { recursive: true })
    await writeFile(
      sourcePath,
      'using System; using System.IO; public static class Program { public static int Main(string[] args) { File.WriteAllLines(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "received-args.txt"), args); return 0; } }',
      'ascii'
    )
    const compiler = `${process.env.SystemRoot ?? 'C:\\Windows'}\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe`
    execFileSync(compiler, ['/nologo', '/target:winexe', `/out:${installerPath}`, sourcePath], { stdio: 'pipe' })
    await copyFile(installerPath, applicationPath)

    await launchInstallerAndDelete(installerPath, installDirectory, {
      helperDirectory: root,
      readyPath,
      logPath,
      resultPath,
      timeoutMs: 10_000
    })

    let installerResult: Awaited<ReturnType<typeof consumeInstallerResult>> = null
    const resultDeadline = Date.now() + 15_000
    while (!installerResult && Date.now() < resultDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      installerResult = await consumeInstallerResult(resultPath)
    }

    await expect(stat(installerPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(applicationPath)).resolves.toBeDefined()
    await expect(stat(readyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(installerResult).toMatchObject({
      status: 'succeeded',
      message: '更新安装成功'
    })
    await expect(readFile(logPath, 'utf8')).resolves.toContain('Update installed successfully')
    await expect(readFile(receivedArgumentsPath, 'utf8')).resolves.toBe(
      '/S\r\n/currentuser\r\n'
    )
  }, 20_000)

  it('consumes a persisted installer result once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'switcher-update-'))
    roots.push(root)
    const resultPath = join(root, 'result.json')
    await writeFile(resultPath, JSON.stringify({
      status: 'failed',
      message: 'UAC was cancelled',
      at: '2026-07-16T12:00:00.000Z'
    }), 'utf8')

    await expect(consumeInstallerResult(resultPath)).resolves.toEqual({
      status: 'failed',
      message: 'UAC was cancelled',
      at: '2026-07-16T12:00:00.000Z'
    })
    await expect(consumeInstallerResult(resultPath)).resolves.toBeNull()
  })

  it('cleans only the legacy pending update directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'switcher-update-'))
    roots.push(root)
    const pending = join(root, 'codex-account-switcher-updater', 'pending')
    await downloadInstaller({
      url: 'https://updates.test/old.exe',
      targetPath: join(pending, 'old.exe'),
      expectedSha512: createHash('sha512').update('old').digest('base64'),
      fetch: async () => new Response('old') as unknown as never
    })

    await cleanupLegacyUpdateCache(root)
    await expect(readFile(join(pending, 'old.exe'))).rejects.toThrow()
  })
})
