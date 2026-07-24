import { describe, expect, it } from 'vitest'
import {
  applyChatGptConfig,
  applyCustomApiConfig,
  readActiveOwnedProviderConfig,
  replaceOwnedProviderBaseUrl,
  restoreManagedConfig
} from './config'

const customConfig = `model_provider = "custom"
notify = ["tool.exe"]
model = "gpt-5.6-sol"
model_reasoning_effort = "xhigh"
openai_base_url = "https://old.example.com/v1"
model_catalog_json = "C:\\\\old\\\\catalog.json"

[model_providers.custom]
name = "custom"
requires_openai_auth = true
base_url = "http://127.0.0.1:18317/v1"
experimental_bearer_token = "secret-provider-token"

[features]
goals = true
`

const managedCatalogPath = 'C:\\Users\\tester\\.codex\\account-switcher-model-catalog.json'
const managedCatalogLine = `model_catalog_json = ${JSON.stringify(managedCatalogPath)}`

describe('managed Codex config patching', () => {
  it('uses a dedicated Responses provider and installs the managed Cockpit-style catalog', () => {
    const applied = applyCustomApiConfig(customConfig, {
      baseUrl: 'http://127.0.0.1:18317',
      model: 'gpt-custom',
      apiKey: 'sk-custom',
      modelCatalogPath: managedCatalogPath
    })

    expect(applied.text).toContain('model_provider = "codex_account_switcher"')
    expect(applied.text).toContain('model = "gpt-custom"')
    expect(applied.text).not.toMatch(/^openai_base_url\s*=/m)
    expect(applied.text).toContain(managedCatalogLine)
    expect(applied.text).toContain('[model_providers.codex_account_switcher]')
    expect(applied.text).toContain('base_url = "http://127.0.0.1:18317/v1"')
    expect(applied.text).toContain('wire_api = "responses"')
    expect(applied.text).toContain('requires_openai_auth = true')
    expect(applied.text).toContain('experimental_bearer_token = "sk-custom"')
    expect(applied.text).toContain('supports_websockets = false')
    expect(applied.text).toContain('[model_providers.custom]')
    expect(applied.snapshot.model_provider).toBe('model_provider = "custom"')
    expect(applied.snapshot.model_catalog_json).toBe('model_catalog_json = "C:\\\\old\\\\catalog.json"')
  })

  it('installs an absolute managed catalog path for direct third-party APIs', () => {
    const applied = applyCustomApiConfig(customConfig, {
      baseUrl: 'http://127.0.0.1:18317',
      model: 'gpt-custom',
      apiKey: 'sk-custom',
      modelCatalogPath: managedCatalogPath
    })

    expect(applied.text).toContain(managedCatalogLine)
    expect(applied.text).toContain('base_url = "http://127.0.0.1:18317/v1"')
  })

  it('can leave the Codex model catalog unchanged when import is not selected', () => {
    const applied = applyCustomApiConfig(customConfig, {
      baseUrl: 'http://127.0.0.1:18317',
      model: 'gpt-custom',
      apiKey: 'sk-custom',
      modelCatalogPath: managedCatalogPath,
      syncModelCatalog: false
    })

    expect(applied.text).not.toMatch(/^model_catalog_json\s*=/m)
    expect(applied.text).toContain('model_provider = "codex_account_switcher"')
  })

  it('refreshes only the managed provider base URL when the local gateway restarts', () => {
    const applied = applyCustomApiConfig(customConfig, {
      baseUrl: 'http://127.0.0.1:18317/v1',
      model: 'gpt-5.6-sol',
      apiKey: 'local-token',
      modelCatalogPath: managedCatalogPath
    })
    const refreshed = replaceOwnedProviderBaseUrl(applied.text, 'http://127.0.0.1:43210/v1')

    expect(refreshed).toContain('base_url = "http://127.0.0.1:43210/v1"')
    expect(refreshed).toContain('experimental_bearer_token = "local-token"')
    expect(refreshed).toContain('[model_providers.custom]')
    expect(replaceOwnedProviderBaseUrl(customConfig, 'http://127.0.0.1:43210/v1')).toBeNull()
  })

  it('migrates the legacy account-switcher catalog without putting it into restore snapshots', () => {
    const legacy = `model_provider = "openai"\nmodel_catalog_json = "model-catalogs/account-switcher.json"\n`
    const applied = applyCustomApiConfig(legacy, {
      baseUrl: 'https://relay.example.com/v1',
      model: 'relay-model',
      apiKey: 'sk-relay',
      modelCatalogPath: managedCatalogPath
    })

    expect(applied.text).toContain(managedCatalogLine)
    expect(applied.snapshot.model_catalog_json).toBeNull()
    expect(restoreManagedConfig(applied.text, applied.snapshot)).not.toMatch(/^model_catalog_json\s*=/m)
  })

  it('switches top-level auth/provider keys without touching custom provider sections', () => {
    const applied = applyChatGptConfig(customConfig)

    expect(applied.text).toContain('model_provider = "openai"')
    expect(applied.text).not.toMatch(/^openai_base_url\s*=/m)
    expect(applied.text).not.toMatch(/^model_catalog_json\s*=/m)
    expect(applied.text).toContain('cli_auth_credentials_store = "file"')
    expect(applied.text).not.toMatch(/^model\s*=/m)
    expect(applied.text).not.toMatch(/^model_reasoning_effort\s*=/m)
    expect(applied.text).toContain('experimental_bearer_token = "secret-provider-token"')
    expect(applied.snapshot).toMatchObject({
      model_provider: 'model_provider = "custom"',
      openai_base_url: 'openai_base_url = "https://old.example.com/v1"',
      model: 'model = "gpt-5.6-sol"',
      model_reasoning_effort: 'model_reasoning_effort = "xhigh"',
      model_catalog_json: 'model_catalog_json = "C:\\\\old\\\\catalog.json"',
      cli_auth_credentials_store: null
    })
  })

  it('restores only managed top-level keys and preserves later unrelated changes', () => {
    const applied = applyChatGptConfig(customConfig)
    const editedWhileActive = applied.text.replace('goals = true', 'goals = false\nnew_feature = true')

    const restored = restoreManagedConfig(editedWhileActive, applied.snapshot)

    expect(restored).toContain('model_provider = "custom"')
    expect(restored).toContain('openai_base_url = "https://old.example.com/v1"')
    expect(restored).toContain('model = "gpt-5.6-sol"')
    expect(restored).toContain('model_reasoning_effort = "xhigh"')
    expect(restored).toContain('model_catalog_json = "C:\\\\old\\\\catalog.json"')
    expect(restored).not.toMatch(/^cli_auth_credentials_store\s*=/m)
    expect(restored).toContain('goals = false')
    expect(restored).toContain('new_feature = true')
  })

  it('removes and restores only the legacy provider section owned by the switcher', () => {
    const legacySection = `
[model_providers.codex_account_switcher]
name = "Switcher Custom API"
base_url = "http://127.0.0.1:18317"
wire_api = "responses"
requires_openai_auth = true
`
    const original = `${customConfig}${legacySection}`

    const applied = applyCustomApiConfig(original, {
      baseUrl: 'http://127.0.0.1:18317/v1',
      model: 'gpt-custom',
      apiKey: 'sk-new',
      modelCatalogPath: managedCatalogPath
    })
    const restored = restoreManagedConfig(applied.text, applied.snapshot)

    expect(applied.text.match(/\[model_providers\.codex_account_switcher\]/g)).toHaveLength(1)
    expect(applied.text).toContain('experimental_bearer_token = "sk-new"')
    expect(applied.text).toContain('[model_providers.custom]')
    expect(applied.text).toContain(managedCatalogLine)
    expect(restored).toContain('[model_providers.codex_account_switcher]')
    expect(restored).toContain('base_url = "http://127.0.0.1:18317"')
  })

  it('does not treat assignments inside TOML array tables as top-level keys', () => {
    const config = `model_provider = "custom"

[[profiles]]
name = "first"
model = "profile-model"
model_reasoning_effort = "high"
`

    const applied = applyChatGptConfig(config)
    const restored = restoreManagedConfig(applied.text, applied.snapshot)

    expect(applied.text).toContain('model_provider = "openai"')
    expect(applied.text).toContain('model = "profile-model"')
    expect(applied.text).toContain('model_reasoning_effort = "high"')
    expect(restored).toContain('model_provider = "custom"')
    expect(restored).toContain('[[profiles]]')
  })

  it('recognizes the owned section after Codex Desktop overwrites top-level provider fields', () => {
    const overwritten = `model_provider = "openai"
model = "gpt-5.6-sol"
model_catalog_json = "C:\\\\Codex\\\\models.json"

[model_providers.codex_account_switcher]
base_url = "http://127.0.0.1:18371/v1"
experimental_bearer_token = 'real-api-key'
`

    expect(readActiveOwnedProviderConfig(overwritten)).toEqual({
      topLevelProvider: 'openai',
      model: 'gpt-5.6-sol',
      baseUrl: 'http://127.0.0.1:18371/v1',
      bearerToken: 'real-api-key',
      modelCatalogJson: 'C:\\Codex\\models.json'
    })
  })

  it('removes every stale owned provider section before writing one clean section', () => {
    const duplicated = `${customConfig}
[model_providers.codex_account_switcher]
base_url = "http://127.0.0.1:41001/v1"

[model_providers.codex_account_switcher]
base_url = "http://127.0.0.1:41002/v1"
`
    const applied = applyCustomApiConfig(duplicated, {
      baseUrl: 'http://127.0.0.1:18371/v1',
      model: 'real-model',
      apiKey: 'real-key',
      modelCatalogPath: managedCatalogPath
    })

    expect(applied.text.match(/\[model_providers\.codex_account_switcher\]/g)).toHaveLength(1)
    expect(applied.text).toContain('base_url = "http://127.0.0.1:18371/v1"')
    expect(applied.text).not.toContain('41001')
    expect(applied.text).not.toContain('41002')
  })
})
