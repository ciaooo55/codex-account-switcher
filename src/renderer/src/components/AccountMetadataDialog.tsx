import { CheckCircle2, UsersRound, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type {
  AccountMetadataFields,
  AccountMetadataUpdateRequest
} from '../../../shared/types'
import { useDialogFocus } from '../hooks/useDialogFocus'

export interface MetadataAccount extends AccountMetadataFields {
  id: string
  email: string | null
  planType: string | null
}

export function AccountMetadataDialog({
  accounts,
  allAccounts,
  busy,
  onClose,
  onSave
}: {
  accounts: MetadataAccount[]
  allAccounts: MetadataAccount[]
  busy: boolean
  onClose: () => void
  onSave: (request: AccountMetadataUpdateRequest) => void
}): React.JSX.Element {
  const single = accounts.length === 1 ? accounts[0] : null
  const [group, setGroup] = useState(single?.group ?? '')
  const [changeGroup, setChangeGroup] = useState(Boolean(single))
  const dialogRef = useDialogFocus<HTMLElement>(true, onClose)
  const groups = useMemo(() => [...new Set(allAccounts.flatMap((account) => account.group ? [account.group] : []))].sort(), [allAccounts])

  const submit = (): void => {
    const request: AccountMetadataUpdateRequest = { accountIds: accounts.map((account) => account.id) }
    if (single) {
      request.group = group
    } else {
      if (changeGroup) request.group = group
    }
    onSave(request)
  }

  return (
    <div className="repair-backdrop" role="presentation">
      <section ref={dialogRef} className="compact-dialog metadata-dialog" role="dialog" aria-modal="true" aria-label="账号分组" tabIndex={-1}>
        <div className="panel-header">
          <div><h2>{single ? '编辑账号分组' : `批量分组 ${accounts.length} 个账号`}</h2><span className="dialog-subtitle">分组只保存在本机，不会写入凭证文件</span></div>
          <button className="icon-button" title="关闭" aria-label="关闭账号分组编辑" onClick={onClose} disabled={busy}><X size={18} /></button>
        </div>
        {single && (
          <div className="metadata-account-summary">
            <strong>{single.email ?? '邮箱未知'}</strong><span>{single.planType ?? '未知等级'}</span>
          </div>
        )}
        <div className="metadata-form">
          <label className={single ? '' : 'metadata-toggle-field'}>
            {!single && <input type="checkbox" checked={changeGroup} onChange={(event) => setChangeGroup(event.target.checked)} />}
            <span><UsersRound size={15} />分组</span>
            <input aria-label="账号分组" value={group} maxLength={80} disabled={!single && !changeGroup} onChange={(event) => setGroup(event.target.value)} list="account-groups" placeholder={single ? '留空表示未分组' : '勾选后批量设置；留空可清除分组'} />
            <datalist id="account-groups">{groups.map((item) => <option key={item} value={item} />)}</datalist>
          </label>
        </div>
        <div className="panel-actions">
          <button className="secondary-button" onClick={onClose} disabled={busy}><X size={16} />取消</button>
          <button className="primary-button" onClick={submit} disabled={busy || (!single && !changeGroup)}><CheckCircle2 size={16} />保存</button>
        </div>
      </section>
    </div>
  )
}
