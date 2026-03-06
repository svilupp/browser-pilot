# Changelog

## [0.0.11] - 2026-03-06

### Improved

- More reliable click actions with actionability checks, keyboard input helpers, and overlay/animation handling

## [0.0.10] - 2026-02-27

### Added

- `bp listen` command — monitor WebSocket and HTTP traffic via CDP, output as structured JSONL. Supports mode filtering (`ws`, `http`, `all`), URL glob matching (`-m`), file output (`-o`), and auto-stop timeout. Pipeable to `jq` for live filtering.

## [0.0.9] - 2025-02-15

### Added

- **Voice agent testing** — `bp audio` CLI for end-to-end voice agent automation: inject audio into the fake mic, capture the agent's response, and optionally transcribe with Whisper (`bp audio roundtrip -i prompt.wav --transcribe`). Also available programmatically via `page.setupAudio()` / `page.audioRoundTrip()`. Updated Claude Code skill with a voice agent testing guide (`docs/skill/SKILL.md`).
- `bp eval` command — evaluate JS in the browser without JSON escaping (`bp eval 'document.title'`), with file and stdin support
- CLI polish: per-command `--help`, file input (`-f`), stdin piping, `validateSteps()` pre-flight checks, and better error messages across all commands

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

