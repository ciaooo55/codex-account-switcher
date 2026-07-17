import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { readCpaDirectoryStats } from './cpa-directory-stats'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function token(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cpa-directory-stats-'))
  roots.push(root)
  await mkdir(join(root, 'nested'))
  return root
}

describe('readCpaDirectoryStats', () => {
  it('classifies credentials by parsed content instead of filename prefixes', async () => {
    const root = await directory()
    await writeFile(join(root, 'arbitrary-name.txt'), JSON.stringify({
      type: 'codex',
      email: 'codex@example.com',
      access_token: token({ sub: 'codex-user', email: 'codex@example.com' })
    }))
    await writeFile(join(root, 'nested', 'another-name.md'), JSON.stringify({
      type: 'xai',
      email: 'grok@example.com',
      access_token: token({ iss: 'https://auth.x.ai', sub: 'grok-user' })
    }))
    await writeFile(join(root, 'not-a-credential.json'), '{"hello":"world"}')

    await expect(readCpaDirectoryStats(root)).resolves.toMatchObject({
      credentialFiles: 3,
      codexFiles: 1,
      grokFiles: 1,
      duplicateFiles: 0,
      unrecognizedFiles: 1,
      mixedFiles: 0
    })
  })

  it('counts mixed bundles and redundant physical credential copies', async () => {
    const root = await directory()
    const codex = {
      type: 'codex',
      email: 'same@example.com',
      access_token: token({ sub: 'same-user', email: 'same@example.com' })
    }
    const grok = {
      type: 'xai',
      email: 'grok@example.com',
      access_token: token({ iss: 'https://auth.x.ai', sub: 'grok-user' })
    }
    await writeFile(join(root, 'mixed.json'), JSON.stringify([codex, grok]))
    await writeFile(join(root, 'copy.json.0'), JSON.stringify(codex))

    await expect(readCpaDirectoryStats(root)).resolves.toMatchObject({
      credentialFiles: 2,
      codexFiles: 2,
      grokFiles: 1,
      duplicateFiles: 1,
      unrecognizedFiles: 0,
      mixedFiles: 1
    })
  })

  it('inspects supported entries inside zip imports', async () => {
    const root = await directory()
    const archive = zipSync({
      'accounts/account.json': strToU8(JSON.stringify({
        type: 'codex',
        email: 'zip@example.com',
        access_token: token({ sub: 'zip-user', email: 'zip@example.com' })
      })),
      'ignored.bin': new Uint8Array([0, 1, 2])
    })
    await writeFile(join(root, 'bundle.zip'), archive)

    await expect(readCpaDirectoryStats(root)).resolves.toMatchObject({
      credentialFiles: 1,
      codexFiles: 1,
      grokFiles: 0,
      unrecognizedFiles: 0
    })
  })

  it('rejects a highly compressed oversized zip entry without expanding it', async () => {
    const root = await directory()
    const archive = zipSync({
      'oversized.json': strToU8(' '.repeat(20 * 1024 * 1024 + 1))
    })
    await writeFile(join(root, 'oversized.zip'), archive)

    await expect(readCpaDirectoryStats(root)).resolves.toMatchObject({
      credentialFiles: 1,
      codexFiles: 0,
      grokFiles: 0,
      unrecognizedFiles: 1
    })
  })
})
