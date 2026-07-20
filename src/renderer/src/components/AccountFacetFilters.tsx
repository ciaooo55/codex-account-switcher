import { FilterX } from 'lucide-react'
import type {
  AccountFacetFilters as AccountFacetFilterValues,
  AccountFacets
} from '../account-filters'

export function AccountFacetFilters({
  label,
  facets,
  value,
  onChange
}: {
  label: string
  facets: AccountFacets
  value: AccountFacetFilterValues
  onChange: (value: AccountFacetFilterValues) => void
}): React.JSX.Element {
  const active = Boolean(value.plan || value.domain || value.reason || value.group)
  return (
    <div className="facet-filters" aria-label={`${label}动态筛选`}>
      {facets.plans.length > 0 && (
        <select
          aria-label={`${label}账号类型`}
          value={value.plan}
          onChange={(event) => onChange({ ...value, plan: event.target.value })}
        >
          <option value="">全部账号类型</option>
          {facets.plans.map((option) => (
            <option key={option.value} value={option.value}>{option.label} ({option.count})</option>
          ))}
        </select>
      )}
      {facets.domains.length > 0 && (
        <select
          aria-label={`${label}邮箱域名`}
          value={value.domain}
          onChange={(event) => onChange({ ...value, domain: event.target.value })}
        >
          <option value="">全部邮箱域名</option>
          {facets.domains.map((option) => (
            <option key={option.value} value={option.value}>{option.label} ({option.count})</option>
          ))}
        </select>
      )}
      {facets.reasons.length > 0 && (
        <select
          className="reason-filter"
          aria-label={`${label}失效或错误原因`}
          value={value.reason}
          onChange={(event) => onChange({ ...value, reason: event.target.value })}
        >
          <option value="">全部失效/错误原因</option>
          {facets.reasons.map((option) => (
            <option key={option.value} value={option.value}>{option.label} ({option.count})</option>
          ))}
        </select>
      )}
      {facets.groups.length > 0 && (
        <select
          aria-label={`${label}账号分组`}
          value={value.group}
          onChange={(event) => onChange({ ...value, group: event.target.value })}
        >
          <option value="">全部分组</option>
          {facets.groups.map((option) => (
            <option key={option.value} value={option.value}>{option.label} ({option.count})</option>
          ))}
        </select>
      )}
      {active && (
        <button
          className="icon-button clear-facets"
          title="清除动态筛选"
          aria-label={`清除${label}动态筛选`}
          onClick={() => onChange({ plan: '', domain: '', reason: '', group: '', tag: '' })}
        >
          <FilterX size={15} />
        </button>
      )}
    </div>
  )
}
