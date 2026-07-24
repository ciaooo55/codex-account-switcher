import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalApiServerState } from '../../../shared/api-server'
import { ApiServerPage } from './ApiServerPage'

const api = vi.hoisted(() => ({
  getLocalApiServerState: vi.fn(),
  saveLocalApiServerConfig: vi.fn(),
  startLocalApiServer: vi.fn(),
  stopLocalApiServer: vi.fn(),
  restartLocalApiServer: vi.fn(),
  generateLocalApiAccessKey: vi.fn(),
  revealLocalApiAccessKey: vi.fn(),
  revealLocalApiUpstreamKey: vi.fn(),
  refreshLocalApiServerModels: vi.fn(),
  applyLocalApiServerToCodex: vi.fn(),
  listCustomApiModels: vi.fn()
}))

vi.mock('../services/codexApi', () => ({ codexApi: () => api }))

function localApiState(running = true): LocalApiServerState {
  return {
    config: {
      port: 8888,
      autoStart: false,
      accessKeys: [{
        id: 'codex-key',
        label: 'Codex 专用',
        enabled: true,
        allowedModels: [],
        hasKey: true,
        keyPreview: 'sk-cas-…abcd',
        isShort: false
      }],
      upstreams: [{
        id: 'upstream-a',
        name: '上游 A',
        baseUrl: 'https://api.example.com/v1',
        protocol: 'responses',
        models: ['gpt-5.4'],
        priority: 1,
        enabled: true,
        hasApiKey: true,
        keyPreview: 'sk-up…wxyz'
      }],
      credentialSources: [{
        id: 'codex:credential-1',
        provider: 'codex',
        credentialId: 'credential-1',
        label: 'user@example.com',
        models: ['gpt-5.4'],
        priority: 2,
        enabled: false
      }],
      routes: [{
        publicModel: 'xxx',
        strategy: 'priority',
        sourceMode: 'api_only',
        targets: [{ sourceId: 'upstream-a', upstreamModel: 'gpt-5.4', priority: 1, enabled: true }]
      }]
    },
    status: {
      running,
      host: '127.0.0.1',
      port: 8888,
      pid: running ? 4321 : null,
      startedAt: running ? '2026-07-24T10:00:00.000Z' : null,
      error: null
    }
  }
}

