import { LoaderCircle, Play, Search } from 'lucide-react'
import type { Dispatch, SetStateAction } from 'react'
import type { AppSnapshot } from '../../../shared/ipc'
import type { AccountSummary, AppSettings } from '../../../shared/types'
import { ACCOUNT_SORT_OPTIONS, type AccountSortMode } from '../account-sort'
import { displayStatus, STATUS_LABELS } from '../account-status'
import { AccountMetadataChips } from '../components/accounts/AccountMetadataChips'
import { Quota } from '../components/accounts/Quota'
import type { useVirtualTableRows } from '../hooks/useVirtualTableRows'
import { Button, PageView, SearchField, Select } from '@/components/ui'
import { dateTime } from '../lib/format'

type VirtualAccounts = ReturnType<typeof useVirtualTableRows<AccountSummary>>

export type AutomationPageProps = {
  snapshot: AppSnapshot
  settingsDraft: AppSettings
  setSettingsDraft: Dispatch<SetStateAction<AppSettings | null>>
  automationAccounts: AccountSummary[]
  automationKeyword: string
  setAutomationKeyword: (value: string) => void
  automationSort: AccountSortMode
  setAutomationSort: (value: AccountSortMode) => void
  virtualAutomationAccounts: VirtualAccounts
  runningAccountIds: Set<string>
  busy: boolean
  clock: number
  switchCapability: (account: AccountSummary) => string
  saveAutomation: () => Promise<void>
  saveAndRunAutomation: () => Promise<void>
}

