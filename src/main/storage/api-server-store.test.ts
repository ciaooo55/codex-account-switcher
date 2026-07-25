import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SecretCipher } from '../../shared/types'
import { ApiServerStore } from './api-server-store'

const roots: string[] = []
const cipher: SecretCipher = {
  encrypt: (value) => Buffer.from(`encrypted:${value}`).toString('base64'),
  decrypt: (value) => Buffer.from(value, 'base64').toString('utf8').replace(/^encrypted:/, '')
}

function configuration() {
  return {
    port: 8888,
    autoStart: true,
    accessKeys: [{ id: 'client', label: 'Codex', key: 'sk-client-secret', enabled: true, allowedModels: ['xxx'], allowedSourceIds: ['upstream'] }],
    upstreams: [{
      id: 'upstream',
      name: 'Provider',
      baseUrl: 'https://example.com/v1',
      apiKey: 'sk-upstream-secret',
      protocol: 'auto' as const,
      authMode: 'custom' as const,
      authHeaderName: 'x-provider-key',
      authHeaderPrefix: 'Token ',
      models: ['real-model'],
      priority: 1,
      enabled: true
    }],
    credentialSources: [{
      id: 'codex:credential-id',
      provider: 'codex' as const,
      credentialId: 'credential-id',
      label: 'Safe account label',
      models: ['gpt-real'],
      priority: 2,
      enabled: true
    }],
    codexBinding: {
      accessKeyId: 'client',
      model: 'xxx',
      enforce: true
    },
    routes: [{
      publicModel: 'xxx',
      strategy: 'priority' as const,
      sourceMode: 'api_only' as const,
      targets: [{ sourceId: 'upstream', upstreamModel: 'real-model', priority: 1, enabled: true }]
    }]
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('ApiServerStore', () => {
  it('encrypts client and upstream keys and exposes only previews in summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'api-server-store-'))
    roots.push(root)
    const path = join(root, 'server.json')
    const store = new ApiServerStore(path, cipher)

    const summary = await store.save(configuration())
    const stored = await readFile(path, 'utf8')

    expect(stored).not.toContain('sk-client-secret')
    expect(stored).not.toContain('sk-upstream-secret')
    expect(summary.accessKeys[0]).toMatchObject({ hasKey: true, keyPreview: 'sk-cl••••cret', allowedSourceIds: ['upstream'] })
    expect(summary.upstreams[0]).toMatchObject({ hasApiKey: true, keyPreview: 'sk-up••••cret' })
    await expect(store.getAccessKey('client')).resolves.toBe('sk-client-secret')
    await expect(store.getAccessKey('missing')).resolves.toBeNull()
    await expect(store.getUpstreamKey('upstream')).resolves.toBe('sk-upstream-secret')
    await expect(store.getUpstreamKey('missing')).resolves.toBeNull()
    await expect(store.runtimeConfig()).resolves.toMatchObject({
      port: 8888,
      accessKeys: [{ key: 'sk-client-secret', allowedSourceIds: ['upstream'] }],
      upstreams: [{ apiKey: 'sk-upstream-secret', authMode: 'custom', authHeaderName: 'x-provider-key', authHeaderPrefix: 'Token ' }],
      credentialSources: [{ id: 'codex:credential-id', credentialId: 'credential-id' }],
      codexBinding: { accessKeyId: 'client', model: 'xxx', enforce: true }
    })
  })

  it('retains existing encrypted secrets when metadata is edited without secret fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'api-server-store-'))
    roots.push(root)
    const store = new ApiServerStore(join(root, 'server.json'), cipher)
    await store.save(configuration())

    const existing = configuration()
    const edited = {
      ...existing,
      accessKeys: existing.accessKeys.map(({ key: _key, ...entry }) => ({
        ...entry,
        label: 'Codex edited'
      })),
      upstreams: existing.upstreams.map(({ apiKey: _apiKey, ...entry }) => entry)
    }
    await store.save(edited)

    await expect(store.runtimeConfig()).resolves.toMatchObject({
      accessKeys: [{ label: 'Codex edited', key: 'sk-client-secret' }],
      upstreams: [{ apiKey: 'sk-upstream-secret' }]
    })
  })

  it('allows a no-auth upstream while keeping project access keys encrypted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'api-server-store-'))
    roots.push(root)
    const store = new ApiServerStore(join(root, 'server.json'), cipher)
    const input = configuration()
    await store.save({ ...input, upstreams: [{ ...input.upstreams[0], apiKey: '' }] })

    await expect(store.summary()).resolves.toMatchObject({ upstreams: [{ hasApiKey: false, keyPreview: '' }] })
    await expect(store.getUpstreamKey('upstream')).resolves.toBeNull()
    await expect(store.runtimeConfig()).resolves.toMatchObject({ upstreams: [{ apiKey: '' }] })
  })

  it('returns a safe empty default when no file exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'api-server-store-'))
    roots.push(root)
    const store = new ApiServerStore(join(root, 'missing.json'), cipher)
    await expect(store.summary()).resolves.toMatchObject({ port: 8888, autoStart: false })
  })

  it('loads version 1 files written before credential source references were added', async () => {
    const root = await mkdtemp(join(tmpdir(), 'api-server-store-'))
    roots.push(root)
    const path = join(root, 'legacy.json')
    await writeFile(path, JSON.stringify({
      version: 1,
      port: 8888,
      autoStart: false,
      accessKeys: [],
      upstreams: [],
      routes: []
    }))
    const store = new ApiServerStore(path, cipher)
    await expect(store.summary()).resolves.toMatchObject({ credentialSources: [] })
    await expect(store.runtimeConfig()).resolves.toMatchObject({ credentialSources: [], codexBinding: null })
  })
})
