import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedCredential, SecretCipher } from '../../shared/types'
import { CredentialSwitcher } from './switcher'

const tempDirs: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const cipher: SecretCipher = {
  encrypt: (plainText) => Buffer.from(plainText).toString('base64'),
  decrypt: (encryptedText) => Buffer.from(encryptedText, 'base64').toString('utf8')
}

function credential(overrides: Partial<NormalizedCredential> = {}): NormalizedCredential {
  return {
    id: 'account-a',
    email: 'person@example.com',
    accountId: 'workspace-a',
    subject: 'user-a',
    accessToken: 'access-a',
    refreshToken: 'refresh-a',
    idToken: 'id-a',
    authKind: 'oauth',
    planType: 'plus',
    lastRefresh: '2026-07-14T12:00:00Z',
    accessExpiresAt: '2026-10-14T12:00:00Z',
    idExpiresAt: '2026-10-14T12:00:00Z',
    canRefresh: true,
    sourcePath: 'account.json',
    sourceFormat: 'json',
    sourceDialect: 'cpa',
    ...overrides
  }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-switcher-switch-'))
  tempDirs.push(dir)
  const authPath = join(dir, 'auth.json')
  const configPath = join(dir, 'config.toml')
  const backupDir = join(dir, 'backups')
  await writeFile(authPath, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'api-secret' }))
  await writeFile(
    configPath,
    'model_provider = "custom"\nmodel = "custom-model"\n\n[model_providers.custom]\nbase_url = "http://localhost"\n'
  )
  return { dir, authPath, configPath, backupDir }
}

