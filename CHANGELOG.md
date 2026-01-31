# Changelog

## [0.0.8] - 2025-01-31

### Fixed

- **Multi-tab page targeting**: Sessions now store `targetId` ensuring successive CLI commands target the same browser tab, even when multiple tabs are open
- **Accurate selectorUsed reporting**: When using multi-selector arrays like `["#missing", "#actual"]`, the `selectorUsed` field now correctly reports the matched selector instead of always returning the first
- **Overlay idempotency**: Running `bp snapshot --inspect --keep` multiple times now properly updates labels instead of leaving stale or missing overlays
- **Form element submission**: `page.submit('form')` now works correctly by using `form.requestSubmit()` instead of failing with "Element is not focusable"

### Added

- **`--json` flag**: Convenience alias for `-o json` on all CLI commands (`bp list --json`, `bp exec --json`, etc.)
- **`--export-log` option**: Duplicate session logs to a local file for easier debugging (`bp connect -s test --export-log ./logs/session.jsonl`)
