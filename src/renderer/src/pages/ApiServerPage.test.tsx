import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalApiServerState } from '../../../shared/api-server'
import { ApiServerPage } from './ApiServerPage'

const api = vi.hoisted(() => ({
  getLocalApiServerState: vi.fn(),
  saveLocalApiServerConfig: vi.fn(),
  startLocalApiServer: vi.fn(),
  stopLocalApiServer: vi.fn(),
  restartLocalApiServer: vi.fn(),
  clearLocalApiServerCooldowns: vi.fn(),
  generateLocalApiAccessKey: vi.fn(),
  revealLocalApiAccessKey: vi.fn(),
  revealLocalApiUpstreamKey: vi.fn(),
  refreshLocalApiServerModels: vi.fn(),
  testLocalApiServer: vi.fn(),
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
        allowedSourceIds: [],
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

async function openApiSection(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: `打开 ${name}` }))
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
    api.testLocalApiServer.mockResolvedValue({ ok: true, status: 200, model: 'demo-model', outputText: '测试成功', message: '本地 API 对话测试成功', latencyMs: 12 })
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
    expect(screen.getAllByText(/http:\/\/127\.0\.0\.1:8888\/v1/).length).toBeGreaterThan(0)
    expect(screen.getByText('4321')).toBeInTheDocument()
    await openApiSection('客户端密钥')
    expect(screen.getByText('本软件访问密钥')).toBeInTheDocument()
    expect(screen.getByDisplayValue('sk-cas-…abcd')).toBeInTheDocument()
    expect(screen.queryByText('real-upstream-secret')).not.toBeInTheDocument()
  })

  it('在独立悬浮窗口中展示无敏感信息的服务活动', async () => {
    render(<ApiServerPage />)
    await screen.findByText('服务健康')
    fireEvent.click(screen.getByRole('button', { name: '查看请求' }))

    const dialog = screen.getByRole('dialog', { name: 'API 服务活动' })
    expect(dialog).toHaveTextContent('服务健康与最近请求')
    expect(dialog).toHaveTextContent('尚未收到本地 API 请求')
    fireEvent.click(screen.getByRole('button', { name: '关闭 API 服务活动' }))
    expect(screen.queryByRole('dialog', { name: 'API 服务活动' })).not.toBeInTheDocument()
  })

  it('通过独立悬浮窗口使用本软件密钥和公开模型测试本地 API 对话', async () => {
    render(<ApiServerPage />)
    await screen.findByText('服务总览')
    fireEvent.click(screen.getByRole('button', { name: '测试对话' }))

    const dialog = screen.getByRole('dialog', { name: '测试本地 API 对话' })
    expect(within(dialog).getByLabelText('测试访问密钥')).toHaveValue('codex-key')
    expect(within(dialog).getByLabelText('测试公开模型')).toHaveValue('xxx')
    fireEvent.change(within(dialog).getByLabelText('测试消息'), { target: { value: '请回复本地服务正常' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '发送测试' }))

    await waitFor(() => expect(api.testLocalApiServer).toHaveBeenCalledWith({
      accessKeyId: 'codex-key',
      model: 'xxx',
      input: '请回复本地服务正常'
    }))
    expect(await within(dialog).findByText('测试成功')).toBeInTheDocument()
  })

  it('让 API 编辑浮窗支持 Escape 关闭，避免焦点停留在遮罩后方', async () => {
    render(<ApiServerPage />)
    await openApiSection('API')
    fireEvent.click(screen.getByRole('button', { name: '编辑 API 上游 A' }))
    expect(await screen.findByRole('dialog', { name: '编辑 API' })).toBeInTheDocument()
    expect(document.body.style.overflow).toBe('hidden')
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑 API' })).not.toBeInTheDocument())
  })

  it('保存端口和自启设置时不将已保存秘密回传 Renderer', async () => {
    render(<ApiServerPage />)
    await openApiSection('客户端密钥')

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

  it('将超时、最大尝试来源和会话亲和真实保存到 API 服务配置', async () => {
    render(<ApiServerPage />)
    await screen.findByText('服务设置')
    fireEvent.click(screen.getByRole('button', { name: '超时与故障切换' }))
    const dialog = screen.getByRole('dialog', { name: '超时、重试与会话路由' })
    fireEvent.change(within(dialog).getByLabelText(/请求超时/), { target: { value: '45' } })
    fireEvent.change(within(dialog).getByLabelText(/最多尝试来源/), { target: { value: '2' } })
    fireEvent.change(within(dialog).getByLabelText(/切换等待/), { target: { value: '250' } })
    fireEvent.change(within(dialog).getByLabelText(/每来源媒体并发/), { target: { value: '3' } })
    fireEvent.click(within(dialog).getByLabelText('保持同一会话使用相同来源'))
    fireEvent.click(within(dialog).getByRole('button', { name: '保存并热更新' }))

    await waitFor(() => expect(api.saveLocalApiServerConfig).toHaveBeenCalled())
    expect(api.saveLocalApiServerConfig.mock.calls.at(-1)?.[0]).toMatchObject({
      requestTimeoutMs: 45_000,
      maxRetrySources: 2,
      retryDelayMs: 250,
      maxConcurrentMediaRequests: 3,
      sessionAffinity: false
    })
  })

  it('生成、编辑和保存新的项目密钥', async () => {
    render(<ApiServerPage />)
    await openApiSection('客户端密钥')

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

  it('将本软件密钥限制到选定的 API 或账号凭证来源池', async () => {
    render(<ApiServerPage />)
    await openApiSection('客户端密钥')

    fireEvent.click(screen.getByRole('checkbox', { name: /上游 A/ }))
    fireEvent.click(screen.getByRole('button', { name: '保存并热更新' }))

    await waitFor(() => expect(api.saveLocalApiServerConfig).toHaveBeenCalled())
    expect(api.saveLocalApiServerConfig.mock.calls.at(-1)?.[0].accessKeys[0]).toMatchObject({
      allowedSourceIds: ['upstream-a']
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
    await openApiSection('客户端密钥')
    fireEvent.click(screen.getByRole('button', { name: '复制 Codex 专用' }))

    await waitFor(() => expect(api.revealLocalApiAccessKey).toHaveBeenCalledWith('codex-key'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('sk-cas-saved-secret-value')
    expect(screen.queryByDisplayValue('sk-cas-saved-secret-value')).not.toBeInTheDocument()
  })

  it('在用户点击显示后展示完整本软件密钥', async () => {
    render(<ApiServerPage />)
    await openApiSection('客户端密钥')

    fireEvent.click(screen.getByRole('button', { name: '显示 Codex 专用' }))
    await waitFor(() => expect(api.revealLocalApiAccessKey).toHaveBeenCalledWith('codex-key'))
    expect(screen.getByDisplayValue('sk-cas-saved-secret-value')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '隐藏 Codex 专用' })).toBeInTheDocument()
  })

  it('支持显示并复制已保存的上游 Key', async () => {
    render(<ApiServerPage />)
    await openApiSection('API')
    const upstreamToggle = screen.getAllByRole('button', { name: /上游 A/ })
      .find((button) => button.getAttribute('aria-expanded') === 'false')
    expect(upstreamToggle).toBeDefined()
    fireEvent.click(upstreamToggle!)

    expect(screen.getByDisplayValue('sk-up…wxyz')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '显示 上游 A API Key' }))
    await waitFor(() => expect(api.revealLocalApiUpstreamKey).toHaveBeenCalledWith('upstream-a'))
    expect(screen.getByDisplayValue('sk-upstream-saved-secret-value')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '复制 上游 A API Key' }))

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('sk-upstream-saved-secret-value')
  })

  it('测试上游并同步模型列表', async () => {
    render(<ApiServerPage />)
    await openApiSection('API')

    fireEvent.click(screen.getByRole('button', { name: '测试并获取模型' }))
    await waitFor(() => expect(api.refreshLocalApiServerModels).toHaveBeenCalledWith({
      upstreams: [expect.objectContaining({ id: 'upstream-a', baseUrl: 'https://api.example.com/v1' })],
      testUpstreams: true,
      refreshCredentials: false
    }))
    expect(await screen.findByText(/已验证 · \d+ ms/)).toBeInTheDocument()
    await openApiSection('公开模型路由')
    fireEvent.click(screen.getAllByRole('button', { name: '编辑模型 gpt-5.4-mini' })[0])
    const routeDialog = screen.getByRole('dialog', { name: '模型路由' })
    expect(routeDialog.querySelectorAll('input[value="gpt-5.4-mini"]')).toHaveLength(2)
    fireEvent.change(within(routeDialog).getByLabelText(/^输入单价/), { target: { value: '5' } })
    fireEvent.change(within(routeDialog).getByLabelText(/^缓存输入单价/), { target: { value: '1' } })
    fireEvent.change(within(routeDialog).getByLabelText(/^输出单价/), { target: { value: '15' } })
    fireEvent.click(within(routeDialog).getByRole('button', { name: '保存更改' }))
    await waitFor(() => expect(api.saveLocalApiServerConfig).toHaveBeenCalled())
    expect(api.saveLocalApiServerConfig.mock.calls.at(-1)?.[0].routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        publicModel: 'gpt-5.4-mini',
        pricing: { inputPerMillion: 5, cachedInputPerMillion: 1, outputPerMillion: 15 }
      })
    ]))
  })

  it('让模型总览反向补全 API 卡片的目标模型列表', async () => {
    render(<ApiServerPage />)
    await openApiSection('公开模型路由')
    fireEvent.click(screen.getAllByRole('button', { name: '编辑模型 xxx' })[0])
    const dialog = screen.getByRole('dialog', { name: '模型路由' })
    fireEvent.change(within(dialog).getByLabelText('xxx 目标模型'), { target: { value: 'gpt-5.4-alias' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存更改' }))

    await waitFor(() => expect(api.saveLocalApiServerConfig).toHaveBeenCalled())
    expect(api.saveLocalApiServerConfig.mock.calls.at(-1)?.[0]).toMatchObject({
      upstreams: [expect.objectContaining({ id: 'upstream-a', models: ['gpt-5.4', 'gpt-5.4-alias'] })],
      routes: [expect.objectContaining({
        publicModel: 'xxx',
        targets: [expect.objectContaining({ sourceId: 'upstream-a', upstreamModel: 'gpt-5.4-alias' })]
      })]
    })
  })

  it('在 API 卡片移除模型时暂停对应路由，而不是静默删除映射', async () => {
    render(<ApiServerPage />)
    await openApiSection('API')
    fireEvent.click(screen.getByRole('button', { name: '编辑 API 上游 A' }))
    const dialog = screen.getByRole('dialog', { name: '编辑 API' })
    fireEvent.change(within(dialog).getByDisplayValue('gpt-5.4'), { target: { value: '' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存更改' }))

    await waitFor(() => expect(api.saveLocalApiServerConfig).toHaveBeenCalled())
    expect(api.saveLocalApiServerConfig.mock.calls.at(-1)?.[0].routes[0].targets[0]).toMatchObject({
      sourceId: 'upstream-a', upstreamModel: 'gpt-5.4', enabled: false
    })
  })

  it('保存第三方上游的自定义鉴权头而不把密钥重复写进配置', async () => {
    render(<ApiServerPage />)
    await openApiSection('API')
    const upstreamToggle = screen.getAllByRole('button', { name: /上游 A/ })
      .find((button) => button.getAttribute('aria-expanded') === 'false')
    fireEvent.click(upstreamToggle!)

    fireEvent.change(screen.getByRole('combobox', { name: /API 鉴权/ }), { target: { value: 'custom' } })
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
    await openApiSection('API')
    fireEvent.click(screen.getByRole('button', { name: '快速导入' }))

    const encoded = btoa(JSON.stringify({
      base_url: 'https://encoded.example.com/v1',
      api_key: 'sk-encoded-1234567890'
    })).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
    fireEvent.change(screen.getByLabelText('API 粘贴内容'), { target: { value: encoded } })
    fireEvent.click(screen.getByRole('button', { name: '识别并测试' }))

    await waitFor(() => expect(api.refreshLocalApiServerModels).toHaveBeenCalledWith({
      upstreams: [expect.objectContaining({
        baseUrl: 'https://encoded.example.com/v1',
        apiKey: 'sk-encoded-1234567890'
      })],
      testUpstreams: true,
      refreshCredentials: false
    }))
    expect(screen.getAllByText('encoded.example.com').length).toBeGreaterThan(0)
  })

  it('一键刷新全部上游并允许编辑凭证的可用模型', async () => {
    render(<ApiServerPage />)
    await openApiSection('API')
    fireEvent.click(screen.getByRole('button', { name: '刷新全部模型并检查' }))

    await waitFor(() => expect(api.refreshLocalApiServerModels).toHaveBeenCalledWith({
      upstreams: [expect.objectContaining({ id: 'upstream-a' })],
      testUpstreams: true,
      refreshCredentials: true
    }))

    await openApiSection('账号凭证源')
    fireEvent.click(await screen.findByRole('button', { name: '编辑凭证来源 user@example.com' }))
    const credentialDialog = await screen.findByRole('dialog', { name: '账号凭证来源' })
    const models = await screen.findByLabelText('user@example.com 可用模型')
    fireEvent.change(models, { target: { value: 'gpt-5.4, gpt-5.5' } })
    fireEvent.click(within(credentialDialog).getByRole('button', { name: '保存并热更新' }))

    await waitFor(() => expect(api.saveLocalApiServerConfig).toHaveBeenCalled())
    expect(api.saveLocalApiServerConfig.mock.calls.at(-1)?.[0].credentialSources[0].models).toEqual(['gpt-5.4', 'gpt-5.5'])
  })

  it('将已发现的上游模型一键导入公开路由，供 Codex 选择', async () => {
    render(<ApiServerPage />)
    await openApiSection('公开模型路由')
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
    await openApiSection('账号凭证源')

    expect(screen.getAllByText('user@example.com').length).toBeGreaterThan(0)
    expect(screen.getByText('credential-1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '编辑凭证来源 user@example.com' }))
    const dialog = await screen.findByRole('dialog', { name: '账号凭证来源' })
    fireEvent.click(within(dialog).getByLabelText('仅作为账号切换来源'))
    fireEvent.click(within(dialog).getByRole('button', { name: '保存并热更新' }))

    await waitFor(() => expect(api.saveLocalApiServerConfig).toHaveBeenCalled())
    expect(api.saveLocalApiServerConfig.mock.calls.at(-1)?.[0].credentialSources[0]).toMatchObject({
      id: 'codex:credential-1',
      enabled: true
    })
  })

  it('用相同的本地服务地址将公开模型应用到 Codex', async () => {
    render(<ApiServerPage />)
    await screen.findByText('Codex 接管')

    expect(screen.getByLabelText('Codex 项目密钥')).toHaveValue('codex-key')
    expect(screen.getByLabelText(/默认公开模型/)).toHaveValue('xxx')
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
    await screen.findByText('Codex 接管')

    fireEvent.click(screen.getByRole('button', { name: '应用到 Codex' }))

    expect(await screen.findByText('顶层 provider 已被其他工具写入。')).toBeInTheDocument()
    expect(screen.getByText(/实际使用：codex_local_access \/ grok-4\.5/)).toBeInTheDocument()
  })
})