export function AutomationPage(props: AutomationPageProps): React.JSX.Element {
  const {
    snapshot,
    settingsDraft,
    setSettingsDraft,
    automationAccounts,
    automationKeyword,
    setAutomationKeyword,
    automationSort,
    setAutomationSort,
    virtualAutomationAccounts,
    runningAccountIds,
    busy,
    clock,
    switchCapability,
    saveAutomation,
    saveAndRunAutomation
  } = props

  return (
    <PageView className="automation-view">
          <section className="automation-status-band flex flex-wrap items-stretch gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-0)] p-2">
            <div><span>运行状态</span><strong className={snapshot.autoSwitch.enabled ? 'text-ok' : ''}>{snapshot.autoSwitch.running ? '正在检查' : snapshot.autoSwitch.enabled ? '已启用' : '未启用'}</strong></div>
            <div><span>当前账号</span><strong>{snapshot.accounts.find((account) => account.active)?.email ?? '未匹配'}</strong></div>
            <div><span>上次检查</span><strong>{dateTime(snapshot.autoSwitch.lastCheckAt)}</strong></div>
            <div><span>下次检查</span><strong>{dateTime(snapshot.autoSwitch.nextCheckAt)}</strong></div>
            <div className="automation-message"><span>结果</span><strong>{snapshot.autoSwitch.lastMessage}</strong></div>
          </section>


          <section className="automation-controls flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2" aria-label="自动切换设置">
            <label className="automation-toggle">
              <span>定时自动切换</span>
              <span className="switch-control">
                <input aria-label="启用定时自动切换" type="checkbox" checked={settingsDraft.autoSwitchEnabled} onChange={(event) => setSettingsDraft({ ...settingsDraft, autoSwitchEnabled: event.target.checked })} />
                <span />
              </span>
            </label>
            <label>检查间隔（秒）<input aria-label="自动切换检查间隔" type="number" min={5} max={86400} value={settingsDraft.autoSwitchIntervalSeconds} onChange={(event) => setSettingsDraft({ ...settingsDraft, autoSwitchIntervalSeconds: Number(event.target.value) })} /></label>
            <label className="check-option"><input type="checkbox" checked={settingsDraft.autoSwitchRestartCodex} onChange={(event) => setSettingsDraft({ ...settingsDraft, autoSwitchRestartCodex: event.target.checked })} />切换成功后重启 Codex</label>
            <span className="automation-spacer" />
            <Button onClick={() => void saveAutomation()} disabled={busy}>保存设置</Button>
            <Button variant="default" onClick={() => void saveAndRunAutomation()} disabled={busy || snapshot.autoSwitch.running || settingsDraft.autoSwitchAccountIds.length === 0}>
              {snapshot.autoSwitch.running ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}立即检查
            </Button>
          </section>

          <div className="automation-filter-row flex flex-wrap items-center gap-2">
            <SearchField icon={<Search size={16} />} value={automationKeyword} onChange={(event) => setAutomationKeyword(event.target.value)} placeholder="搜索候选账号" />
            <Select aria-label="定时切换账号排序" value={automationSort} onChange={(event) => setAutomationSort(event.target.value as AccountSortMode)}>
              {ACCOUNT_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Select>
            <span>候选 {settingsDraft.autoSwitchAccountIds.length} / {snapshot.accounts.filter((account) => account.switchable).length}</span>
            <Button onClick={() => setSettingsDraft({ ...settingsDraft, autoSwitchAccountIds: snapshot.accounts.filter((account) => account.switchable).map((account) => account.id) })}>全选可切换</Button>
            <Button onClick={() => setSettingsDraft({ ...settingsDraft, autoSwitchAccountIds: [] })}>清空</Button>
          </div>

          <div className="table-wrap automation-table-wrap min-h-0 flex-1 overflow-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-0)]" ref={virtualAutomationAccounts.scrollRef}>
            <table className="automation-table">
              <thead><tr><th className="select-column">候选</th><th>账号</th><th>状态</th><th>等级</th><th>当前额度</th><th>最后检测</th></tr></thead>
              <tbody>
                {virtualAutomationAccounts.paddingTop > 0 && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={6} style={{ height: virtualAutomationAccounts.paddingTop }} /></tr>}
                {virtualAutomationAccounts.rows.map(({ index, item: account }) => {
                  const checked = settingsDraft.autoSwitchAccountIds.includes(account.id)
                  const running = runningAccountIds.has(account.id)
                  return (
                    <tr key={account.id} data-index={index} ref={virtualAutomationAccounts.enabled ? virtualAutomationAccounts.measureElement : undefined} className={`account-row status-row-${displayStatus(account.status)}${account.active ? ' active-row' : ''}${running ? ' testing-row' : ''}${checked ? ' selected-row' : ''}`} onClick={() => {
                      if (!account.switchable) return
                      setSettingsDraft({ ...settingsDraft, autoSwitchAccountIds: checked ? settingsDraft.autoSwitchAccountIds.filter((id) => id !== account.id) : [...settingsDraft.autoSwitchAccountIds, account.id] })
                    }}>
                      <td><input type="checkbox" aria-label={`自动切换候选 ${account.email ?? account.id}`} disabled={!account.switchable} checked={checked} onClick={(event) => event.stopPropagation()} onChange={(event) => setSettingsDraft({ ...settingsDraft, autoSwitchAccountIds: event.target.checked ? [...settingsDraft.autoSwitchAccountIds, account.id] : settingsDraft.autoSwitchAccountIds.filter((id) => id !== account.id) })} /></td>
                      <td><div className="account-email">{account.alias ?? account.email ?? '邮箱未知'} {account.active && <span className="active-badge">当前</span>}</div>{account.alias && <div className="account-secondary-email">{account.email ?? '邮箱未知'}</div>}<div className="workspace-id">{switchCapability(account)}</div><AccountMetadataChips account={account} /></td>
                      <td>{running ? <span className="status status-testing"><LoaderCircle className="spin" size={13} />检测中</span> : <><span className={`status status-${displayStatus(account.status)}`}>{STATUS_LABELS[displayStatus(account.status)]}</span><div className="status-detail">{account.detail}</div></>}</td>
                      <td>{account.planType ?? '未知'}</td>
                      <td><Quota account={account} running={running} now={clock} /></td>
                      <td>{dateTime(account.lastCheckedAt)}</td>
                    </tr>
                  )
                })}
                {virtualAutomationAccounts.paddingBottom > 0 && <tr className="virtual-spacer" aria-hidden="true"><td colSpan={6} style={{ height: virtualAutomationAccounts.paddingBottom }} /></tr>}
                {automationAccounts.length === 0 && <tr><td colSpan={6} className="empty-state">没有匹配的账号</td></tr>}
              </tbody>
            </table>
          </div>
    </PageView>
  )
}
