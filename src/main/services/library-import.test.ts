import { describe, expect, it } from 'vitest'
import type { AccountSummary, GrokAccountSummary } from '../../shared/types'
import { combineLibraryImportResults } from './library-import'

describe('combineLibraryImportResults', () => {
  it('reports Codex and Grok counts separately and suppresses the expected cross-parser miss', () => {
    const result = combineLibraryImportResults(
      {
        imported: 1,
        skipped: 0,
        errors: ['No usable credentials found in grok.json'],
        accounts: [{} as AccountSummary]
      },
      {
        imported: 1,
        skipped: 0,
        errors: [],
        accounts: [{} as GrokAccountSummary]
      }
    )

    expect(result).toMatchObject({
      imported: 2,
      skipped: 0,
      codexImported: 1,
      codexSkipped: 0,
      grokImported: 1,
      grokSkipped: 0,
      errors: []
    })
  })

  it('keeps an unrecognized-input error when neither provider was found', () => {
    const result = combineLibraryImportResults(
      { imported: 0, skipped: 0, errors: ['No usable credentials found in broken.txt'], accounts: [] },
      { imported: 0, skipped: 0, errors: [], accounts: [] }
    )

    expect(result.errors).toEqual(['No usable credentials found in broken.txt'])
  })
})
