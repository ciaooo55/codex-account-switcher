import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

test.describe('Codex Account Switcher Electron workflow', () => {
  let root: string
  let accountDirectory: string
  let codexHome: string
  let exportDirectory: string
  let electronApp: ElectronApplication
  let server: Server
  let baseUrl: string
  const requests: string[] = []

  test.beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-switcher-e2e-'))
    accountDirectory = join(root, 'accounts')
    codexHome = join(root, '.codex')
    const userData = join(root, 'user-data')
    exportDirectory = join(root, 'exports')
    await mkdir(accountDirectory, { recursive: true })
    await mkdir(join(codexHome, 'sessions', '2026'), { recursive: true })
    await mkdir(userData, { recursive: true })
    await mkdir(exportDirectory, { recursive: true })

    const accessToken = jwt({
      sub: 'user-e2e',
      exp: 1_910_000_000,
      'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-e2e' },
      'https://api.openai.com/profile': { email: 'e2e@example.com' }
    })
    const idToken = jwt({
      sub: 'user-e2e',
      exp: 1_910_000_000,
      email: 'e2e@example.com'
    })
    await writeFile(
      join(accountDirectory, 'account.json'),
      JSON.stringify({ access_token: accessToken, id_token: idToken, account_id: 'workspace-e2e' }),
      'utf8'
    )
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'test-api-key' }),
      'utf8'
    )
    await writeFile(
      join(codexHome, 'config.toml'),
      'model_provider = "custom"\nmodel = "proxy-model"\n\n[model_providers.custom]\nbase_url = "http://127.0.0.1:8317/v1"\n',
      'utf8'
    )
    await writeFile(
      join(codexHome, 'sessions', '2026', 'rollout-e2e.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'thread-e2e', cwd: 'C:/work', model_provider: 'custom' } })}\n${JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'unchanged' } })}\n`,
      'utf8'
    )
    const db = new DatabaseSync(join(codexHome, 'state_5.sqlite'))
    db.exec(
      'CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT, has_user_event INTEGER, cwd TEXT)'
    )
    db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run(
      'thread-e2e',
      'custom',
      0,
      'C:/old'
    )
    db.close()
    await writeFile(
      join(userData, 'settings.json'),
      JSON.stringify({
        accountDirectory,
        authPath: join(codexHome, 'auth.json'),
        configPath: join(codexHome, 'config.toml'),
        concurrency: 4,
        timeoutMs: 5_000,
        backupRetention: 5,
        deepTestModel: 'gpt-5.4'
      }),
      'utf8'
    )

    server = createServer((request, response) => {
      requests.push(request.url ?? '')
      response.setHeader('content-type', 'application/json')
      if (request.url === '/usage') {
        response.end(
          JSON.stringify({
            plan_type: 'plus',
            rate_limit: {
              primary_window: {
                used_percent: 23,
                limit_window_seconds: 604_800,
                reset_after_seconds: 86_400
              }
            }
          })
        )
        return
      }
      if (request.url === '/compact') {
        setTimeout(() => response.end(JSON.stringify({ output: [] })), 180)
        return
      }
      response.end(JSON.stringify({ output: [] }))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Failed to start fixture server')
    baseUrl = `http://127.0.0.1:${address.port}`

    electronApp = await electron.launch({
      args: ['.'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODEX_SWITCHER_E2E: '1',
        CODEX_SWITCHER_USER_DATA: userData,
        CODEX_SWITCHER_TEST_API_BASE_URL: baseUrl,
        CODEX_SWITCHER_E2E_EXPORT_DIR: exportDirectory
      }
    })
  })

  test.afterAll(async () => {
    await electronApp?.close()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  })

  test('scans, tests, switches, repairs sessions and restores API mode', async () => {
    const page = await electronApp.firstWindow()
    await expect(page.getByText('e2e@example.com').first()).toBeVisible()

    await page.getByRole('button', { name: '测试全部' }).click()
    await expect(page.getByText('检测中')).toBeVisible()
    await expect(page.getByText('77%')).toBeVisible()
    await expect(page.getByText('Codex 周额度')).toBeVisible()
    await expect(page.getByRole('row', { name: /e2e@example\.com/ })).toHaveClass(/status-row-valid/)
    expect(requests.slice(0, 2)).toEqual(['/compact', '/usage'])

    await page.getByLabel('选择 e2e@example.com').check()
    await page.getByRole('button', { name: '导出账号' }).click()
    await page.getByRole('button', { name: '选择目录并导出' }).click()
    await expect(page.getByText('已导出 1 个账号')).toBeVisible()
    const exportedFiles = await readdir(exportDirectory)
    expect(exportedFiles).toEqual(['codex-e2e@example.com.json'])
    expect(JSON.parse(await readFile(join(exportDirectory, exportedFiles[0]), 'utf8'))).toMatchObject({
      type: 'codex',
      email: 'e2e@example.com'
    })

    const pastedAccess = jwt({
      sub: 'user-pasted-e2e',
      exp: 1_910_000_000,
      'https://api.openai.com/profile': { email: 'pasted-e2e@example.com' }
    })
    await page.getByRole('button', { name: '粘贴导入' }).click()
    await page.getByLabel('凭据文本').fill(
      `账号：\n\`\`\`json\n${JSON.stringify({ type: 'codex', access_token: pastedAccess })}\n\`\`\``
    )
    await page.getByRole('button', { name: '清洗并导入' }).click()
    await expect(page.getByText('pasted-e2e@example.com').first()).toBeVisible()

    await page.getByRole('button', { name: '切换账号' }).click()
    await expect(page.getByText('账号已切换，请重启 Codex 使所有会话生效')).toBeVisible()
    expect(JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8')).auth_mode).toBe(
      'chatgpt'
    )

    await page.getByRole('button', { name: '修复历史会话' }).click()
    await expect(page.getByRole('dialog', { name: '修复历史会话' })).toBeVisible()
    await page.getByRole('button', { name: '确认修复' }).click()
    await expect(page.getByText('历史会话修复完成')).toBeVisible()
    const rollout = await readFile(
      join(codexHome, 'sessions', '2026', 'rollout-e2e.jsonl'),
      'utf8'
    )
    expect(JSON.parse(rollout.split('\n')[0]).payload.model_provider).toBe('openai')
    expect(JSON.parse(rollout.split('\n')[1]).payload.message).toBe('unchanged')

    await page.getByRole('button', { name: '恢复 API 模式' }).click()
    await expect(page.getByText('已恢复原 API/代理模式')).toBeVisible()
    expect(JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8')).auth_mode).toBe(
      'apikey'
    )
    expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).toContain(
      'model_provider = "custom"'
    )
  })
})
