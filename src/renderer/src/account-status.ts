import type { AccountStatus, DisplayAccountStatus } from '../../shared/types'

export const STATUS_LABELS: Record<DisplayAccountStatus, string> = {
  untested: '未测试',
  valid: '有效',
  quota_exhausted: '额度耗尽（周期未知）',
  quota_exhausted_5h: '5 小时额度耗尽',
  quota_exhausted_weekly: '周额度耗尽',
  invalid: '已失效',
  unknown_error: '未知错误'
}

export function displayStatus(status: AccountStatus): DisplayAccountStatus {
  if (
    status === 'untested' ||
    status === 'valid' ||
    status === 'quota_exhausted' ||
    status === 'quota_exhausted_5h' ||
    status === 'quota_exhausted_weekly'
  ) return status
  if (['invalid', 'no_permission', 'workspace_deactivated', 'non_refreshable'].includes(status)) {
    return 'invalid'
  }
  return 'unknown_error'
}
