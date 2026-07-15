# CPA and Sub2API Compatibility Design

## Goal

Extend Codex Account Switcher so credentials can be imported and exported in the native formats used by CLIProxyAPI (CPA) and Sub2API. A source file may contain one or many accounts. Export supports one account per file and one bundle containing many accounts.

## Verified Formats

CLIProxyAPI's built-in Codex token storage is one flat JSON object per account. Its management upload path unmarshals a top-level object, so a JSON array is not a native multi-account CPA file. A CPA multi-account bundle will therefore be a ZIP containing one standard CPA JSON file per account.

Sub2API's native transfer format is a `sub2api-data` version 1 object containing `proxies` and `accounts` arrays. Each OpenAI OAuth account stores secrets under `accounts[].credentials`, while descriptive and refresh metadata may also appear under `accounts[].extra`. A single native Sub2API JSON can contain many accounts.

## Import Architecture

The parser will separate file syntax from credential dialect:

- Syntax: JSON, JSONL, text key/value blocks, static JavaScript, or ZIP.
- Dialect: Codex nested auth, CPA flat credential, Sub2API account, or generic nested credential.

Sub2API records will be adapted with parent context before normalization. Fields in `credentials` remain authoritative for tokens, while `extra`, account fields, and filename are fallback sources for email, plan, expiry, and refresh time. Generic recursion continues to support arrays and arbitrary wrapper objects without duplicating a credential already claimed by a dialect adapter.

ZIP import reads supported entries in memory, rejects traversal names, limits entry count and uncompressed bytes, and never extracts archive content to disk. Each entry retains a virtual source path for diagnostics.

Deduplication remains identity-based. Subject plus workspace is preferred, followed by email plus workspace, then token entropy when identity claims are unavailable. The same account in CPA and Sub2API input will appear once.

## Export Architecture

An export service in the Electron main process reads selected credentials from the encrypted vault. The renderer sends account IDs and export options but never receives credential material.

Supported combinations:

| Format | Separate | Bundle |
| --- | --- | --- |
| CPA | One flat CPA JSON per account | One ZIP containing flat CPA JSON files |
| Sub2API | One valid `sub2api-data` JSON per account | One valid `sub2api-data` JSON with all accounts in `accounts[]` |

CPA output uses `type`, `email`, `access_token`, `refresh_token`, `id_token`, `account_id`, `last_refresh`, and `expired` when available. Sub2API output uses the native v1 envelope and OpenAI OAuth account schema, including `chatgpt_account_id`, `chatgpt_user_id`, `plan_type`, `expires_at`, and `extra.last_refresh` when available.

The main process opens the directory picker. Output uses atomic temporary-file replacement, sanitized deterministic names, and collision suffixes; existing files are never overwritten. Results returned to the renderer contain counts, paths, and sanitized errors only.

## Interface and UI

Add shared export request/result types and a single `accounts:export` IPC method. IPC validates IDs, enum values, and the selected directory in the main process.

The toolbar gains an Export button. Its compact dialog provides:

- CPA or Sub2API format selection.
- Separate files or bundled file selection.
- Selected accounts, or all filtered accounts when none are selected.
- A plaintext credential warning before choosing the output directory.

The account context menu gains an export action that opens the same dialog for that account. Source labels identify CPA and Sub2API instead of showing only the file extension.

Batch detection is incremental. The main process emits an account-scoped progress event when an account enters the queue, starts network work, and completes. The renderer marks running rows with a visible spinner and a `检测中` state, then replaces that row immediately with its new status, usage, reset time, and refresh time instead of waiting for the whole batch.

Account status is communicated across the full row: a stable colored leading rail, a restrained tinted row background, status text, and matching quota accents. Valid, exhausted, permission, expired, refresh, model, network, and file states each use semantic colors and patterns; color is never the only signal. Hover, selection, current-account, and running states remain distinguishable.

## Failure Handling and Security

- Parsing one damaged account does not discard valid siblings from the same file.
- Export validates every selected vault record before writing.
- Partial separate-file exports report per-file failures and retain successfully written files.
- Bundle creation is all-or-nothing.
- Tokens are excluded from IPC payloads, UI state, logs, errors, and test snapshots.
- Incremental progress events contain only account summaries and phase metadata; they never contain tokens.
- Import limits protect recursive parsing and ZIP decompression from resource exhaustion.

## Verification

Tests will cover CPA and Sub2API fixtures, wrapped/multi-account payloads, metadata precedence, deduplication, ZIP limits, exact serializer shapes, file collision behavior, incremental account updates, running/status row styling, IPC secrecy, renderer workflows, and end-to-end export. The existing account detection, switching, session repair, build, Windows packaging, and release checks must continue to pass.
