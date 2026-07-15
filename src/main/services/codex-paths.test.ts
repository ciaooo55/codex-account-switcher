import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  discoverCodexDirectory,
  discoverCodexPaths,
  normalizeSelectedCodexDirectory
} from './codex-paths'

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

  it('creates a missing explicit CODEX_HOME instead of falling back elsewhere', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-paths-env-'))
    const codexHome = join(root, 'not-created-yet')

    await expect(discoverCodexPaths({
      homeDirectory: root,
      configuredAuthPath: join(root, 'stale', 'auth.json'),
      configuredConfigPath: join(root, 'stale', 'config.toml'),
      environment: { CODEX_HOME: codexHome }
    })).resolves.toEqual({
      authPath: join(codexHome, 'auth.json'),
      configPath: join(codexHome, 'config.toml')
    })
  })

  it('keeps a saved empty custom directory before auth.json is created', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-paths-configured-'))
    const configured = join(root, 'custom-location')
    const fallback = join(root, '.codex')
    await Promise.all([mkdir(configured), mkdir(fallback)])

    await expect(discoverCodexPaths({
      homeDirectory: root,
      configuredAuthPath: join(configured, 'auth.json'),
      configuredConfigPath: join(configured, 'config.toml'),
      environment: {}
    })).resolves.toEqual({
      authPath: join(configured, 'auth.json'),
      configPath: join(configured, 'config.toml')
    })
  })

  it('preserves configured auth and config paths in separate existing directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-paths-split-'))
    const authDirectory = join(root, 'auth-home')
    const configDirectory = join(root, 'config-home')
    await Promise.all([mkdir(authDirectory), mkdir(configDirectory)])
    const options = {
      homeDirectory: root,
      configuredAuthPath: join(authDirectory, 'auth.json'),
      configuredConfigPath: join(configDirectory, 'config.toml'),
      environment: {}
    }

    await expect(discoverCodexPaths(options)).resolves.toEqual({
      authPath: join(authDirectory, 'auth.json'),
      configPath: join(configDirectory, 'config.toml')
    })
    await expect(discoverCodexDirectory(options)).resolves.toBeNull()
  })

  it('uses a .codex child when the user selects its parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-paths-select-'))
    const codexHome = join(root, '.codex')
    await mkdir(codexHome)
    await expect(normalizeSelectedCodexDirectory(root)).resolves.toBe(codexHome)
  })
})
