# Test Quarantine

Tests in this directory are skipped in CI due to flakiness or environment requirements.
They run nightly only.

## Currently quarantined via inline skipIf

The following tests use `describe.skipIf(!!process.env['CI'])` and should be
migrated here once they're stabilized or confirmed environment-specific:

### CLI tests (10 blocks)
- `tests/cli/session-lifecycle.test.ts` — CLI Session Lifecycle
- `tests/cli/snapshot-diff.test.ts` — CLI Snapshot Diff
- `tests/cli/snapshot-inspect.test.ts` — CLI Snapshot Inspect
- `tests/cli/session-log.test.ts` — Session Log CLI
- `tests/cli/dialog.test.ts` — CLI --dialog Flag
- `tests/cli/page-tools.test.ts` — CLI Page Tools
- `tests/cli/session.test.ts` — CLI Basic Functionality + CLI Session Persistence
- `tests/cli/snapshot-output.test.ts` — CLI Snapshot Output
- `tests/cli/ref-persistence.test.ts` — CLI Ref Persistence

### Integration tests (3 tests)
- `tests/integration/navigation.test.ts:85` — navigate back and forward
- `tests/integration/navigation.test.ts:103` — wait for navigation after link click
- `tests/integration/recording.test.ts:145` — record navigation via goto steps

## Goal

Burn down all inline CI skips. Each test should either:
1. Be fixed to run reliably in CI
2. Be moved to `tests/quarantine/` (runs nightly only)
