# Changelog

## [Unreleased]

## [0.0.1] - 2026-07-12

Initial public release of the current browser-pilot automation, CLI, and packaging surface.

### Added

- **Safer browser control** — per-page target isolation, explicit target and popup handling,
  cross-origin iframe support, worker support, and session-aware daemon events keep automation on
  the intended page and frame.
- **Outcome-aware automation** — semantic readiness waits, assertions, state/delta and review
  surfaces, target recovery, workflow summaries, safe-submit handling, and smart widget helpers
  make browser outcomes observable and verifiable.
- **Selector and recording workflows** — richer snapshots, attribute-aware selectors, fuzzy
  diagnostics, candidate ranking, structural signatures, and canonical recording artifacts with
  summary, inspection, and derivation commands.
- **Public CLI and API surfaces** — routed discovery commands, page and target inspection,
  recording and tracing workflows, browser-condition controls, voice/media tooling, multi-selector
  actions, and expanded library exports for Node.js, Bun, and Cloudflare Workers.

### Changed

- **Background-safe automation** — new and fallback tabs stay in the background by default,
  background and hidden tabs remain actionable without tab activation, and foregrounding is an
  explicit opt-in.
- **Effect-aware retries and results** — actions now respect the dispatch boundary, observe
  dispatched or uncertain effects instead of blindly repeating input, and report outcome, receipt,
  dispatch, attempt, and target provenance information.
- **Recording guidance** — capture now uses an existing named session and a known artifact path;
  summary and inspection precede derivation, which produces browser-pilot workflow JSON for replay.

### Fixed

- **Interaction reliability** — background and occluded pages no longer hang on actionability,
  click dispatch avoids duplicate side effects, and selector recovery and failure hints are more
  robust across rerenders and ambiguous controls.
- **Lifecycle reliability** — iframe and worker targets are resumed correctly, daemon routing and
  target errors preserve page state, page listeners are cleaned up, and stale frame state is reset.
- Recording manifests now normalize screenshot paths consistently across Node and Bun runtimes.

### Packaging

- **Portable distribution** — the package ships public ESM, CommonJS, browser-pilot subpath, and
  CLI entry points for supported runtimes, with package metadata, version reporting, build
  provenance, clean deterministic builds, and npm-ready lifecycle scripts.
- **Documentation and release workflow** — user documentation, automation guidance, API reports,
  and the release checklist now describe the supported package, CLI, recording, and replay flows.

### Breaking changes

- **Custom `CDPClient` implementers only** — session-routing members were added to the interface,
  `onAny` handlers receive a session identifier, and session-scoped views reject session mutation.
  Users of the bundled client are unaffected.

## [0.1.0] - 2026-07-03

Additive for library and CLI users; one narrow breaking change affects only custom `CDPClient` implementers (see Breaking changes).

### Added

- **Cross-origin iframe (OOPIF) support** — `page.switchToFrame(selector)` can now enter genuine cross-origin iframes (e.g. payment widgets). Inside the frame: `fill`, `type`, `click`, `focus`, `press`, `text`, `waitFor`, and `evaluate` work; `switchToMain()` exits. Unsupported methods fail with a clear error instead of silently acting on the parent page. Requires Chrome site isolation (`--site-per-process`). Nested cross-origin frames (e.g. Stripe-like payment forms) are supported.
- **CDP session multiplexing** (`browser-pilot/cdp`) — multi-session support over a single WebSocket (Workers-safe): `setAutoAttach()`, `onTargetAttached()`, `onSessionEvent()`, and friends. Cross-origin iframes, workers, and service workers auto-attach and are unpaused automatically (no start-up hang).
- **Per-page CDP session isolation** — each `Page` is pinned to its own CDP session, so actions and events no longer leak between tabs when multiple targets are attached (also applied to the `bp` daemon fast-path).
- **Element diagnostics** — `page.diagnose(selectorOrIntent)` explains why a selector does or doesn't resolve, with ranked fuzzy candidates. Fuzzy matching is configurable (`FuzzyMatchOptions`) and normalizes dashed/underscored/camelCase intents to human labels.
- **Candidate ranking** — `page.resolveAll(intent)` scores every plausible target for an intent and returns ranked candidates (read-only, executes nothing).
- **Snapshot attribute enrichment** — `snapshot({ attributes: true })` adds real `id`/`data-testid`/`name`/`type` attributes to interactive elements.
- **Structural page signatures** — the `stateSignatureChanges` outcome condition gains `mode: 'structure'` to detect layout changes instead of text changes.

### Changed

- `bp exec --json` failure `hints[]` now normalize dashed/underscored/camelCase intents (e.g. `create-order` matches a `Create Order` element).

### Fixed

- No more 30-second hangs on hidden or occluded tabs — actionability checks now self-heal when a throttled background tab reports zero-size elements.
- Daemon session-scoped events now route correctly, and iframes/workers no longer stay frozen (paused) after a CLI command exits — the daemon auto-resumes them.
- Page listeners are cleaned up on close (no leaks under heavy tab churn), stale frame state is fully reset when a cross-origin frame detaches, and unhandled promise rejections in `reload`, `goBack`, and `goForward` are fixed.

### Breaking changes

- **Custom `CDPClient` implementers only** — the `CDPClient` interface gained session-routing members (`onSessionEvent`, `onTargetAttached`, `setAutoAttach`, `runIfWaitingForDebugger`, `sessions`, `hasSession`), `onAny` handlers now receive a third `sessionId` argument, and calling `setSessionId` on a session-scoped view throws. Users of the bundled client are unaffected.

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
