import type {
  AccountStatusSyncPatch,
  AppSnapshot,
  AppSnapshotPatch
} from '../../../shared/ipc'
import type {
  AccountSummary,
  CpaCodexAccountSummary,
  GrokAccountSummary,
  GrokTestResult,
  TestResult
} from '../../../shared/types'

export const EMPTY_TEST_PROGRESS = {
  active: false,
  done: 0,
  total: 0,
  runningIds: [] as string[],
  updatedAccount: null
}

export const EMPTY_CPA_DIRECTORY_STATS = {
  credentialFiles: 0,
  codexFiles: 0,
  grokFiles: 0,
  duplicateFiles: 0,
  mixedFiles: 0,
  unrecognizedFiles: 0
}

export function bootstrapSnapshotFromAccountsPage(patch: AppSnapshotPatch): AppSnapshot {
  if (!patch.settings || !patch.importDirectory || !patch.autoSwitch || !patch.customApi || !patch.accounts || !patch.testing) {
    throw new Error('首屏账号库快照不完整')
  }
  return {
    accounts: patch.accounts,
    settings: patch.settings,
    importDirectory: patch.importDirectory,
    testing: patch.testing,
    autoSwitch: patch.autoSwitch,
    grokAccounts: patch.grokAccounts ?? [],
    cpaGrokAccounts: patch.cpaGrokAccounts ?? [],
    grokDirectory: patch.grokDirectory ?? patch.settings.grokDirectory,
    grokTesting: patch.grokTesting ?? { ...EMPTY_TEST_PROGRESS },
    cpaGrokTesting: patch.cpaGrokTesting ?? { ...EMPTY_TEST_PROGRESS },
    cpaCodexAccounts: patch.cpaCodexAccounts ?? [],
    cpaCodexTesting: patch.cpaCodexTesting ?? { ...EMPTY_TEST_PROGRESS },
    cpaDirectoryStats: patch.cpaDirectoryStats ?? { ...EMPTY_CPA_DIRECTORY_STATS },
    customApi: patch.customApi
  }
}

export function applyCodexStatusUpdates<T extends AccountSummary | CpaCodexAccountSummary>(
  accounts: readonly T[],
  results: readonly TestResult[] | undefined
): T[] {
  if (!results?.length) return accounts as T[]
  const updates = new Map(results.map((result) => [result.accountId, result]))
  return accounts.map((account) => {
    const result = updates.get(account.id)
    return result
      ? {
          ...account,
          status: result.status,
          detail: result.detail,
          lastCheckedAt: result.checkedAt,
          usage: result.usage,
          planType: result.usage?.planType?.trim() || account.planType
        }
      : account
  })
}

export function applyGrokStatusUpdates(
  accounts: readonly GrokAccountSummary[],
  results: readonly GrokTestResult[] | undefined
): GrokAccountSummary[] {
  if (!results?.length) return accounts as GrokAccountSummary[]
  const updates = new Map(results.map((result) => [result.accountId, result]))
  return accounts.map((account) => {
    const result = updates.get(account.id)
    return result
      ? {
          ...account,
          status: result.status,
          detail: result.detail,
          lastCheckedAt: result.checkedAt,
          usage: result.usage,
          planType: result.usage?.planType?.trim() || account.planType
        }
      : account
  })
}

export function applyStatusSync(current: AppSnapshot, patch: AccountStatusSyncPatch): AppSnapshot {
  return {
    ...current,
    accounts: applyCodexStatusUpdates(current.accounts, patch.accounts),
    cpaCodexAccounts: applyCodexStatusUpdates(current.cpaCodexAccounts, patch.cpaCodexAccounts),
    grokAccounts: applyGrokStatusUpdates(current.grokAccounts, patch.grokAccounts),
    cpaGrokAccounts: applyGrokStatusUpdates(current.cpaGrokAccounts, patch.cpaGrokAccounts)
  }
}