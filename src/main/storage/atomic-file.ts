import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function atomicWriteFile(
  path: string,
  data: string | Uint8Array,
  mode = 0o600
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  await writeFile(temporaryPath, data, { mode })
  try {
    await rename(temporaryPath, path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM') throw error

    const previousPath = `${path}.${randomUUID()}.previous`
    let previousMoved = false
    let replacementInstalled = false
    try {
      await rename(path, previousPath)
      previousMoved = true
      await rename(temporaryPath, path)
      replacementInstalled = true
      await rm(previousPath, { force: true })
    } catch (replacementError) {
      if (previousMoved) {
        if (replacementInstalled) await rm(path, { force: true })
        if (!(await exists(path))) await rename(previousPath, path)
      }
      throw replacementError
    }
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

export async function readUtf8File(path: string): Promise<string> {
  return readFile(path, 'utf8')
}