describe('ApiServerPage', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    api.getLocalApiServerState.mockResolvedValue(localApiState())
    api.saveLocalApiServerConfig.mockResolvedValue(localApiState())
    api.startLocalApiServer.mockResolvedValue(localApiState())
    api.stopLocalApiServer.mockResolvedValue(localApiState(false))
    api.restartLocalApiServer.mockResolvedValue(localApiState())
    api.generateLocalApiAccessKey.mockResolvedValue('sk-cas-generated-secure-value')
    api.revealLocalApiAccessKey.mockResolvedValue('sk-cas-saved-secret-value')
    api.revealLocalApiUpstreamKey.mockResolvedValue('sk-upstream-saved-secret-value')
    api.applyLocalApiServerToCodex.mockResolvedValue({ ok: true, message: 'Codex 已切换', backupPath: 'backup.toml' })
    api.listCustomApiModels.mockResolvedValue({
      ok: true,
      message: '获取成功',
      models: ['gpt-5.4', 'gpt-5.4-mini'],
      baseUrl: 'https://api.example.com/v1',
      modelsUrl: 'https://api.example.com/v1/models'
    })
    api.refreshLocalApiServerModels.mockResolvedValue({
      upstreams: [{
        id: 'upstream-a',
        catalogOk: true,
        probeOk: true,
        baseUrl: 'https://api.example.com/v1',
        protocol: 'responses',
        models: ['gpt-5.4', 'gpt-5.4-mini'],
        latencyMs: 25,
        message: '已获取模型并完成真实请求测试'
      }],
      credentialSources: localApiState().config.credentialSources
    })
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  it('展示固定地址、运行状态和脱敏配置', async () => {
    render(<ApiServerPage />)

    expect(await screen.findByText('运行中')).toBeInTheDocument()
    expect(screen.getByText(/http:\/\/127\.0\.0\.1:8888\/v1/)).toBeInTheDocument()
    expect(screen.getByText('4321')).toBeInTheDocument()
    expect(screen.getByText('本软件访问密钥')).toBeInTheDocument()
    expect(screen.getByDisplayValue('sk-cas-…abcd')).toBeInTheDocument()
    expect(screen.queryByText('real-upstream-secret')).not.toBeInTheDocument()
  })

  it('保存端口和自启设置时不将已保存秘密回传 Renderer', async () => {
    render(<ApiServerPage />)
    await screen.findByText('本软件访问密钥')

    fireEvent.change(screen.getByLabelText('监听端口'), { target: { value: '18317' } })
    fireEvent.click(screen.getByLabelText('随应用自动启动'))
    fireEvent.click(screen.getByRole('button', { name: '保存并热更新' }))

    await waitFor(() => expect(api.saveLocalApiServerConfig).toHaveBeenCalledOnce())
    expect(api.saveLocalApiServerConfig).toHaveBeenCalledWith(expect.objectContaining({ port: 18317, autoStart: true }))
    const saved = api.saveLocalApiServerConfig.mock.calls[0][0]
    expect(saved.accessKeys[0]).not.toHaveProperty('key')
    expect(saved.upstreams[0]).not.toHaveProperty('apiKey')
    expect(saved.credentialSources).toEqual([expect.objectContaining({ id: 'codex:credential-1' })])
  })

  it('生成、编辑和保存新的项目密钥', async () => {
    render(<ApiServerPage />)
    await screen.findByText('本软件访问密钥')

    fireEvent.click(screen.getByRole('button', { name: '生成安全密钥' }))
    expect(await screen.findByDisplayValue('sk-cas-generated-secure-value')).toBeInTheDocument()
    const whitelist = screen.getByLabelText('本软件密钥 2 模型白名单')
    fireEvent.change(whitelist, { target: { value: 'xxx, model-b' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并热更新' }))

    await waitFor(() => expect(api.saveLocalApiServerConfig).toHaveBeenCalled())
    const saved = api.saveLocalApiServerConfig.mock.calls.at(-1)?.[0]
    expect(saved.accessKeys.at(-1)).toMatchObject({
      key: 'sk-cas-generated-secure-value',
      allowedModels: ['xxx', 'model-b'],
      enabled: true
    })
  })

  it('重新加载后仍对已保存的短密钥显示安全警告', async () => {
    const state = localApiState()
    state.config.accessKeys[0].isShort = true
    api.getLocalApiServerState.mockResolvedValue(state)
    render(<ApiServerPage />)

    expect(await screen.findByText(/1 个短密钥/)).toBeInTheDocument()
  })

  it('通过主进程安全复制已保存密钥，不将明文写入页面状态', async () => {
    render(<ApiServerPage />)
    await screen.findByText('本软件访问密钥')
    fireEvent.click(screen.getByRole('button', { name: '复制 Codex 专用' }))

    await waitFor(() => expect(api.revealLocalApiAccessKey).toHaveBeenCalledWith('codex-key'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('sk-cas-saved-secret-value')
    expect(screen.queryByDisplayValue('sk-cas-saved-secret-value')).not.toBeInTheDocument()
  })

  it('在用户点击显示后展示完整本软件密钥', async () => {
    render(<ApiServerPage />)
    await screen.findByText('本软件访问密钥')

    fireEvent.click(screen.getByRole('button', { name: '显示 Codex 专用' }))
    await waitFor(() => expect(api.revealLocalApiAccessKey).toHaveBeenCalledWith('codex-key'))
    expect(screen.getByDisplayValue('sk-cas-saved-secret-value')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '隐藏 Codex 专用' })).toBeInTheDocument()
  })

  it('支持显示并复制已保存的上游 Key', async () => {
    render(<ApiServerPage />)
    await screen.findByText('本软件访问密钥')
    fireEvent.click(screen.getByRole('button', { name: /第三方上游/ }))
    const upstreamToggle = screen.getAllByRole('button', { name: /上游 A/ })
      .find((button) => button.getAttribute('aria-expanded') === 'false')
    expect(upstreamToggle).toBeDefined()
    fireEvent.click(upstreamToggle!)

    expect(screen.getByDisplayValue('sk-up…wxyz')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '显示 上游 A 上游 API Key' }))
    await waitFor(() => expect(api.revealLocalApiUpstreamKey).toHaveBeenCalledWith('upstream-a'))
    expect(screen.getByDisplayValue('sk-upstream-saved-secret-value')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '复制 上游 A 上游 API Key' }))

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('sk-upstream-saved-secret-value')
  })

  it('测试上游并同步模型列表', async () => {
    render(<ApiServerPage />)
    await screen.findByText('本软件访问密钥')
    fireEvent.click(screen.getByRole('button', { name: /第三方上游/ }))

    fireEvent.click(screen.getByRole('button', { name: '测试并获取模型' }))
    await waitFor(() => expect(api.refreshLocalApiServerModels).toHaveBeenCalledWith({
      upstreams: [expect.objectContaining({ id: 'upstream-a', baseUrl: 'https://api.example.com/v1' })],
      testUpstreams: true,
      refreshCredentials: false
    }))
    expect(await screen.findByText(/已验证 · \d+ ms/)).toBeInTheDocument()
  })

  it('保存第三方上游的自定义鉴权头而不把密钥重复写进配置', async () => {
    render(<ApiServerPage />)
    await screen.findByText('本软件访问密钥')
    fireEvent.click(screen.getByRole('button', { name: /第三方上游/ }))
    const upstreamToggle = screen.getAllByRole('button', { name: /上游 A/ })
      .find((button) => button.getAttribute('aria-expanded') === 'false')
    fireEvent.click(upstreamToggle!)

    fireEvent.change(screen.getByRole('combobox', { name: /上游鉴权/ }), { target: { value: 'custom' } })
    fireEvent.change(screen.getByLabelText(/自定义鉴权头名称/), { target: { value: 'x-provider-key' } })
    fireEvent.change(screen.getByLabelText(/鉴权值前缀/), { target: { value: 'Token ' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并热更新' }))

    await waitFor(() => expect(api.saveLocalApiServerConfig).toHaveBeenCalled())
    expect(api.saveLocalApiServerConfig.mock.calls.at(-1)?.[0].upstreams[0]).toMatchObject({
      authMode: 'custom', authHeaderName: 'x-provider-key', authHeaderPrefix: 'Token '
    })
    expect(api.saveLocalApiServerConfig.mock.calls.at(-1)?.[0].upstreams[0]).not.toHaveProperty('apiKey')
  })

  it('识别 URL-safe Base64 中的 URL 和 Key 并立即真实测试', async () => {
    render(<ApiServerPage />)
    await screen.findByText('本软件访问密钥')
    fireEvent.click(screen.getByRole('button', { name: /第三方上游/ }))
    fireEvent.click(screen.getByRole('button', { name: '快速导入' }))

    const encoded = btoa(JSON.stringify({
      base_url: 'https://encoded.example.com/v1',
      api_key: 'sk-encoded-1234567890'
    })).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
    fireEvent.change(screen.getByLabelText('上游粘贴内容'), { target: { value: encoded } })
    fireEvent.click(screen.getByRole('button', { name: '识别并测试' }))

    await waitFor(() => expect(api.refreshLocalApiServerModels).toHaveBeenCalledWith({
      upstreams: [expect.objectContaining({
        baseUrl: 'https://encoded.example.com/v1',
        apiKey: 'sk-encoded-1234567890'
      })],
      testUpstreams: true,
      refreshCredentials: false
    }))
    expect(screen.getByText('encoded.example.com')).toBeInTheDocument()
  })

  it('一键刷新全部上游并允许编辑凭证的可用模型', async () => {
    render(<ApiServerPage />)
    await screen.findByText('本软件访问密钥')
    fireEvent.click(screen.getByRole('button', { name: /第三方上游/ }))
    fireEvent.click(screen.getByRole('button', { name: '刷新全部模型并检查' }))

    await waitFor(() => expect(api.refreshLocalApiServerModels).toHaveBeenCalledWith({
      upstreams: [expect.objectContaining({ id: 'upstream-a' })],
      testUpstreams: true,
      refreshCredentials: true
    }))

    fireEvent.click(screen.getByRole('button', { name: /账号凭证源/ }))
    const models = await screen.findByLabelText('user@example.com 可用模型')
    fireEvent.change(models, { target: { value: 'gpt-5.4, gpt-5.5' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并热更新' }))

    await waitFor(() => expect(api.saveLocalApiServerConfig).toHaveBeenCalled())
    expect(api.saveLocalApiServerConfig.mock.calls.at(-1)?.[0].credentialSources[0].models).toEqual(['gpt-5.4', 'gpt-5.5'])
  })

  it('将已发现的上游模型一键导入公开路由，供 Codex 选择', async () => {
    render(<ApiServerPage />)
    await screen.findByText('本软件访问密钥')
    fireEvent.click(screen.getByRole('button', { name: /公开模型路由/ }))
    fireEvent.click(screen.getByRole('button', { name: '导入已发现模型' }))
    fireEvent.click(screen.getByRole('button', { name: '保存并热更新' }))

    await waitFor(() => expect(api.saveLocalApiServerConfig).toHaveBeenCalled())
    expect(api.saveLocalApiServerConfig.mock.calls.at(-1)?.[0].routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        publicModel: 'gpt-5.4',
        targets: [expect.objectContaining({ sourceId: 'upstream-a', upstreamModel: 'gpt-5.4' })]
      })
    ]))
  })

  it('可以将脱敏的账号凭证引用加入 API 上游池', async () => {
    render(<ApiServerPage />)
    await screen.findByText('本软件访问密钥')
    fireEvent.click(screen.getByRole('button', { name: /账号凭证源/ }))

    expect(screen.getByText('user@example.com')).toBeInTheDocument()
    expect(screen.getByText('credential-1')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('仅账号切换'))
    fireEvent.click(screen.getByRole('button', { name: '保存并热更新' }))

    await waitFor(() => expect(api.saveLocalApiServerConfig).toHaveBeenCalled())
    expect(api.saveLocalApiServerConfig.mock.calls.at(-1)?.[0].credentialSources[0]).toMatchObject({
      id: 'codex:credential-1',
      enabled: true
    })
  })

  it('用相同的本地服务地址将公开模型应用到 Codex', async () => {
    render(<ApiServerPage />)
    await screen.findByText('一键设置 Codex')

    expect(screen.getByLabelText('Codex 使用的本软件密钥')).toHaveValue('codex-key')
    expect(screen.getByLabelText('默认公开模型')).toHaveValue('xxx')
    fireEvent.click(screen.getByRole('button', { name: '应用到 Codex' }))

    await waitFor(() => expect(api.applyLocalApiServerToCodex).toHaveBeenCalledWith({
      accessKeyId: 'codex-key',
      model: 'xxx',
      restart: true
    }))
    expect(await screen.findByText('Codex 已切换')).toBeInTheDocument()
  })

  it('明确提示其他工具覆盖了 Codex provider，避免误以为公开模型已生效', async () => {
    api.getLocalApiServerState
      .mockResolvedValueOnce(localApiState())
      .mockResolvedValueOnce({
        ...localApiState(),
        codexIntegration: {
          state: 'external_override',
          message: '顶层 provider 已被其他工具写入。',
          configuredProvider: 'codex_local_access',
          configuredModel: 'grok-4.5',
          expectedModel: 'xxx',
          catalogPath: 'C:/Users/tester/.codex/cockpit-models.json'
        }
      })
    render(<ApiServerPage />)
    await screen.findByText('一键设置 Codex')

    fireEvent.click(screen.getByRole('button', { name: '应用到 Codex' }))

    expect(await screen.findByText('顶层 provider 已被其他工具写入。')).toBeInTheDocument()
    expect(screen.getByText(/实际使用：codex_local_access \/ grok-4\.5/)).toBeInTheDocument()
  })
})
