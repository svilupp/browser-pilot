# Changelog

## [0.0.8] - 2025-02-01

### Added

- `bp diagnose` command with fuzzy matching for failed selectors
- `bp snapshot --diff` (see difference between current page and saved snapshot), `--inspect` (draw the selectors on the page for debugging), `--keep` flags (keep the overlay visible)
- Session logging (JSONL) with `bp list --log-path | --log-tail | --info`
- Extract your traces easily by using `--export-log` on connect
- Failure hints with suggested selectors on `ElementNotFoundError`

### Fixed

- Multi-tab targeting via stored `targetId`
- `selectorUsed` reports actual matched selector
- Overlay injection is idempotent
- `submit('form')` uses `requestSubmit()`

