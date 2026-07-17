import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
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
  let userData: string
  let importSourceDirectory: string
  let exportDirectory: string
  let electronApp: ElectronApplication
  let server: Server
  let baseUrl: string
  let accessToken: string
  let idToken: string
  const requests: string[] = []

  test.beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-switcher-e2e-'))
    accountDirectory = join(root, 'accounts')
    codexHome = join(root, '.codex')
    userData = join(root, 'user-data')
    importSourceDirectory = join(root, 'folder-import')
    exportDirectory = join(root, 'exports')
    await mkdir(accountDirectory, { recursive: true })
    await mkdir(join(codexHome, 'sessions', '2026'), { recursive: true })
    await mkdir(userData, { recursive: true })
    await mkdir(join(userData, 'aa'), { recursive: true })
    await mkdir(join(userData, 'grok-accounts'), { recursive: true })
    await mkdir(importSourceDirectory, { recursive: true })
    await mkdir(exportDirectory, { recursive: true })

    accessToken = jwt({
      sub: 'user-e2e',
      exp: 1_910_000_000,
      'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-e2e' },
      'https://api.openai.com/profile': { email: 'e2e@example.com' }
    })
    idToken = jwt({
      sub: 'user-e2e',
      exp: 1_910_000_000,
      email: 'e2e@example.com'
    })
    await writeFile(
      join(userData, 'aa', 'account.json'),
      JSON.stringify({
        access_token: accessToken,
        id_token: idToken,
        refresh_token: 'refresh-e2e',
        account_id: 'workspace-e2e'
      }),
      'utf8'
    )
    await writeFile(
      join(userData, 'aa', 'team-account.json'),
      JSON.stringify({
        type: 'codex',
        access_token: jwt({
          sub: 'user-team-e2e',
          exp: 1_910_000_000,
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'workspace-team-e2e',
            chatgpt_plan_type: 'k12'
          },
          'https://api.openai.com/profile': { email: 'team-e2e@example.com' }
        }),
        account_id: 'workspace-team-e2e',
        plan_type: 'k12'
      }),
      'utf8'
    )
    const grokAccessToken = jwt({ iss: 'https://auth.x.ai', sub: 'grok-e2e', exp: 1_910_000_000 })
    await writeFile(
      join(userData, 'grok-accounts', 'grok-e2e.json'),
      JSON.stringify({
        type: 'xai',
        access_token: grokAccessToken,
        refresh_token: 'grok-refresh-e2e',
        email: 'grok-e2e@example.com',
        sub: 'grok-e2e',
        team_id: 'team-grok-e2e'
      }),
      'utf8'
    )
    await writeFile(
      join(importSourceDirectory, 'folder-accounts.md'),
      `# Imported accounts\n\n\`\`\`json\n${JSON.stringify([{
        type: 'codex', access_token: jwt({ sub: 'folder-e2e', exp: 1_910_000_000 }), email: 'folder-e2e@example.com'
      }, {
        type: 'xai', access_token: grokAccessToken, email: 'grok-e2e@example.com', sub: 'grok-e2e', team_id: 'team-grok-e2e'
      }])}\n\`\`\``,
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
        deepTestModel: 'gpt-5.4',
        autoSwitchEnabled: false,
        autoSwitchIntervalSeconds: 300,
        autoSwitchAccountIds: [],
        autoSwitchRestartCodex: true
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
              },
              secondary_window: {
                used_percent: 40,
                limit_window_seconds: 18_000,
                reset_after_seconds: 1_800
              }
            },
            credits: { has_credits: true, unlimited: false, balance: '9.99' },
            spend_control: {
              reached: false,
              individual_limit: { remaining_percent: 68, reset_after_seconds: 86_400 }
            },
            rate_limit_reset_credits: { available_count: 3 }
          })
        )
        return
      }
      if (request.url === '/compact') {
        setTimeout(() => response.end(JSON.stringify({ output: [] })), 180)
        return
      }
      if (request.url === '/grok/billing?format=credits') {
        response.end(JSON.stringify({ config: { currentPeriod: { type: 'weekly', end: '2030-01-08T00:00:00Z' }, creditUsagePercent: 25 } }))
        return
      }
      if (request.url === '/grok/billing') {
        response.end(JSON.stringify({ config: { monthlyLimit: 15000, used: 3000, billingPeriodEnd: '2030-02-01T00:00:00Z' } }))
        return
      }
      if (request.url === '/grok/responses') {
        response.setHeader('content-type', 'text/event-stream')
        response.end('data: {"type":"response.completed","response":{"id":"grok-response-e2e","status":"completed","output":[]}}\n\n')
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
        CODEX_SWITCHER_E2E_EXPORT_DIR: exportDirectory,
        CODEX_SWITCHER_E2E_IMPORT_DIR: importSourceDirectory
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
    const codexRow = (email: string) => page.getByRole('row').filter({
      has: page.getByLabel(`选择 ${email}`, { exact: true })
    }).first()
    await expect(page.getByText('e2e@example.com').first()).toBeVisible()
    await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
      'content',
      /default-src 'self'/
    )

    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize())
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => ({
      count: BrowserWindow.getAllWindows().length,
      minimized: BrowserWindow.getAllWindows()[0]?.isMinimized() ?? false
    }))).toEqual({ count: 1, minimized: true })
    await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.restore())
    await expect(page.getByText('e2e@example.com').first()).toBeVisible()

    await page.getByRole('button', { name: '导入账号' }).click()
    await page.screenshot({ path: join(process.cwd(), 'test-results', 'import-dialog.png'), fullPage: true })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: '导入账号' })).toHaveCount(0)
    await page.getByRole('button', { name: '导入账号' }).click()
    await page.getByRole('button', { name: '导入文件夹' }).click()
    await expect(page.getByText(/导入 1 个 Codex 账号，重复跳过 0 个/)).toBeVisible()
    await expect(page.getByRole('row', { name: /folder-e2e@example\.com/ })).toBeVisible()
    expect(await readdir(join(userData, 'aa'))).toContain('folder-e2e@example.com_unknown.json')
    expect((await readdir(join(userData, 'grok-accounts'))).some((name) => name.startsWith('codex-'))).toBe(false)
    await unlink(join(importSourceDirectory, 'folder-accounts.md'))
    await expect(page.getByRole('row', { name: /folder-e2e@example\.com/ })).toBeVisible()

    const selectAllAccounts = page.getByLabel('选择全部')
    await selectAllAccounts.check()
    await selectAllAccounts.uncheck()
    await page.getByLabel('选择 folder-e2e@example.com', { exact: true }).check()
    await page.getByRole('button', { name: '导出账号' }).click()
    await page.getByRole('button', { name: '直接导出到 CPA' }).click()
    await expect(page.getByText('已导出 1 个到 CPA，重复跳过 0 个')).toBeVisible()
    expect((await readdir(join(userData, 'grok-accounts'))).filter((name) => name.startsWith('codex-'))).toHaveLength(1)

    page.once('dialog', (dialog) => dialog.accept())
    await page.getByRole('button', { name: '删除选中' }).click()
    await expect(page.getByRole('row', { name: /folder-e2e@example\.com/ })).toHaveCount(0)
    expect(await readdir(join(userData, 'aa'))).not.toContain('folder-e2e@example.com_unknown.json')

    const selectionTeamRow = codexRow('team-e2e@example.com')
    const selectionAccountRow = codexRow('e2e@example.com')
    await selectionTeamRow.click()
    await expect(selectionTeamRow).toHaveClass(/selected-row/)
    await expect(page.getByLabel('选择 team-e2e@example.com', { exact: true })).toBeChecked()
    await selectionAccountRow.click()
    await expect(page.getByText('已选择 2 个账号', { exact: true })).toBeVisible()
    await selectionAccountRow.click()
    await expect(page.getByLabel('选择 e2e@example.com', { exact: true })).not.toBeChecked()
    await expect(page.getByLabel('选择 team-e2e@example.com', { exact: true })).toBeChecked()
    await selectionAccountRow.click()

    await page.getByRole('button', { name: '测试当前页面全部' }).click()
    await expect(page.getByText('检测中').first()).toBeVisible()
    const blockedRestart = await page.evaluate(() => window.codexSwitcher.restartCodex())
    expect(blockedRestart).toMatchObject({ ok: false })
    expect(blockedRestart.message).toContain('账号检测正在运行')
    const blockedRepair = await page.evaluate(async () => {
      try {
        await window.codexSwitcher.previewSessionRepair('openai')
        return null
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })
    expect(blockedRepair).toContain('账号检测正在运行')
    await expect(page.getByText('77%').first()).toBeVisible()
    await expect(page.getByText('剩余 24 小时').first()).toBeVisible()
    await expect(page.getByText('剩余 30 分钟').first()).toBeVisible()
    await expect(page.getByText('Codex 周额度').first()).toBeVisible()
    const accountRow = codexRow('e2e@example.com')
    await expect(accountRow).toHaveClass(/status-row-valid/)
    await expect(accountRow).toContainText('额外余额9.99')
    await expect(accountRow).toContainText('支出限额68%')
    await expect(accountRow).toContainText('重置券3')
    await accountRow.hover()
    const cellGeometry = await accountRow.evaluate((row) =>
      [...row.children].filter((child) => child.tagName === 'TD').map((cell) => {
        const bounds = cell.getBoundingClientRect()
        return {
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
          background: getComputedStyle(cell).backgroundColor
        }
      })
    )
    expect(cellGeometry).toHaveLength(7)
    const visibleCells = cellGeometry.filter((cell) => cell.width > 0 && cell.height > 0)
    expect(visibleCells.length).toBeGreaterThanOrEqual(5)
    expect(Math.max(...visibleCells.map((cell) => cell.top)) - Math.min(...visibleCells.map((cell) => cell.top))).toBeLessThanOrEqual(1)
    expect(Math.max(...visibleCells.map((cell) => cell.height)) - Math.min(...visibleCells.map((cell) => cell.height))).toBeLessThanOrEqual(1)
    expect(new Set(visibleCells.map((cell) => cell.background)).size).toBe(1)

    await accountRow.click({ button: 'right', position: { x: 20, y: 20 } })
    const contextMenu = page.getByRole('menu', { name: '账号管理' })
    await expect(contextMenu).toBeVisible()
    const menuBounds = await contextMenu.boundingBox()
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    expect(menuBounds).not.toBeNull()
    expect(menuBounds!.x).toBeGreaterThanOrEqual(8)
    expect(menuBounds!.y).toBeGreaterThanOrEqual(8)
    expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(viewport.width - 8)
    expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(viewport.height - 8)
    await page.keyboard.press('Escape')
    expect(requests.slice(0, 4).sort()).toEqual(['/compact', '/compact', '/usage', '/usage'])

    await page.getByRole('button', { name: /^CPA 账号管理/ }).click()
    const cpaCodexRow = page.getByRole('row', { name: /cpa codex folder-e2e@example\.com/i })
    await expect(cpaCodexRow).toBeVisible()
    await cpaCodexRow.click()
    await page.getByRole('button', { name: '停用 .json.0' }).click()
    await expect.poll(async () => (await readdir(join(userData, 'grok-accounts'))).some((name) => name.startsWith('codex-') && name.endsWith('.json.0'))).toBe(true)
    await page.getByRole('button', { name: '启用 .json' }).click()
    await expect.poll(async () => (await readdir(join(userData, 'grok-accounts'))).some((name) => name.startsWith('codex-') && name.endsWith('.json.0'))).toBe(false)
    await page.screenshot({ path: join(process.cwd(), 'test-results', 'cpa-codex-ui.png'), fullPage: true })

    await page.getByRole('button', { name: /^Grok/ }).click()
    const grokRow = page.getByRole('row', { name: /grok-e2e@example\.com/ })
    await expect(grokRow).toBeVisible()
    const beforeGrok = requests.length
    await page.getByRole('button', { name: '测试当前页面全部' }).click()
    await expect(grokRow).toHaveClass(/status-row-valid/)
    await expect(grokRow).toContainText('周额度75%')
    await page.screenshot({ path: join(process.cwd(), 'test-results', 'cpa-grok-ui.png'), fullPage: true })
    expect(requests.slice(beforeGrok).sort()).toEqual(['/grok/billing', '/grok/billing?format=credits', '/grok/responses'].sort())
    await page.getByRole('button', { name: /^Codex 账号库/ }).click()

    const teamRow = codexRow('team-e2e@example.com')
    await expect(teamRow).toContainText('外部凭据，需重启')
    await teamRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '切换到此账号' }).click()
    await expect(page.getByText('账号已切换，请重启 Codex 使所有会话生效')).toBeVisible()
    expect(JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'))).toMatchObject({
      auth_mode: 'chatgptAuthTokens',
      tokens: {
        refresh_token: '',
        account_id: 'workspace-team-e2e'
      }
    })

    await accountRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '切换到此账号' }).click()
    await expect(page.getByText('账号已切换，请重启 Codex 使所有会话生效')).toBeVisible()
    await expect(accountRow).toHaveAttribute('aria-current', 'true')
    await expect(accountRow.getByText('正在使用')).toBeVisible()
    await page.screenshot({ path: join(process.cwd(), 'test-results', 'accounts-ui-desktop.png'), fullPage: true })
    expect(JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8')).auth_mode).toBe('chatgpt')

    await page.getByLabel('选择 e2e@example.com', { exact: true }).check()
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
    await page.getByRole('button', { name: '导入账号' }).click()
    await page.getByLabel('凭据文本').fill(
      `账号：\n\`\`\`json\n${JSON.stringify({ type: 'codex', access_token: pastedAccess })}\n\`\`\``
    )
    await page.getByRole('button', { name: '清洗并导入' }).click()
    await expect(page.getByText('pasted-e2e@example.com').first()).toBeVisible()

    await page.getByRole('button', { name: '切换账号' }).click()
    await expect(page.getByText('账号已切换，请重启 Codex 使所有会话生效')).toBeVisible()
    expect(JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8'))).toMatchObject({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: idToken,
        access_token: accessToken,
        refresh_token: 'refresh-e2e',
        account_id: 'workspace-e2e'
      }
    })

    await page.getByText('更多', { exact: true }).click()
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

    await page.getByText('更多', { exact: true }).click()
    await page.getByRole('button', { name: '恢复备份 API' }).click()
    await expect(page.getByText('已恢复原 API/代理模式')).toBeVisible()
    expect(JSON.parse(await readFile(join(codexHome, 'auth.json'), 'utf8')).auth_mode).toBe(
      'apikey'
    )
    expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).toContain(
      'model_provider = "custom"'
    )

    await page.setViewportSize({ width: 980, height: 640 })
    const compactTable = await page.locator('.accounts-view .table-wrap').first().evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    }))
    expect(compactTable.scrollWidth).toBeLessThanOrEqual(compactTable.clientWidth + 1)
    await page.screenshot({ path: join(process.cwd(), 'test-results', 'accounts-ui-compact.png'), fullPage: true })
    await page.getByRole('button', { name: '设置' }).click()
    const settingsPanel = page.getByRole('dialog', { name: '设置' })
    await expect(settingsPanel).toBeVisible()
    const panelBounds = await settingsPanel.boundingBox()
    expect(panelBounds).not.toBeNull()
    expect(panelBounds!.x).toBeGreaterThanOrEqual(0)
    expect(panelBounds!.x + panelBounds!.width).toBeLessThanOrEqual(980)
    expect(panelBounds!.height).toBeLessThanOrEqual(640)
    await page.screenshot({
      path: join(process.cwd(), 'test-results', 'settings-ui.png'),
      fullPage: true
    })
    await settingsPanel.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await page.screenshot({
      path: join(process.cwd(), 'test-results', 'settings-ui-bottom.png'),
      fullPage: true
    })

    await settingsPanel.getByRole('button', { name: '取消' }).click()
    await page.getByRole('button', { name: '定时切换' }).click()
    await expect(page.getByLabel('启用定时自动切换')).toBeVisible()
    await expect(page.getByLabel('自动切换候选 e2e@example.com')).toBeEnabled()
    await expect(page.getByLabel('自动切换候选 pasted-e2e@example.com')).toBeDisabled()
    await page.screenshot({
      path: join(process.cwd(), 'test-results', 'automation-ui.png'),
      fullPage: true
    })
    await page.getByLabel('自动切换候选 team-e2e@example.com').check()
    await page.getByLabel('启用定时自动切换').check({ force: true })
    await page.getByRole('button', { name: '保存设置' }).click()
    await expect(page.getByText('自动切换设置已保存')).toBeVisible()

    const teamManagedFile = (await readdir(join(userData, 'aa'))).find((name) =>
      name.startsWith('team-e2e@example.com_')
    )
    expect(teamManagedFile).toBeTruthy()
    await unlink(join(userData, 'aa', teamManagedFile!))
    await page.getByRole('button', { name: /^Codex 账号库/ }).click()
    await page.getByRole('button', { name: '重新扫描' }).click()
    await expect(page.getByText('team-e2e@example.com')).toHaveCount(0)
    await page.getByRole('button', { name: '定时切换' }).click()
    await expect(page.getByLabel('启用定时自动切换')).not.toBeChecked()
    await expect(page.getByText('候选 0 / 1')).toBeVisible()

    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('主窗口不存在')
      window.close()
    })
    await expect
      .poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(0)
    expect(await electronApp.evaluate(({ app }) => app.isReady())).toBe(true)

    const reopenedWindow = electronApp.waitForEvent('window')
    await electronApp.evaluate(({ app }) => {
      Reflect.apply(app.emit, app, ['second-instance', {}, [], process.cwd(), {}])
    })
    const reopenedPage = await reopenedWindow
    await expect(reopenedPage.getByText('e2e@example.com').first()).toBeVisible()
    expect(
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    ).toBe(1)
  })
})
