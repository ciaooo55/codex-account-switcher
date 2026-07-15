# CPA and Sub2API Compatibility Implementation Plan

## Phase 1: Parser contracts

1. Add fixture-driven failing tests for flat CPA, native Sub2API v1, legacy bundle, API wrapper, multi-account files, outer metadata precedence, cross-format deduplication, and CPA ZIP import.
2. Extend shared credential source metadata with a dialect and ZIP syntax.
3. Implement contextual candidate extraction and bounded in-memory ZIP parsing.
4. Run parser and manager tests.

## Phase 2: Export service

1. Add failing tests for CPA/Sub2API serializers, separate output, bundled output, atomic writes, collision suffixes, invalid IDs, and token-free results.
2. Implement pure serializers and the main-process export service.
3. Add archive support using a maintained ZIP library and enforce output limits.
4. Run export and vault integration tests.

## Phase 3: IPC and UI

1. Add failing preload/main IPC contract tests where practical and renderer tests for the export dialog, context-menu action, incremental account updates, and running rows.
2. Wire validated export IPC to the vault-backed account manager and native directory chooser.
3. Extend account-scoped progress IPC so each completed test updates its row immediately without exposing secrets.
4. Build the compact export dialog, format/layout segmented controls, warning state, progress/busy state, source dialect labels, full-row semantic status styling, and a visible running animation.
5. Update E2E coverage for selected and multi-account export flows plus incremental batch detection.

## Phase 4: Full verification and release

1. Run typecheck, all Vitest suites, production build, and Playwright E2E.
2. Inspect renderer output and packaged app for token leakage.
3. Build NSIS and portable Windows artifacts and run startup smoke tests.
4. Update README format documentation and release notes.
5. Commit, push `main`, tag the next version, and publish stable-named GitHub release artifacts.
