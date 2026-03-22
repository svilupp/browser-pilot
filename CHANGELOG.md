# Changelog

## [0.0.18] - 2026-03-22

- Add Browser Use cloud provider with built-in CAPTCHA solving, anti-detect fingerprinting, and residential proxies in 195+ countries. Recommended cloud provider when local Chrome CDP is unavailable.

## [0.0.17] - 2026-03-19

- Tightened the CLI discovery contract and docs: registry-driven root help, `bp --version`, clearer command routing, and a more explicit connect -> goto -> inspect workflow across README, CLI docs, `llms.txt`, and browser automation skills.
- Fixed real-world CLI UX gaps found in live Chrome usage: `connect --new-tab --page-url` now reports the opened URL more reliably, `bp page` now caches the refs it shows for later `bp exec` use, and compact page output preserves unchecked checkbox/radio state correctly.

## [0.0.16] - 2026-03-14

- Added Chrome 147 `DevToolsActivePort` auto-discovery for plain `bp connect`, pinned CI/harness coverage to Chrome 147, and updated docs/skills to recommend trying auto-discovery first.
- Added outcome-based execution, delta/review surfaces, semantic fingerprints, smart widget primitives (combobox, upload, overlay detection), safe submit, target pinning, workflow summaries, and safety fitness tests

## [0.0.15] - 2026-03-12

### Breaking changes

- `recording.json` now uses the canonical `version: 2` schema; tooling that reads recordings must switch to the new `session`, `recipe.steps`, `actions`, `screenshots`, `trace`, `assertions`, `notes`, and `artifacts` shape.
- Session logs now write canonical trace events to `trace.jsonl`; integrations reading `log.jsonl` need to switch file paths and parse the canonical trace event format.
- `bp trace` is now the primary live traffic workflow; `bp listen` remains available as a compatibility alias to `bp trace tail`.

### Added

- Unified recording and tracing around one canonical artifact model, a new `bp trace` workflow (`start`, `tail`, `summary`, `watch`, `export`, `merge`), richer `bp record` artifact commands, and trace-backed waits/assertions in `bp exec` / `bp run`.
- `bp env` adds browser-state controls for permissions, network, visibility, and geolocation, and canonical session tracing now covers console, runtime, permission, media, voice, HTTP, and WebSocket events.

### Changed

- CLI help, README, guides, `llms.txt`, and skills now teach one inspect/act/record/trace/audio/env workflow, and global transport debugging is documented as `--debug` with `--trace` kept as a compatibility alias.
- `bp audio` and `bp exec` now project voice, media, and assertion outcomes into the canonical trace store for later analysis.

### Fixed

- `assertMediaTrackLive` now detects browser-pilot's tracked stream state in addition to media elements, and CLI/env help surface issues are cleaned up.
- Daemon-backed dialog handling, daemon error reporting, permission persistence, visibility toggling, and live WebSocket offline/reconnect tracing are fixed and validated with full real-Chrome coverage.

## [0.0.14] - 2026-03-09

### Added

- WebSocket daemon for persistent CDP connections — `bp connect` now spawns a background daemon that holds the WebSocket open, reducing per-command overhead from ~280-1030ms to ~5-15ms via Unix socket fast-path (`bp daemon status/stop/logs`, `--no-daemon`, `--daemon-idle`)
- Session-level recording — `bp connect --record` enables screenshot recording for all subsequent exec calls with accumulative frame history across the full session, plus per-exec `--record` override, sensitive field redaction, and `bp clean --max-size` for disk management

## [0.0.13] - 2026-03-08

### Added

- Multi-tab support (`newTab`, `closeTab` actions, `--new-tab` flag, `listTargets` API), text-based selectors (`text:`, `role:`), label fallback for check/click, `bp page` and `bp forms` commands, snapshot UX overhaul (text default, `--role` filter, `ref:` notation fix), property alias auto-resolution, eval error improvements, and `closePage()` bug fix

## [0.0.12] - 2026-03-07

### Added

- Structured failure classification (`failureReason`, `suggestion`, `coveringElement`) on batch step results, keyboard modifier support (`press` with modifiers, `shortcut` action)
- `bp run` workflow runner with 5 assertion actions and retry, click-through-overlay retry, viewport validation after scroll, and event-driven waits replacing hardcoded delays

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
