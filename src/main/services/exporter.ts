import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import type {
  CredentialExportFormat,
  CredentialExportLayout,
  CredentialExportResult,
  NormalizedCredential
} from '../../shared/types'
import {
  serializeCodexCredential as codexCredentialDocument,
  serializeCpaCredential
} from '../accounts/credential-formats'

export { serializeCpaCredential } from '../accounts/credential-formats'

interface VaultReader {
  list(): Promise<NormalizedCredential[]>
  get(id: string): Promise<NormalizedCredential | null>
}

interface CredentialExportServiceOptions {
  vault: VaultReader
  now?: () => Date
}

interface ExportAccountsOptions {
  accountIds: string[]
  format: CredentialExportFormat
  layout: CredentialExportLayout
  outputDirectory: string
}

interface Sub2ApiAccount {
  name: string
  notes: null
  platform: 'openai'
  type: 'oauth'
  credentials: Record<string, string | number | boolean>
  extra: Record<string, string>
  proxy_key: null
  concurrency: number
  priority: number
  rate_multiplier: number
  expires_at?: number
  auto_pause_on_expired: true
}

export interface Sub2ApiBundle {
  type: 'sub2api-data'
  version: 1
  exported_at: string
  proxies: never[]
  accounts: Sub2ApiAccount[]
}

function unixSeconds(value: string | null): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1_000) : null
}

export function serializeCodexCredential(
  credential: NormalizedCredential
): Record<string, unknown> {
  return codexCredentialDocument(credential).value
}

function sub2ApiAccount(credential: NormalizedCredential): Sub2ApiAccount {
  const expiry = unixSeconds(credential.accessExpiresAt)
  const name = credential.email ?? `account-${credential.id.slice(0, 10)}`
  return {
    name,
    notes: null,
    platform: 'openai',
    type: 'oauth',
    credentials: {
      ...(credential.authKind === 'personal_access_token'
        ? {
            auth_mode: 'personalAccessToken',
            openai_auth_mode: 'personal_access_token',
            personal_access_token: credential.accessToken
          }
        : {}),
      access_token: credential.accessToken,
      ...(credential.refreshToken ? { refresh_token: credential.refreshToken } : {}),
      ...(credential.oauthClientId ? { client_id: credential.oauthClientId } : {}),
      ...(credential.isFedRamp !== null && credential.isFedRamp !== undefined
        ? { chatgpt_account_is_fedramp: credential.isFedRamp }
        : {}),
      ...(credential.idToken ? { id_token: credential.idToken } : {}),
      ...(credential.accountId ? { chatgpt_account_id: credential.accountId } : {}),
      ...(credential.subject ? { chatgpt_user_id: credential.subject } : {}),
      ...(credential.email ? { email: credential.email } : {}),
      ...(credential.planType
        ? {
            plan_type: credential.planType,
            chatgpt_plan_type: credential.planType
          }
        : {}),
      ...(expiry !== null ? { expires_at: expiry } : {})
    },
    extra: {
      ...(credential.email ? { email: credential.email } : {}),
      ...(credential.lastRefresh ? { last_refresh: credential.lastRefresh } : {})
    },
    proxy_key: null,
    concurrency: 10,
    priority: 1,
    rate_multiplier: 1,
    ...(expiry !== null ? { expires_at: expiry } : {}),
    auto_pause_on_expired: true
  }
}

export function serializeSub2ApiBundle(
  credentials: readonly NormalizedCredential[],
  exportedAt = new Date()
): Sub2ApiBundle {
  return {
    type: 'sub2api-data',
    version: 1,
    exported_at: exportedAt.toISOString(),
    proxies: [],
    accounts: credentials.map(sub2ApiAccount)
  }
}

function jsonBytes(value: unknown): Uint8Array {
  return strToU8(`${JSON.stringify(value, null, 2)}\n`)
}

function safeStem(credential: NormalizedCredential): string {
  const raw = credential.email ?? credential.accountId ?? credential.id.slice(0, 12)
  const sanitized = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .slice(0, 100)
  return sanitized || credential.id.slice(0, 12)
}

function timestampStem(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
}

