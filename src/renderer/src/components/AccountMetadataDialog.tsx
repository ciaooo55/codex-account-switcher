import { CheckCircle2, Tag, UsersRound, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type {
  AccountMetadataFields,
  AccountMetadataTagMode,
  AccountMetadataUpdateRequest
} from '../../../shared/types'
import { useDialogFocus } from '../hooks/useDialogFocus'

export interface MetadataAccount extends AccountMetadataFields {
  id: string
  email: string | null
  planType: string | null
}

function tagsText(tags: readonly string[] | undefined): string {
  return (tags ?? []).join(', ')
}

function parseTags(value: string): string[] {
  return [...new Map(value
    .split(/[,，\n]/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => [tag.toLocaleLowerCase('zh-CN'), tag])).values()]
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
  const [alias, setAlias] = useState(single?.alias ?? '')
  const [group, setGroup] = useState(single?.group ?? '')
  const [tags, setTags] = useState(tagsText(single?.tags))
  const [note, setNote] = useState(single?.note ?? '')
  const [changeGroup, setChangeGroup] = useState(Boolean(single))
  const [changeTags, setChangeTags] = useState(Boolean(single))
  const [tagMode, setTagMode] = useState<AccountMetadataTagMode>(single ? 'replace' : 'add')
  const dialogRef = useDialogFocus<HTMLElement>(true, onClose)
  const groups = useMemo(() => [...new Set(allAccounts.flatMap((account) => account.group ? [account.group] : []))].sort(), [allAccounts])
  const knownTags = useMemo(() => [...new Set(allAccounts.flatMap((account) => account.tags ?? []))].sort(), [allAccounts])

  const submit = (): void => {
    const request: AccountMetadataUpdateRequest = { accountIds: accounts.map((account) => account.id) }
    if (single) {
      request.alias = alias
      request.group = group
      request.tags = parseTags(tags)
      request.tagMode = 'replace'
      request.note = note
    } else {
      if (changeGroup) request.group = group
      if (changeTags) {
        request.tags = parseTags(tags)
        request.tagMode = tagMode
      }
    }
    onSave(request)
  }

  return (
    <div className="repair-backdrop" role="presentation">
      <section ref={dialogRef} className="compact-dialog metadata-dialog" role="dialog" aria-modal="true" aria-label="账号标签与分组" tabIndex={-1}>
        <div className="panel-header">
          <div><h2>{single ? '编辑账号信息' : `批量管理 ${accounts.length} 个账号`}</h2><span className="dialog-subtitle">别名、标签和分组只保存在本机，不会写入凭证文件</span></div>
          <button className="icon-button" title="关闭" aria-label="关闭账号信息编辑" onClick={onClose} disabled={busy}><X size={18} /></button>
        </div>
        {single && (
          <div className="metadata-account-summary">
            <strong>{single.email ?? '邮箱未知'}</strong><span>{single.planType ?? '未知等级'}</span>
          </div>
        )}
        <div className="metadata-form">
          {single && <label>账号别名<input value={alias} maxLength={120} onChange={(event) => setAlias(event.target.value)} placeholder="例如：主力 Team" /></label>}
          <label className={single ? '' : 'metadata-toggle-field'}>
            {!single && <input type="checkbox" checked={changeGroup} onChange={(event) => setChangeGroup(event.target.checked)} />}
            <span><UsersRound size={15} />分组</span>
            <input value={group} maxLength={80} disabled={!single && !changeGroup} onChange={(event) => setGroup(event.target.value)} list="account-groups" placeholder={single ? '留空表示未分组' : '勾选后批量设置；留空可清除分组'} />
            <datalist id="account-groups">{groups.map((item) => <option key={item} value={item} />)}</datalist>
          </label>
          <label className={single ? '' : 'metadata-toggle-field'}>
            {!single && <input type="checkbox" checked={changeTags} onChange={(event) => setChangeTags(event.target.checked)} />}
            <span><Tag size={15} />标签</span>
            {!single && (
              <select value={tagMode} disabled={!changeTags} onChange={(event) => setTagMode(event.target.value as AccountMetadataTagMode)}>
                <option value="add">追加标签</option><option value="remove">移除标签</option><option value="replace">替换全部</option>
              </select>
            )}
            <input value={tags} maxLength={1_200} disabled={!single && !changeTags} onChange={(event) => setTags(event.target.value)} list="account-tags" placeholder="多个标签用逗号分隔" />
            <datalist id="account-tags">{knownTags.map((item) => <option key={item} value={item} />)}</datalist>
          </label>
          {single && <label>备注<textarea value={note} maxLength={2_000} onChange={(event) => setNote(event.target.value)} placeholder="本机备注，可记录来源或用途" /></label>}
        </div>
        <div className="panel-actions">
          <button className="secondary-button" onClick={onClose} disabled={busy}><X size={16} />取消</button>
          <button className="primary-button" onClick={submit} disabled={busy || (!single && !changeGroup && !changeTags)}><CheckCircle2 size={16} />保存</button>
        </div>
      </section>
    </div>
  )
}
