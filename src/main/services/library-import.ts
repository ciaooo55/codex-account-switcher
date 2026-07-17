import type { LibraryImportResult, ScanResult, GrokScanResult } from '../../shared/types'

const NO_CODEX_CREDENTIAL = /^No usable credentials found in /i

export function combineLibraryImportResults(
  codex: ScanResult,
  grok: GrokScanResult
): LibraryImportResult {
  const recognized = codex.imported + codex.skipped + grok.imported + grok.skipped > 0
  const errors = [...codex.errors, ...grok.errors].filter((error) =>
    !recognized || !NO_CODEX_CREDENTIAL.test(error)
  )

  return {
    imported: codex.imported + grok.imported,
    skipped: codex.skipped + grok.skipped,
    errors: [...new Set(errors)],
    codexImported: codex.imported,
    codexSkipped: codex.skipped,
    grokImported: grok.imported,
    grokSkipped: grok.skipped,
    accounts: codex.accounts,
    grokAccounts: grok.accounts
  }
}