function suffixedName(filename: string, suffix: number): string {
  if (suffix <= 1) return filename
  const extensionIndex = filename.lastIndexOf('.')
  return extensionIndex > 0
    ? `${filename.slice(0, extensionIndex)}-${suffix}${filename.slice(extensionIndex)}`
    : `${filename}-${suffix}`
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function availablePath(directory: string, filename: string): Promise<string> {
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const candidate = join(directory, suffixedName(filename, suffix))
    if (!(await exists(candidate))) return candidate
  }
  throw new Error(`无法为 ${basename(filename)} 生成可用文件名`)
}

async function atomicCreate(path: string, data: Uint8Array): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, data, { mode: 0o600, flag: 'wx' })
  try {
    try {
      await link(temporaryPath, path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!['EPERM', 'EACCES', 'ENOTSUP', 'EXDEV', 'UNKNOWN'].includes(code ?? '')) throw error
      await copyFile(temporaryPath, path, constants.COPYFILE_EXCL)
    }
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

function archiveEntries(
  credentials: readonly NormalizedCredential[],
  format: 'cpa' | 'codex'
): Record<string, Uint8Array> {
  const entries: Record<string, Uint8Array> = {}
  const used = new Set<string>()
  for (const credential of credentials) {
    const base = `${format === 'codex' ? 'auth' : 'codex'}-${safeStem(credential)}.json`
    let suffix = 1
    let name = base
    while (used.has(name.toLowerCase())) {
      suffix += 1
      name = suffixedName(base, suffix)
    }
    used.add(name.toLowerCase())
    entries[name] = jsonBytes(
      format === 'codex' ? serializeCodexCredential(credential) : serializeCpaCredential(credential)
    )
  }
  return entries
}

export class CredentialExportService {
  private readonly now: () => Date

  constructor(private readonly options: CredentialExportServiceOptions) {
    this.now = options.now ?? (() => new Date())
  }

  async exportAccounts(options: ExportAccountsOptions): Promise<CredentialExportResult> {
    if (options.accountIds.length === 0) throw new Error('没有选择要导出的账号')
    const directoryInfo = await stat(options.outputDirectory).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(options.outputDirectory, { recursive: true })
      return stat(options.outputDirectory)
    })
    if (!directoryInfo.isDirectory()) throw new Error('导出目标不是文件夹')

    const all = new Map((await this.options.vault.list()).map((item) => [item.id, item]))
    const credentials = [...new Set(options.accountIds)].map((id) => {
      const credential = all.get(id)
      if (!credential) throw new Error(`账号不存在：${id}`)
      return credential
    })
    const files: string[] = []
    const errors: string[] = []

    if (options.layout === 'bundle') {
      const now = this.now()
      const filename =
        options.format === 'cpa'
          ? `codex-accounts-${timestampStem(now)}.zip`
          : options.format === 'codex'
            ? `codex-auth-files-${timestampStem(now)}.zip`
            : `sub2api-account-${timestampStem(now)}.json`
      const path = await availablePath(options.outputDirectory, filename)
      const data =
        options.format === 'cpa'
          ? zipSync(archiveEntries(credentials, 'cpa'), { level: 6 })
          : options.format === 'codex'
            ? zipSync(archiveEntries(credentials, 'codex'), { level: 6 })
            : jsonBytes(serializeSub2ApiBundle(credentials, now))
      await atomicCreate(path, data)
      files.push(path)
    } else {
      for (const credential of credentials) {
        const prefix = options.format === 'cpa' ? 'codex' : options.format === 'codex' ? 'auth' : 'sub2api'
        const filename = `${prefix}-${safeStem(credential)}.json`
        try {
          const path = await availablePath(options.outputDirectory, filename)
          const value =
            options.format === 'cpa'
              ? serializeCpaCredential(credential)
              : options.format === 'codex'
                ? serializeCodexCredential(credential)
                : serializeSub2ApiBundle([credential], this.now())
          await atomicCreate(path, jsonBytes(value))
          files.push(path)
        } catch {
          errors.push(`${safeStem(credential)}：写入失败`)
        }
      }
    }

    return {
      ok: errors.length === 0,
      cancelled: false,
      exported: files.length === 1 && options.layout === 'bundle' ? credentials.length : files.length,
      files,
      errors,
      message: errors.length === 0 ? `已导出 ${credentials.length} 个账号` : `已导出 ${files.length} 个文件，部分失败`
    }
  }
}
