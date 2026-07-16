import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SecretCipher } from '../../shared/types'
import { CustomApiStore } from './custom-api-store'

const roots: string[] = []
const cipher: SecretCipher = {
  encrypt: (value) => Buffer.from(value).toString('base64'),
  decrypt: (value) => Buffer.from(value, 'base64').toString('utf8')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('CustomApiStore', () => {
  it('persists the API key encrypted and only exposes its presence in summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'custom-api-store-'))
    roots.push(root)
    const path = join(root, 'custom-api.json')
    const store = new CustomApiStore(path, cipher)

    await store.saveKey('live-custom-secret')

    expect(await readFile(path, 'utf8')).not.toContain('live-custom-secret')
    await expect(store.getKey()).resolves.toBe('live-custom-secret')
    await expect(store.summary({ baseUrl: 'https://proxy.example.com/v1', model: 'gpt-custom' })).resolves.toEqual({
      baseUrl: 'https://proxy.example.com/v1',
      model: 'gpt-custom',
      hasApiKey: true
    })
  })
})
