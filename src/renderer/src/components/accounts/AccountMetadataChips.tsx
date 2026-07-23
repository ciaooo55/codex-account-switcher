import type { AccountSummary } from '../../../../shared/types'

export function AccountMetadataChips({ account }: { account: AccountSummary }): React.JSX.Element | null {
  if (!account.group) return null
  return (
    <div className="account-metadata-chips">
      {account.group && <span className="account-group-chip">{account.group}</span>}
    </div>
  )
}