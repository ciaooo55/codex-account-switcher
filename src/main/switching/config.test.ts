import { describe, expect, it } from 'vitest'
import { applyChatGptConfig, applyCustomApiConfig, restoreManagedConfig } from './config'

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

describe('managed Codex config patching', () => {
  it('uses the openai provider identity and normalizes a custom Responses base URL', () => {
    const applied = applyCustomApiConfig(customConfig, {
      baseUrl: 'http://127.0.0.1:18317',
      model: 'gpt-custom',
      modelCatalogPath: 'C:\\Users\\lee\\.codex\\model-catalogs\\account-switcher.json'
    })

    expect(applied.text).toContain('model_provider = "openai"')
    expect(applied.text).toContain('model = "gpt-custom"')
    expect(applied.text).toContain('openai_base_url = "http://127.0.0.1:18317/v1"')
    expect(applied.text).toContain(
      'model_catalog_json = "C:\\\\Users\\\\lee\\\\.codex\\\\model-catalogs\\\\account-switcher.json"'
    )
    expect(applied.text).not.toContain('[model_providers.codex_account_switcher]')
    expect(applied.text).toContain('[model_providers.custom]')
    expect(applied.snapshot.model_provider).toBe('model_provider = "custom"')
    expect(applied.snapshot.model_catalog_json).toBe('model_catalog_json = "C:\\\\old\\\\catalog.json"')
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
      modelCatalogPath: 'C:\\catalog.json'
    })
    const restored = restoreManagedConfig(applied.text, applied.snapshot)

    expect(applied.text).not.toContain('[model_providers.codex_account_switcher]')
    expect(applied.text).toContain('[model_providers.custom]')
    expect(applied.text).toContain('model_catalog_json = "C:\\\\catalog.json"')
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
})
