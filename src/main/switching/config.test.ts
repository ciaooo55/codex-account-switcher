import { describe, expect, it } from 'vitest'
import { applyChatGptConfig, restoreManagedConfig } from './config'

const customConfig = `model_provider = "custom"
notify = ["tool.exe"]
model = "gpt-5.6-sol"
model_reasoning_effort = "xhigh"

[model_providers.custom]
name = "custom"
requires_openai_auth = true
base_url = "http://127.0.0.1:18317/v1"
experimental_bearer_token = "secret-provider-token"

[features]
goals = true
`

describe('managed Codex config patching', () => {
  it('switches top-level auth/provider keys without touching custom provider sections', () => {
    const applied = applyChatGptConfig(customConfig)

    expect(applied.text).toContain('model_provider = "openai"')
    expect(applied.text).toContain('cli_auth_credentials_store = "file"')
    expect(applied.text).not.toMatch(/^model\s*=/m)
    expect(applied.text).not.toMatch(/^model_reasoning_effort\s*=/m)
    expect(applied.text).toContain('experimental_bearer_token = "secret-provider-token"')
    expect(applied.snapshot).toMatchObject({
      model_provider: 'model_provider = "custom"',
      model: 'model = "gpt-5.6-sol"',
      model_reasoning_effort: 'model_reasoning_effort = "xhigh"',
      cli_auth_credentials_store: null
    })
  })

  it('restores only managed top-level keys and preserves later unrelated changes', () => {
    const applied = applyChatGptConfig(customConfig)
    const editedWhileActive = applied.text.replace('goals = true', 'goals = false\nnew_feature = true')

    const restored = restoreManagedConfig(editedWhileActive, applied.snapshot)

    expect(restored).toContain('model_provider = "custom"')
    expect(restored).toContain('model = "gpt-5.6-sol"')
    expect(restored).toContain('model_reasoning_effort = "xhigh"')
    expect(restored).not.toMatch(/^cli_auth_credentials_store\s*=/m)
    expect(restored).toContain('goals = false')
    expect(restored).toContain('new_feature = true')
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