describe('CredentialSwitcher', () => {
    it('switches to a custom API key provider and keeps unrelated provider definitions', async () => {
    const paths = await fixture()
    const switcher = new CredentialSwitcher({
      ...paths,
      cipher,
      backupRetention: 20,
      fetchModels: async () => ['grok-4.5', 'gpt-custom', 'mimo-v2.5-pro'],
      probeModel: async () => ({ endpoint: 'responses' as const, output: 'hi there' })
    })
    const historyPath = join(paths.dir, 'sessions', 'rollout-history.jsonl')
    const history = '{"type":"session_meta","payload":{"model_provider":"openai"}}\n'
    await mkdir(join(paths.dir, 'sessions'))
    await writeFile(historyPath, history)

    const result = await switcher.switchToCustomApi({
      baseUrl: 'http://127.0.0.1:18317',
      model: 'gpt-custom',
      apiKey: 'custom-secret-key'
    })

    expect(result.ok).toBe(true)
    expect(result.message).toContain('发送 hi')
    expect(result.message).toContain('模型返回“hi there”')
    expect(result.catalogModels).toEqual(['gpt-custom', 'grok-4.5', 'mimo-v2.5-pro'])
    expect(JSON.parse(await readFile(paths.authPath, 'utf8'))).toEqual({
      auth_mode: 'apikey',
      OPENAI_API_KEY: 'custom-secret-key'
    })
    const config = await readFile(paths.configPath, 'utf8')
    expect(config).toContain('model_provider = "codex_account_switcher"')
    expect(config).not.toMatch(/^openai_base_url\s*=/m)
    expect(config).toContain(
      `model_catalog_json = ${JSON.stringify(join(paths.dir, 'account-switcher-model-catalog.json'))}`
    )
    expect(config).toContain('[model_providers.codex_account_switcher]')
    expect(config).toContain('base_url = "http://127.0.0.1:18317/v1"')
    expect(config).toContain('wire_api = "responses"')
    expect(config).toContain('experimental_bearer_token = "custom-secret-key"')
    expect(config).toContain('supports_websockets = false')
    expect(config).toContain('[model_providers.custom]')
    const catalog = JSON.parse(await readFile(join(paths.dir, 'account-switcher-model-catalog.json'), 'utf8'))
    expect(catalog.models.map((entry: { slug: string }) => entry.slug)).toEqual([
      'gpt-custom',
      'grok-4.5',
      'mimo-v2.5-pro'
    ])
    expect(catalog.models.every((entry: { base_instructions?: string }) => Boolean(entry.base_instructions))).toBe(true)
    expect(await readFile(historyPath, 'utf8')).toBe(history)
    expect(await readFile(result.backupPath!, 'utf8')).not.toContain('api-secret')
  })

  it('tests the filled model first, then fetches the remote model list', async () => {
    const paths = await fixture()
    const order: string[] = []
    const switcher = new CredentialSwitcher({
      ...paths,
      cipher,
      backupRetention: 20,
      probeModel: async () => {
        order.push('probe')
        return { endpoint: 'responses' as const, baseUrl: 'http://127.0.0.1:18317/v1', probeUrl: 'http://127.0.0.1:18317/v1/responses', output: 'hello' }
      },
      fetchModels: async () => {
        order.push('fetch')
        return ['listed-a', 'listed-b', 'filled-model']
      }
    })

    const result = await switcher.switchToCustomApi({
      baseUrl: 'http://127.0.0.1:18317',
      model: 'filled-model',
      apiKey: 'custom-secret-key'
    })

    expect(result.ok).toBe(true)
    expect(order).toEqual(['probe', 'fetch'])
    expect(result.selectedModel).toBe('filled-model')
    expect(result.remoteModels).toEqual(['listed-a', 'listed-b', 'filled-model'])
    expect(result.message).toContain('发送 hi')
    expect(result.message).toContain('模型返回“hello”')
    const config = await readFile(paths.configPath, 'utf8')
    expect(config).toContain('model = "filled-model"')
    expect(config).toContain('model_provider = "codex_account_switcher"')
  })

  it('keeps the Responses-tested base when the models endpoint is found on another prefix', async () => {
    const paths = await fixture()
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === 'http://127.0.0.1:18371/openai/models') {
        return new Response(JSON.stringify({ data: [{ id: 'real-model' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response('{}', { status: 404 })
    }))
    const switcher = new CredentialSwitcher({
      ...paths,
      cipher,
      backupRetention: 20
    })

    const result = await switcher.switchToCustomApi({
      baseUrl: 'http://127.0.0.1:18371/openai/v1',
      model: 'real-model',
      apiKey: 'custom-secret-key',
      verifiedProbe: {
        endpoint: 'responses',
        baseUrl: 'http://127.0.0.1:18371/openai/v1',
        probeUrl: 'http://127.0.0.1:18371/openai/v1/responses',
        output: 'working response'
      }
    })

    expect(result).toMatchObject({
      ok: true,
      discoveredBaseUrl: 'http://127.0.0.1:18371/openai/v1'
    })
    const config = await readFile(paths.configPath, 'utf8')
    expect(config).toContain('base_url = "http://127.0.0.1:18371/openai/v1"')
    expect(config).not.toContain('base_url = "http://127.0.0.1:18371/openai"')
  })

  it('writes the user-edited model list without re-adding removed upstream models', async () => {
    const paths = await fixture()
    const switcher = new CredentialSwitcher({
      ...paths,
      cipher,
      backupRetention: 20,
      probeModel: async () => ({ endpoint: 'responses' as const, output: 'hello edited list' }),
      fetchModels: async () => ['remote-a', 'remote-b', 'remote-c']
    })

    const result = await switcher.switchToCustomApi({
      baseUrl: 'http://127.0.0.1:18317/v1',
      model: 'remote-b',
      apiKey: 'custom-secret-key',
      models: ['remote-b', 'manual-model']
    })

    expect(result).toMatchObject({
      ok: true,
      catalogModels: ['remote-b', 'manual-model'],
      remoteModels: ['remote-a', 'remote-b', 'remote-c']
    })
    const catalog = JSON.parse(await readFile(join(paths.dir, 'account-switcher-model-catalog.json'), 'utf8'))
    expect(catalog.models.map((entry: { slug: string }) => entry.slug)).toEqual(['remote-b', 'manual-model'])
  })

  it('rejects an explicit list that omits the selected model without changing files', async () => {
    const paths = await fixture()
    const previousConfig = await readFile(paths.configPath, 'utf8')
    const switcher = new CredentialSwitcher({
      ...paths,
      cipher,
      backupRetention: 20,
      probeModel: async () => ({ endpoint: 'responses' as const, output: 'hello' }),
      fetchModels: async () => ['selected-model', 'manual-model']
    })

    const result = await switcher.switchToCustomApi({
      baseUrl: 'http://127.0.0.1:18317/v1',
      model: 'selected-model',
      apiKey: 'custom-secret-key',
      models: ['manual-model']
    })

    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain('不会自动添加未明确输入的模型')
    expect(await readFile(paths.configPath, 'utf8')).toBe(previousConfig)
    await expect(readFile(join(paths.dir, 'account-switcher-model-catalog.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes the real upstream URL, key, and model IDs into Codex', async () => {
    const paths = await fixture()
    const switcher = new CredentialSwitcher({
      ...paths,
      cipher,
      backupRetention: 20,
      probeModel: async () => ({ endpoint: 'responses' as const, output: 'upstream test passed' }),
      fetchModels: async () => ['deepseek-v4-pro', 'qwen3-coder']
    })

    const result = await switcher.switchToCustomApi({
      baseUrl: 'https://provider.example/v1',
      model: 'deepseek-v4-pro',
      apiKey: 'upstream-secret'
    })

    expect(result).toMatchObject({
      ok: true,
      selectedModel: 'deepseek-v4-pro',
      catalogModels: ['deepseek-v4-pro', 'qwen3-coder']
    })
    const config = await readFile(paths.configPath, 'utf8')
    expect(config).toContain('model = "deepseek-v4-pro"')
    expect(config).toContain('base_url = "https://provider.example/v1"')
    expect(config).toContain('experimental_bearer_token = "upstream-secret"')
    expect(config).not.toContain('127.0.0.1:45678')
    const catalog = JSON.parse(await readFile(join(paths.dir, 'account-switcher-model-catalog.json'), 'utf8'))
    expect(catalog.models.map((entry: { slug: string }) => entry.slug)).toEqual([
      'deepseek-v4-pro',
      'qwen3-coder'
    ])
  })

  it('does not write a model catalog when the user only switches the provider', async () => {
    const paths = await fixture()
    const switcher = new CredentialSwitcher({
      ...paths,
      cipher,
      backupRetention: 20,
      probeModel: async () => ({ endpoint: 'responses' as const, output: 'hello' }),
      fetchModels: async () => ['remote-a']
    })

    const result = await switcher.switchToCustomApi({
      baseUrl: 'http://127.0.0.1:18317/v1',
      model: 'remote-a',
      apiKey: 'custom-secret-key',
      syncModelCatalog: false
    })

    expect(result).toMatchObject({ ok: true, catalogModels: [] })
    expect(result.message).toContain('未导入模型目录')
    expect(await readFile(paths.configPath, 'utf8')).not.toMatch(/^model_catalog_json\s*=/m)
    await expect(readFile(join(paths.dir, 'account-switcher-model-catalog.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects empty model before probing or fetching', async () => {
    const paths = await fixture()
    const switcher = new CredentialSwitcher({
      ...paths,
      cipher,
      backupRetention: 20,
      probeModel: async () => {
        throw new Error('should not probe')
      },
      fetchModels: async () => {
        throw new Error('should not fetch')
      }
    })

    const result = await switcher.switchToCustomApi({
      baseUrl: 'http://127.0.0.1:18317',
      model: '',
      apiKey: 'custom-secret-key'
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('请先选择要进行真实测试的模型')
  })

  it('still saves after probe when model list fetch fails', async () => {
    const paths = await fixture()
    const switcher = new CredentialSwitcher({
      ...paths,
      cipher,
      backupRetention: 20,
      fetchModels: async () => {
        throw new Error('network down')
      },
      probeModel: async () => ({
        endpoint: 'responses' as const,
        baseUrl: 'http://127.0.0.1:18317/v1',
        probeUrl: 'http://127.0.0.1:18317/v1/responses',
        output: 'hello from model'
      })
    })

    const result = await switcher.switchToCustomApi({
      baseUrl: 'http://127.0.0.1:18317/v1',
      model: 'grok-4.5',
      apiKey: 'custom-secret-key'
    })

    expect(result.ok).toBe(true)
    expect(result.message).toContain('发送 hi')
    expect(result.message).toContain('上游模型列表为空')
    const config = await readFile(paths.configPath, 'utf8')
    expect(config).toContain('model = "grok-4.5"')
    expect(config).toContain(
      `model_catalog_json = ${JSON.stringify(join(paths.dir, 'account-switcher-model-catalog.json'))}`
    )
    expect(config).toContain('[model_providers.codex_account_switcher]')
  })

  it('does not save config when model probe fails', async () => {
    const paths = await fixture()
    const previousAuth = await readFile(paths.authPath, 'utf8')
    const previousConfig = await readFile(paths.configPath, 'utf8')
    const switcher = new CredentialSwitcher({
      ...paths,
      cipher,
      backupRetention: 20,
      fetchModels: async () => ['grok-4.5'],
      probeModel: async () => {
        throw new Error('模型测试失败（/responses HTTP 401）：invalid api key')
      }
    })

    const result = await switcher.switchToCustomApi({
      baseUrl: 'http://127.0.0.1:18317/v1',
      model: 'grok-4.5',
      apiKey: 'bad-key'
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('测试未通过')
    expect(result.message).toContain('invalid api key')
    expect(await readFile(paths.authPath, 'utf8')).toBe(previousAuth)
    expect(await readFile(paths.configPath, 'utf8')).toBe(previousConfig)
  })

  it('allows an explicitly confirmed forced switch and keeps the failed-probe warning', async () => {
    const paths = await fixture()
    const probeModel = vi.fn()
    const switcher = new CredentialSwitcher({
      ...paths,
      cipher,
      backupRetention: 20,
      probeModel,
      fetchModels: async () => []
    })

    const result = await switcher.switchToCustomApi({
      baseUrl: 'http://127.0.0.1:18317/v1',
      model: 'manual-model',
      models: ['manual-model'],
      apiKey: 'custom-secret-key',
      forceProbeFailure: 'HTTP 503 upstream unavailable'
    })

    expect(result).toMatchObject({
      ok: true,
      warning: 'HTTP 503 upstream unavailable',
      catalogModels: ['manual-model']
    })
    expect(result.message).toContain('已按用户确认强制切换')
    expect(probeModel).not.toHaveBeenCalled()
  })

  it('atomically writes ChatGPT auth, patches config and keeps encrypted backups', async () => {
    const paths = await fixture()
    const switcher = new CredentialSwitcher({ ...paths, cipher, backupRetention: 20 })

    const result = await switcher.switchTo(credential())

    expect(result.ok).toBe(true)
    expect(JSON.parse(await readFile(paths.authPath, 'utf8'))).toEqual({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: 'id-a',
        access_token: 'access-a',
        refresh_token: 'refresh-a',
        account_id: 'workspace-a'
      },
      last_refresh: '2026-07-14T12:00:00Z'
    })
    expect(await readFile(paths.configPath, 'utf8')).toContain('model_provider = "openai"')
    const backupRaw = await readFile(result.backupPath!, 'utf8')
    expect(backupRaw).not.toContain('api-secret')
  })

  it('removes the managed catalog for ChatGPT and restores it with the API backup', async () => {
    const paths = await fixture()
    const switcher = new CredentialSwitcher({
      ...paths,
      cipher,
      backupRetention: 20,
      probeModel: async () => ({ endpoint: 'responses' as const, output: 'hello' }),
      fetchModels: async () => ['model-a', 'model-b']
    })
    const catalogPath = join(paths.dir, 'account-switcher-model-catalog.json')

    expect((await switcher.switchToCustomApi({
      baseUrl: 'http://127.0.0.1:18317/v1',
      model: 'model-a',
      models: ['model-a', 'model-b'],
      apiKey: 'custom-secret-key'
    })).ok).toBe(true)
    const apiCatalog = await readFile(catalogPath, 'utf8')

    expect((await switcher.switchTo(credential())).ok).toBe(true)
    await expect(readFile(catalogPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(paths.configPath, 'utf8')).not.toMatch(/^model_catalog_json\s*=/m)

    expect((await switcher.restoreLatest()).ok).toBe(true)
    expect(await readFile(catalogPath, 'utf8')).toBe(apiCatalog)
    expect(await readFile(paths.configPath, 'utf8')).toContain(
      `model_catalog_json = ${JSON.stringify(catalogPath)}`
    )
  })

  it('creates auth.json when the discovered .codex directory does not have one yet', async () => {
    const paths = await fixture()
    await rm(paths.authPath)
    const switcher = new CredentialSwitcher({ ...paths, cipher, backupRetention: 20 })

    const result = await switcher.switchTo(credential())

    expect(result.ok).toBe(true)
    expect(JSON.parse(await readFile(paths.authPath, 'utf8'))).toMatchObject({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'access-a' }
    })
  })

  it('writes the official persisted auth shape for a personal access token', async () => {
    const paths = await fixture()
    const switcher = new CredentialSwitcher({ ...paths, cipher, backupRetention: 20 })

    const result = await switcher.switchTo(credential({
      accessToken: 'at-personal-token',
      authKind: 'personal_access_token',
      refreshToken: null,
      idToken: null,
      canRefresh: false,
      planType: 'team'
    }))

    expect(result).toMatchObject({ ok: true })
    expect(result.message).toContain('Personal Access Token')
    expect(JSON.parse(await readFile(paths.authPath, 'utf8'))).toEqual({
      OPENAI_API_KEY: null,
      personal_access_token: 'at-personal-token'
    })
  })

  it('writes CPA Team/K12 access-only credentials in file-backed ChatGPT mode', async () => {
    const paths = await fixture()
    const switcher = new CredentialSwitcher({ ...paths, cipher, backupRetention: 20 })

    const result = await switcher.switchTo(
      credential({
        idToken: null,
        refreshToken: null,
        canRefresh: false,
        planType: 'k12'
      })
    )

    expect(result).toMatchObject({ ok: true })
    expect(result.message).toContain('重启 Codex')
    expect(JSON.parse(await readFile(paths.authPath, 'utf8'))).toEqual({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: 'access-a',
        access_token: 'access-a',
        refresh_token: '',
        account_id: 'workspace-a'
      },
      last_refresh: '2026-07-14T12:00:00Z'
    })
    expect(await readFile(paths.configPath, 'utf8')).toContain('model_provider = "openai"')
  })

  it('rejects access-only credentials without an account id and restores prior config', async () => {
    const paths = await fixture()
    const switcher = new CredentialSwitcher({ ...paths, cipher, backupRetention: 20 })

    const result = await switcher.switchTo(
      credential({
        accountId: null,
        idToken: null,
        refreshToken: null,
        canRefresh: false
      })
    )

    expect(result).toMatchObject({ ok: false })
    expect(result.message).toContain('workspace ID')
    expect(JSON.parse(await readFile(paths.authPath, 'utf8')).auth_mode).toBe('apikey')
    expect(await readFile(paths.configPath, 'utf8')).toContain('model_provider = "custom"')
  })

  it('rolls back auth and config when post-write validation fails', async () => {
    const paths = await fixture()
    const validate = vi.fn().mockResolvedValue(false)
    const switcher = new CredentialSwitcher({
      ...paths,
      cipher,
      backupRetention: 20,
      validate
    })

    const result = await switcher.switchTo(credential())

    expect(result.ok).toBe(false)
    expect(JSON.parse(await readFile(paths.authPath, 'utf8')).auth_mode).toBe('apikey')
    expect(await readFile(paths.configPath, 'utf8')).toContain('model_provider = "custom"')
  })

  it('restores the latest API/proxy configuration without losing unrelated later config edits', async () => {
    const paths = await fixture()
    const switcher = new CredentialSwitcher({ ...paths, cipher, backupRetention: 20 })
    await switcher.switchTo(credential())
    await writeFile(
      paths.configPath,
      `${await readFile(paths.configPath, 'utf8')}\n[features]\ngoals = false\n`
    )

    const restored = await switcher.restoreLatest()

    expect(restored.ok).toBe(true)
    expect(JSON.parse(await readFile(paths.authPath, 'utf8')).auth_mode).toBe('apikey')
    expect(await readFile(paths.configPath, 'utf8')).toContain('model_provider = "custom"')
    expect(await readFile(paths.configPath, 'utf8')).toContain('goals = false')
  })

  it('restores the most recent API mode even after multiple ChatGPT account switches', async () => {
    const paths = await fixture()
    const switcher = new CredentialSwitcher({ ...paths, cipher, backupRetention: 20 })
    await switcher.switchTo(credential())
    await switcher.switchTo(credential({ id: 'account-b', accessToken: 'access-b' }))

    const restored = await switcher.restoreApiMode()

    expect(restored.ok).toBe(true)
    expect(JSON.parse(await readFile(paths.authPath, 'utf8'))).toMatchObject({
      auth_mode: 'apikey',
      OPENAI_API_KEY: 'api-secret'
    })
    expect(await readFile(paths.configPath, 'utf8')).toContain('model_provider = "custom"')
  })

  it('skips external Team credentials when restoring the original API mode', async () => {
    const paths = await fixture()
    const switcher = new CredentialSwitcher({ ...paths, cipher, backupRetention: 20 })
    await switcher.switchTo(credential())
    await switcher.switchTo(credential({
      id: 'account-team',
      accessToken: 'access-team',
      idToken: null,
      refreshToken: null,
      canRefresh: false,
      planType: 'k12'
    }))
    await switcher.switchTo(credential({ id: 'account-b', accessToken: 'access-b' }))

    const restored = await switcher.restoreApiMode()

    expect(restored.ok).toBe(true)
    expect(JSON.parse(await readFile(paths.authPath, 'utf8'))).toMatchObject({
      auth_mode: 'apikey',
      OPENAI_API_KEY: 'api-secret'
    })
    expect(await readFile(paths.configPath, 'utf8')).toContain('model_provider = "custom"')
  })
})
