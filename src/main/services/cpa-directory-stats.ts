import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import type { CpaDirectoryStats, CredentialSourceFormat } from '../../shared/types'
import { parseCredentialText } from '../accounts/parser'
import { parseGrokCredentialText } from '../accounts/grok-parser'

const MAX_FILE_BYTES = 100 * 1024 * 1024
const MAX_ZIP_BYTES = 25 * 1024 * 1024
const MAX_ZIP_ENTRIES = 2_000
const MAX_ZIP_ENTRY_BYTES = 20 * 1024 * 1024
const MAX_ZIP_TOTAL_BYTES = 100 * 1024 * 1024
const FORMATS: Record<string, CredentialSourceFormat | undefined> = {
  '.json': 'json',
  '.jsonl': 'jsonl',
  '.txt': 'txt',
  '.md': 'md',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.zip': 'zip'
}

interface FileCredentialIds {
  codex: Set<string>
  grok: Set<string>
}

function formatForPath(path: string): CredentialSourceFormat | undefined {
  if (/\.json\.(?:0|无权限|无用量)$/i.test(path)) return 'json'
  return FORMATS[extname(path).toLowerCase()]
}

async function supportedFiles(directory: string): Promise<string[]> {
  const result: string[] = []
  const stack = [directory]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile() && formatForPath(path)) result.push(path)
    }
  }
  return result.sort((left, right) => left.localeCompare(right))
}

function parseText(
  text: string,
  sourcePath: string,
  format: Exclude<CredentialSourceFormat, 'zip'>,
  ids: FileCredentialIds
): void {
  for (const credential of parseCredentialText(text, { sourcePath, format }).credentials) {
    ids.codex.add(credential.id)
  }
  for (const credential of parseGrokCredentialText(text, { sourcePath, format }).credentials) {
    ids.grok.add(credential.id)
  }
}

async function credentialIds(path: string): Promise<FileCredentialIds> {
  const ids: FileCredentialIds = { codex: new Set(), grok: new Set() }
  const format = formatForPath(path)
  if (!format) return ids
  if ((await stat(path)).size > MAX_FILE_BYTES) return ids

  if (format !== 'zip') {
    parseText(await readFile(path, 'utf8'), path, format, ids)
    return ids
  }

  const bytes = await readFile(path)
  if (bytes.byteLength > MAX_ZIP_BYTES) throw new Error('ZIP file exceeds the safety limit')
  let entriesSeen = 0
  let totalBytes = 0
  const archive = unzipSync(new Uint8Array(bytes), {
    filter: (entry) => {
      entriesSeen += 1
      if (entriesSeen > MAX_ZIP_ENTRIES) throw new Error('ZIP entry count exceeds the safety limit')
      if (entry.originalSize > MAX_ZIP_ENTRY_BYTES) throw new Error('ZIP entry exceeds the safety limit')
      totalBytes += entry.originalSize
      if (totalBytes > MAX_ZIP_TOTAL_BYTES) throw new Error('ZIP expanded size exceeds the safety limit')
      const normalizedName = entry.name.replace(/\\/g, '/')
      if (
        normalizedName.startsWith('/') ||
        normalizedName.split('/').includes('..') ||
        /^[A-Za-z]:/.test(normalizedName)
      ) throw new Error('ZIP contains an unsafe path')
      const nestedFormat = formatForPath(normalizedName)
      return Boolean(nestedFormat && nestedFormat !== 'zip')
    }
  })
  for (const [entryName, data] of Object.entries(archive)) {
    const nestedFormat = formatForPath(entryName)
    if (!nestedFormat || nestedFormat === 'zip') continue
    parseText(strFromU8(data), `${path}#${entryName}`, nestedFormat, ids)
  }
  return ids
}

export async function readCpaDirectoryStats(directory: string): Promise<CpaDirectoryStats> {
  const paths = await supportedFiles(directory)
  const seenCodex = new Set<string>()
  const seenGrok = new Set<string>()
  let codexFiles = 0
  let grokFiles = 0
  let duplicateFiles = 0
  let unrecognizedFiles = 0
  let mixedFiles = 0

  for (const path of paths) {
    let ids: FileCredentialIds
    try {
      ids = await credentialIds(path)
    } catch {
      unrecognizedFiles += 1
      continue
    }
    const hasCodex = ids.codex.size > 0
    const hasGrok = ids.grok.size > 0
    if (hasCodex) codexFiles += 1
    if (hasGrok) grokFiles += 1
    if (hasCodex && hasGrok) mixedFiles += 1
    if (!hasCodex && !hasGrok) {
      unrecognizedFiles += 1
      continue
    }

    const repeated = [...ids.codex].some((id) => seenCodex.has(id)) ||
      [...ids.grok].some((id) => seenGrok.has(id))
    if (repeated) duplicateFiles += 1
    for (const id of ids.codex) seenCodex.add(id)
    for (const id of ids.grok) seenGrok.add(id)
  }

  return {
    credentialFiles: paths.length,
    codexFiles,
    grokFiles,
    duplicateFiles,
    unrecognizedFiles,
    mixedFiles
  }
}
