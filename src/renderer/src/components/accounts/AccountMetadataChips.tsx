import type { AccountSummary } from '../../../../shared/types'

export function AccountMetadataChips({ account }: { account: AccountSummary }): React.JSX.Element | null {
  if (!account.group) return null
  return (
    <div className="account-metadata-chips mt-1 flex flex-wrap gap-1">
      <span className="account-group-chip inline-flex items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)]">
        {account.group}
      </span>
    </div>
  )
}
