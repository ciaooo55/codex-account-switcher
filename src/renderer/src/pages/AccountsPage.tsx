import {
  BadgeCheck,
  CheckCircle2,
  Code2,
  Download,
  KeyRound,
  LoaderCircle,
  MessagesSquare,
  MoreHorizontal,
  Play,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Search,
  Square,
  TestTube2,
  Trash2,
  Wrench
} from 'lucide-react'
import type { Dispatch, MouseEvent, SetStateAction } from 'react'
import type { AppSnapshot } from '../../../shared/ipc'
import type {
  AccountSummary,
  CodexTestMode,
  DisplayAccountStatus
} from '../../../shared/types'
import { ACCOUNT_SORT_OPTIONS, type AccountSortMode } from '../account-sort'
import {
  buildAccountFacets,
  type AccountFacetFilters as AccountFacetFilterValues
} from '../account-filters'
import { displayStatus, STATUS_LABELS } from '../account-status'
import { AccountFacetFilters } from '../components/AccountFacetFilters'
import {
  CODEX_TEST_MODE_RUNNING,
  CODEX_TEST_MODE_SUCCESS,
  CodexTestModeControl
} from '../components/CodexTestModeControl'
import { CurrentAccountOverview } from '../components/CurrentAccountOverview'
import { StatusFilterStrip, type StatusCategoryAction } from '../components/StatusFilterStrip'
import { AccountMetadataChips } from '../components/accounts/AccountMetadataChips'
import { Quota } from '../components/accounts/Quota'
import type { useVirtualTableRows } from '../hooks/useVirtualTableRows'
import { dateTime, sourceFileName } from '../lib/format'
import { Button, PageView, SearchField, Select, Toolbar, ToolbarGroup } from '@/components/ui'
import { cn } from '@/lib/cn'
import { codexApi } from '../services/codexApi'

type VirtualAccounts = ReturnType<typeof useVirtualTableRows<AccountSummary>>

export type AccountsPageProps = {
  snapshot: AppSnapshot
  accounts: AccountSummary[]
  activeAccount: AccountSummary | null
  selectedAccount: AccountSummary | null
  selected: Set<string>
  setSelected: Dispatch<SetStateAction<Set<string>>>
  toggle: (id: string) => void
  selectAccountRow: (id: string) => void
  keyword: string
  setKeyword: (value: string) => void
  statusFilter: DisplayAccountStatus | ''
  setStatusFilter: (value: DisplayAccountStatus | '') => void
  facetFilters: AccountFacetFilterValues
  setFacetFilters: Dispatch<SetStateAction<AccountFacetFilterValues>>
  accountSort: AccountSortMode
  setAccountSort: (value: AccountSortMode) => void
  testMode: CodexTestMode
  setTestMode: (value: CodexTestMode) => void
  accountFacets: ReturnType<typeof buildAccountFacets>
  availableAccountFacets: ReturnType<typeof buildAccountFacets>
  runningAccountIds: Set<string>
  virtualAccounts: VirtualAccounts
  busy: boolean
  clock: number
  switchCapability: (account: AccountSummary) => string
  handleCodexCategoryAction: (action: StatusCategoryAction, category: DisplayAccountStatus | '') => void
  handleCodexGroupAction: (action: StatusCategoryAction, group: string) => void
  run(action: () => Promise<unknown>, success: string): unknown
  runScan(action: () => Promise<unknown>, success: string): unknown
  runTest(action: () => Promise<unknown>, success: string): unknown
  openExport: () => void
  openSettingsDialog: () => void
  inspectLibraries: () => Promise<void>
  switchSelected: () => Promise<void>
  openSessionRepair: () => Promise<void>
  setConversationOpen: (open: boolean) => void
  deleteAccounts: (ids?: string[]) => Promise<void>
  openContextMenu: (event: MouseEvent, account: AccountSummary) => void
}

