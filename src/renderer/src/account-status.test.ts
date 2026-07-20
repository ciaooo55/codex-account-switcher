import { describe, expect, it } from 'vitest'
import { displayStatus, STATUS_LABELS } from './account-status'

describe('displayStatus', () => {
  it('does not mislabel a quota error with an unknown cycle as five-hour exhaustion', () => {
    const status = displayStatus('quota_exhausted')

    expect(status).toBe('quota_exhausted')
    expect(STATUS_LABELS[status]).toBe('额度耗尽（周期未知）')
  })
})
