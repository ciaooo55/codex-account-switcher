import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverCodexDirectory, normalizeSelectedCodexDirectory } from './codex-paths'

describe('Codex path discovery', () => {
  it('prefers CODEX_HOME with credentials over stale configured paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-paths-'))
    const codexHome = join(root, 'custom-codex')
    await mkdir(codexHome, { recursive: true })
    await writeFile(join(codexHome, 'auth.json'), '{}')

    await expect(discoverCodexDirectory({
      homeDirectory: root,
      configuredAuthPath: join(root, 'missing', 'auth.json'),
      configuredConfigPath: join(root, 'missing', 'config.toml'),
      environment: { CODEX_HOME: codexHome }
    })).resolves.toBe(codexHome)
  })

  it('accepts an existing .codex directory before auth.json has been created', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-paths-empty-'))
    const codexHome = join(root, '.codex')
    await mkdir(codexHome)

    await expect(discoverCodexDirectory({
      homeDirectory: root,
      configuredAuthPath: join(root, 'stale', 'auth.json'),
      configuredConfigPath: join(root, 'stale', 'config.toml'),
      environment: {}
    })).resolves.toBe(codexHome)
  })

  it('uses a .codex child when the user selects its parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-paths-select-'))
    const codexHome = join(root, '.codex')
    await mkdir(codexHome)
    await expect(normalizeSelectedCodexDirectory(root)).resolves.toBe(codexHome)
  })
})
