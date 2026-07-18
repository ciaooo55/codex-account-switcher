import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DirectoryRecordIndex } from './directory-record-index'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('DirectoryRecordIndex', () => {
  it('reuses unchanged parsed records and reloads only changed files after invalidation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-directory-index-'))
    roots.push(directory)
    await mkdir(directory, { recursive: true })
    const first = join(directory, 'first.json')
    const second = join(directory, 'second.json')
    await writeFile(first, 'one')
    await writeFile(second, 'two')
    const loadPath = vi.fn(async (path: string) => [await readFile(path, 'utf8')])
    const index = new DirectoryRecordIndex<string>({
      directory: () => directory,
      collectPaths: async (path) => (await readdir(path)).map((name) => join(path, name)).sort(),
      loadPath
    })

    expect(await index.list()).toEqual(['one', 'two'])
    expect(await index.list()).toEqual(['one', 'two'])
    expect(loadPath).toHaveBeenCalledTimes(2)

    await writeFile(first, 'one changed and longer')
    index.invalidate()
    expect(await index.list()).toEqual(['one changed and longer', 'two'])
    expect(loadPath).toHaveBeenCalledTimes(3)
    index.dispose()
  })
})
