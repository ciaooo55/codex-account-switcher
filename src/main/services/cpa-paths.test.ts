import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverCpaDirectory, readCpaAuthDirectoryFromConfig } from './cpa-paths'

describe('CPA path discovery', () => {
  it('reads CLIProxyAPI auth-dir from config.yaml and resolves a relative path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cpa-paths-config-'))
    const authDirectory = join(root, 'auths')
    await mkdir(authDirectory)
    const configPath = join(root, 'config.yaml')
    await writeFile(configPath, 'port: 8317\nauth-dir: "./auths"\n')

    await expect(readCpaAuthDirectoryFromConfig(configPath, root)).resolves.toBe(authDirectory)
    await expect(discoverCpaDirectory({
      homeDirectory: join(root, 'home'),
      configuredDirectory: join(root, 'missing'),
      applicationDirectory: root,
      environment: {}
    })).resolves.toBe(authDirectory)
  })

  it('prefers the explicit CLIProxyAPI auth environment variable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cpa-paths-env-'))
    const fromEnvironment = join(root, 'from-env')
    const configured = join(root, 'configured')
    await Promise.all([mkdir(fromEnvironment), mkdir(configured)])

    await expect(discoverCpaDirectory({
      homeDirectory: root,
      configuredDirectory: configured,
      environment: { CLI_PROXY_AUTH_DIR: fromEnvironment }
    })).resolves.toBe(fromEnvironment)
  })

  it('expands the CLIProxyAPI default home shorthand', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cpa-paths-home-'))
    const authDirectory = join(root, '.cli-proxy-api')
    await mkdir(authDirectory)
    const configPath = join(root, 'config.yaml')
    await writeFile(configPath, 'auth-dir: ~/.cli-proxy-api\n')

    await expect(readCpaAuthDirectoryFromConfig(configPath, root)).resolves.toBe(authDirectory)
  })
})