export function AccountsPage(props: AccountsPageProps): React.JSX.Element {
  const {
    snapshot,
    accounts,
    activeAccount,
    selectedAccount,
    selected,
    setSelected,
    toggle,
    selectAccountRow,
    keyword,
    setKeyword,
    statusFilter,
    setStatusFilter,
    facetFilters,
    setFacetFilters,
    accountSort,
    setAccountSort,
    testMode,
    setTestMode,
    accountFacets,
    availableAccountFacets,
    runningAccountIds,
    virtualAccounts,
    busy,
    clock,
    switchCapability,
    handleCodexCategoryAction,
    handleCodexGroupAction,
    run,
    runScan,
    runTest,
    openExport,
    openSettingsDialog,
    inspectLibraries,
    switchSelected,
    openSessionRepair,
    setConversationOpen,
    deleteAccounts,
    openContextMenu
  } = props

  return (
    <PageView className="accounts-view">
      <section className="library-overview codex-overview flex flex-wrap items-stretch gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-0)] p-2">
        <div><span>账号库</span><strong>{snapshot.accounts.length} 个账号</strong></div>
        <CurrentAccountOverview
          account={activeAccount}
          running={Boolean(activeAccount && runningAccountIds.has(activeAccount.id))}
          now={clock}
          disabled={busy || snapshot.testing.active}
          onRefresh={() => {
            if (!activeAccount) return
            void runTest(
        () => codexApi().testAccounts([activeAccount.id], 'usage'),
              '当前账号额度已刷新'
            )
          }}
        />
        <div><span>自动切换</span><strong className={snapshot.autoSwitch.enabled ? 'text-ok' : ''}>{snapshot.autoSwitch.running ? '检测中' : snapshot.autoSwitch.enabled ? '已启用' : '关闭'}</strong></div>
        <div className="library-path"><span>本地账号目录</span><strong title={`${snapshot.importDirectory}\\codex`}>{snapshot.importDirectory}\\codex</strong></div>
      </section>
      <StatusFilterStrip
        value={statusFilter}
        counts={accountFacets.statusCounts}
        total={snapshot.accounts.length}
        onChange={setStatusFilter}
        label="Codex 账号状态"
        onAction={handleCodexCategoryAction}
        disabled={busy || snapshot.testing.active}
        groups={availableAccountFacets.groups}
        groupValue={facetFilters.group}
        onGroupChange={(group) => setFacetFilters((current) => ({ ...current, group }))}
        onGroupAction={handleCodexGroupAction}
      />

      <Toolbar className="codex-toolbar">
        <ToolbarGroup>
        <Button onClick={() => void runScan(() => codexApi().scanDirectory(), 'aa 重新扫描完成')} disabled={busy}>
          <RefreshCw size={16} />重新扫描
        </Button>
        <Button onClick={() => openExport()} disabled={busy || snapshot.accounts.length === 0}>
          <Download size={16} />导出账号
        </Button>
        </ToolbarGroup>
        <ToolbarGroup>
        <CodexTestModeControl value={testMode} onChange={setTestMode} disabled={busy || snapshot.testing.active} />
        <Button
          onClick={() => void runTest(
        () => codexApi().testAccounts(accounts.map((account) => account.id), testMode),
            `当前筛选 ${accounts.length} 个账号${CODEX_TEST_MODE_SUCCESS[testMode]}`
          )}
          disabled={busy || snapshot.testing.active || accounts.length === 0}
        >
          <TestTube2 size={16} />测试当前页面全部
        </Button>
        {snapshot.testing.active && !snapshot.autoSwitch.running && (
          <Button variant="danger" onClick={() => void codexApi().cancelTests()}>
            <Square size={15} />取消
          </Button>
        )}
        </ToolbarGroup>
        <details className="action-menu toolbar-end" onClick={(event) => {
          if ((event.target as Element).closest('button')) event.currentTarget.removeAttribute('open')
        }}>
          <summary><MoreHorizontal size={17} />更多</summary>
          <div className="action-menu-popover">
            <Button onClick={() => void run(async () => {
              const result = await codexApi().restoreLatest(true)
              if (!result.ok) throw new Error(result.message)
            }, '已恢复上一个配置')} disabled={busy}>
              <RotateCcw size={16} />恢复上一个
            </Button>
            <Button onClick={() => void run(async () => {
              const result = await codexApi().restoreApiMode(true)
              if (!result.ok) throw new Error(result.message)
            }, '已恢复原 API/代理模式')} disabled={busy}>
              <RotateCcw size={16} />恢复备份 API
            </Button>
            <Button onClick={openSettingsDialog} disabled={busy}>
              <KeyRound size={16} />自定义 API
            </Button>
            <Button onClick={() => void inspectLibraries()} disabled={busy}>
              <ScanSearch size={16} />账号库体检
            </Button>
          </div>
        </details>
      </Toolbar>

      <div className={cn('selection-toolbar flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2', selected.size === 0 && 'is-idle')} aria-label="选中账号操作">
        <div className="selection-summary">
          <CheckCircle2 size={15} />
          <strong>{selected.size > 0 ? `已选择 ${selected.size} 个账号` : '未选择账号'}</strong>
          <span>{selected.size === 0 ? '点击账号行可单选或多选' : selected.size === 1 ? selectedAccount?.alias ?? selectedAccount?.email ?? '' : '切换操作仅对单个账号可用'}</span>
        </div>
        <Button onClick={() => void runTest(
        () => codexApi().testAccounts([...selected], testMode), `选中账号${CODEX_TEST_MODE_SUCCESS[testMode]}`)} disabled={busy || snapshot.testing.active || selected.size === 0}>
          <Play size={16} />测试选中
        </Button>
        <Button variant="default" onClick={() => void switchSelected()} disabled={busy || !selectedAccount?.switchable} title={selectedAccount && !selectedAccount.switchable ? '该账号缺少可供 Codex 使用的认证材料' : '切换后会同步当前会话并重启 Codex'}>
          <RotateCcw size={16} />切换并重启
        </Button>
        <Button onClick={() => void openSessionRepair()} disabled={busy}>
          <Wrench size={16} />修复历史会话
        </Button>
        <Button onClick={() => setConversationOpen(true)} disabled={busy}>
          <MessagesSquare size={16} />对话管理
        </Button>
        <Button variant="danger" onClick={() => void deleteAccounts()} disabled={busy || snapshot.testing.active || selected.size === 0}>
          <Trash2 size={16} />删除选中
        </Button>
      </div>

      <div className="filter-row flex flex-wrap items-center gap-2">
        <SearchField
          icon={<Search size={16} />}
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索邮箱、文件或错误"
        />
        <AccountFacetFilters
          label="Codex"
          facets={availableAccountFacets}
          value={facetFilters}
          onChange={setFacetFilters}
        />
        <Select className="visually-hidden" aria-label="Codex 状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as DisplayAccountStatus | '')}>
          <option value="">全部状态</option>
          {Object.entries(STATUS_LABELS).filter(([value]) =>
            (accountFacets.statusCounts[value as DisplayAccountStatus] ?? 0) > 0 || statusFilter === value
          ).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>
        <Select aria-label="Codex 账号排序" value={accountSort} onChange={(event) => setAccountSort(event.target.value as AccountSortMode)}>
          {ACCOUNT_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </Select>
        <span className="selection-count">显示 {accounts.length} / {snapshot.accounts.length} · 已选 {selected.size}</span>
      </div>

      <div className="table-wrap min-h-0 flex-1 overflow-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-0)]" ref={virtualAccounts.scrollRef}>
        <table>
          <thead>
            <tr>
              <th className="select-column"><input type="checkbox" aria-label="选择全部" checked={accounts.length > 0 && accounts.every((item) => selected.has(item.id))} onChange={(event) => setSelected(event.target.checked ? new Set(accounts.map((item) => item.id)) : new Set())} /></th>
              <th>账号</th><th>状态</th><th>计划</th><th>用量与重置</th><th>凭据时间</th><th>来源</th>
            </tr>
          </thead>
          <tbody>
            {virtualAccounts.paddingTop > 0 && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={7} style={{ height: virtualAccounts.paddingTop }} /></tr>}
            {virtualAccounts.rows.map(({ index, item: account }) => {
              const running = runningAccountIds.has(account.id)
              return (
              <tr
                key={account.id}
                data-index={index}
                ref={virtualAccounts.enabled ? virtualAccounts.measureElement : undefined}
                className={`account-row status-row-${displayStatus(account.status)}${account.active ? ' active-row' : ''}${running ? ' testing-row' : ''}${selected.has(account.id) ? ' selected-row' : ''}`}
                aria-busy={running}
                aria-current={account.active ? 'true' : undefined}
                tabIndex={0}
                onClick={() => selectAccountRow(account.id)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  selectAccountRow(account.id)
                }}
                onContextMenu={(event) => openContextMenu(event, account)}
              >
                <td><input type="checkbox" aria-label={`选择 ${account.email ?? account.sourcePath}`} checked={selected.has(account.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggle(account.id)} /></td>
                <td>
                  <div className="account-title-line"><div className="account-email">{account.alias ?? account.email ?? '邮箱未知'}</div>{account.active && <span className="active-badge"><BadgeCheck size={12} />正在使用</span>}</div>
                  {account.alias && <div className="account-secondary-email">{account.email ?? '邮箱未知'}</div>}
                  <div className="workspace-id">{account.workspaceId ?? 'workspace 未知'} · {switchCapability(account)}</div>
                  <AccountMetadataChips account={account} />
                  <div className="compact-row-meta">{account.planType ?? '未知'} · {sourceFileName(account.sourcePath)}</div>
                </td>
                <td>
                  {running ? (
                    <><span className="status status-testing"><LoaderCircle className="spin" size={13} />检测中</span><div className="status-detail">{CODEX_TEST_MODE_RUNNING[testMode]}</div></>
                  ) : (
                    <><span className={`status status-${displayStatus(account.status)}`}>{STATUS_LABELS[displayStatus(account.status)]}</span><div className="status-detail" title={account.detail}>{account.detail}</div></>
                  )}
                </td>
                <td>{account.planType ?? '-'}</td>
                <td><Quota account={account} running={running} now={clock} /></td>
                <td><div>刷新 {dateTime(account.lastRefresh)}</div><div className="muted">Token 到期 {dateTime(account.accessExpiresAt)}</div><div className="muted">检测 {dateTime(account.lastCheckedAt)}</div></td>
                <td><div className="source-path" title={account.sourcePath}>{sourceFileName(account.sourcePath)}</div><div className="source-tags"><span className="provider-label codex"><Code2 size={11} />CODEX</span><span className="format-label">{account.sourceDialect.toUpperCase()} · {account.sourceFormat.toUpperCase()}</span></div></td>
              </tr>
              )
            })}
            {virtualAccounts.paddingBottom > 0 && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={7} style={{ height: virtualAccounts.paddingBottom }} /></tr>}
            {accounts.length === 0 && <tr><td colSpan={7} className="empty-state">没有匹配的账号</td></tr>}
          </tbody>
        </table>
      </div>
    </PageView>
  )
}
