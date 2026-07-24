import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureDirectCustomApiProvider,
  reassertDirectCustomApiProviderAfterStart,
  type EnsureDirectCustomApiProviderResult
} from './direct-custom-api'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(config: string, auth = '{}\n') {
  const root = await mkdtemp(join(tmpdir(), 'direct-custom-api-'))
  roots.push(root)
  const configPath = join(root, 'config.toml')
  const authPath = join(root, 'auth.json')
  await writeFile(configPath, config)
  await writeFile(authPath, auth)
  return { root, configPath, authPath }
}

function managedCatalog(models: Array<{ slug: string; display_name?: string }>): string {
  return `${JSON.stringify({ models }, null, 2)}\n`
}

describe('direct custom API startup reconciliation', () => {
  it('migrates a positively identified legacy gateway port and shell catalog to real IDs', async () => {
    const paths = await fixture(`model_provider = "codex_account_switcher"
model = "gpt-5.6-sol"
model_catalog_json = "account-switcher-model-catalog.json"

[model_providers.codex_account_switcher]
base_url = "http://127.0.0.1:49152/v1"
wire_api = "responses"
experimental_bearer_token = "cas-gateway-old-token"
`)
    const catalogPath = join(paths.root, 'account-switcher-model-catalog.json')
    await writeFile(catalogPath, managedCatalog([
      { slug: 'gpt-5.6-sol', display_name: 'upstream-model-a' },
      { slug: 'gpt-5.6-terra', display_name: 'upstream-model-b' }
    ]))

    const result = await ensureDirectCustomApiProvider({
      ...paths,
      storedBaseUrl: 'http://127.0.0.1:18371',
      storedModel: 'upstream-model-a',
      apiKey: 'real-upstream-key',
      models: ['upstream-model-a', 'upstream-model-b']
    })

    expect(result).toMatchObject({
      active: true,
      mode: 'migrated-legacy-gateway',
      baseUrl: 'http://127.0.0.1:18371/v1',
      model: 'upstream-model-a',
      configChanged: true,
      catalogChanged: true,
      catalogModels: ['upstream-model-a', 'upstream-model-b']
    })
    const config = await readFile(paths.configPath, 'utf8')
    expect(config).toContain('model = "upstream-model-a"')
    expect(config).toContain('base_url = "http://127.0.0.1:18371/v1"')
    expect(config).toContain('experimental_bearer_token = "real-upstream-key"')
    expect(config).not.toContain('49152')
    expect(config.match(/\[model_providers\.codex_account_switcher\]/g)).toHaveLength(1)
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as { models: Array<{ slug: string }> }
    expect(catalog.models.map((entry) => entry.slug)).toEqual([
      'upstream-model-a',
      'upstream-model-b'
    ])
    expect(JSON.parse(await readFile(paths.authPath, 'utf8'))).toEqual({
      auth_mode: 'apikey',
      OPENAI_API_KEY: 'real-upstream-key'
    })
  })

  it('reasserts top-level fields overwritten by Desktop while preserving the direct URL and port', async () => {
    const paths = await fixture(`model_provider = "openai"
model = "gpt-5.6-sol"
model_catalog_json = "desktop-models.json"

[model_providers.codex_account_switcher]
base_url = "http://127.0.0.1:18371/v1"
wire_api = "responses"
experimental_bearer_token = "real-upstream-key"
`)
    await writeFile(
      join(paths.root, 'account-switcher-model-catalog.json'),
      managedCatalog([{ slug: 'gpt-5.6-sol', display_name: 'upstream-model-a' }])
    )

    const result = await ensureDirectCustomApiProvider({
      ...paths,
      // Deliberately stale: a direct provider section is the URL source of truth.
      storedBaseUrl: 'http://127.0.0.1:29999/v1',
      storedModel: 'upstream-model-a',
      apiKey: 'real-upstream-key',
      models: ['upstream-model-a', 'upstream-model-b']
    })

    expect(result).toMatchObject({
      mode: 'direct',
      baseUrl: 'http://127.0.0.1:18371/v1',
      model: 'upstream-model-a',
      configChanged: true,
      catalogModels: ['upstream-model-a', 'upstream-model-b']
    })
    const config = await readFile(paths.configPath, 'utf8')
    expect(config).toContain('model_provider = "codex_account_switcher"')
    expect(config).toContain('model = "upstream-model-a"')
    expect(config).toContain('base_url = "http://127.0.0.1:18371/v1"')
    expect(config).not.toContain('29999')
  })

  it('does not overwrite an owned section whose token is neither direct nor a legacy gateway token', async () => {
    const original = `model_provider = "openai"

[model_providers.codex_account_switcher]
base_url = "http://127.0.0.1:18371/v1"
experimental_bearer_token = "manually-edited-token"
`
    const paths = await fixture(original)

    const result = await ensureDirectCustomApiProvider({
      ...paths,
      storedBaseUrl: 'http://127.0.0.1:29999/v1',
      storedModel: 'model-a',
      apiKey: 'stored-key',
      models: ['model-a']
    })

    expect(result.mode).toBe('unrecognized')
    expect(await readFile(paths.configPath, 'utf8')).toBe(original)
    expect(await readFile(paths.authPath, 'utf8')).toBe('{}\n')
  })

  it('runs every delayed reassertion so a late Desktop rewrite is repaired by a later pass', async () => {
    const delays: number[] = []
    const calls: number[] = []
    const states = [false, true, false, false]
    const base: EnsureDirectCustomApiProviderResult = {
      active: true,
      mode: 'direct',
      baseUrl: 'http://127.0.0.1:18371/v1',
      model: 'model-a',
      configChanged: false,
      authChanged: false,
      catalogChanged: false,
      catalogModels: ['model-a']
    }
    const reconcile = vi.fn(async () => {
      const index = calls.length
      calls.push(index)
      return { ...base, configChanged: states[index] }
    })

    const result = await reassertDirectCustomApiProviderAfterStart(reconcile, {
      delaysMs: [10, 20, 30, 40],
      sleep: async (milliseconds) => { delays.push(milliseconds) }
    })

    expect(result.attempts).toBe(4)
    expect(reconcile).toHaveBeenCalledTimes(4)
    expect(delays).toEqual([10, 20, 30, 40])
    expect(result.last.configChanged).toBe(false)
  })
})
