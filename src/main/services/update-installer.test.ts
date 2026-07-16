import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildInstallAndCleanupScript,
  cleanupLegacyUpdateCache,
  downloadInstaller
} from './update-installer'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
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

  it('builds a silent install command that removes only the downloaded installer', () => {
    const script = buildInstallAndCleanupScript(
      "D:\\Profiles\\Example User\\Downloads\\it's-setup.exe",
      'E:\\Apps\\Codex Account Switcher'
    )
    expect(script).toContain("$installer = 'D:\\Profiles\\Example User\\Downloads\\it''s-setup.exe'")
    expect(script).toContain("$installDirectory = 'E:\\Apps\\Codex Account Switcher'")
    expect(script).toContain("@('/S', '/allusers'")
    expect(script).toContain("@('/S', '/currentuser'")
    expect(script).toContain("$start['Verb'] = 'RunAs'")
    expect(script).toContain('Installer exited with code')
    expect(script).toContain('Remove-Item -LiteralPath $installer')
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
