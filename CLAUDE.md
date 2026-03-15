# browser-pilot

**IMPORTANT: Never commit or push code unless the user explicitly asks you to.**

Lightweight CDP-based browser automation for AI agents. Zero production dependencies. Works in Node.js, Bun, and Cloudflare Workers.

## Commands

```bash
bun run check:quiet         # All checks, errors only (tsc + biome + oxlint + unit + fitness + api)
bun run check               # Same checks, verbose output
bun run lint:fix             # Auto-fix formatting (biome)
bun test                    # Run all tests
bun test tests/unit         # Unit tests only (fast, mocked CDP)
bun test tests/integration  # Integration tests (real browser)
bun test tests/fitness      # Architectural fitness functions
bun run dev:bp              # Run CLI from source (no build needed)

# Hardening commands
bun run harden              # Full hardening: all prek hooks + manual (knip, full ast-grep)
bun run harden:quick        # Quick: pre-commit hooks only
bun run gate:agent          # Validate last commit (agent workflow)
bun run api:check           # API Extractor: check public API surface
ast-grep scan -c sgconfig.yml  # Run structural rules (11 rules)
bunx knip                   # Dead code detection
```

Before PR: run `bun run check:quiet`

### Git Hooks (prek)
Pre-commit (≤15s): biome (changed files), oxlint, tsc
Pre-push (≤90s): + unit tests, integration tests, CLI tests
Install: `bun install` (triggers `prek install` via prepare script)

> **Dev tip:** Use `bun run dev:bp` (or `bun ./src/cli/index.ts`) instead of `bp` during development to avoid stale binaries.

## Architecture

```
Browser.connect() → CDPClient → WebSocket → Provider (BrowserBase/Browserless/Generic)
     ↓                    ↑
   Page → Actions    Daemon (optional, holds WS open)
     ↓                    ↑
BatchExecutor        CLI → Unix socket → Daemon → Chrome
```

Entry: `src/index.ts` exports `Browser`, `Page`, types, providers.

### Target Selection & Viewport Validation
When `browser.page()` picks a target, it scores candidates (prefers http URLs, unattached targets, targets with titles; penalizes chrome://, devtools://, extensions). After attaching, validates the viewport — if dimensions are pathological (e.g. 56px height from a side panel), auto-applies 1280x720 override with a warning.
- Scoring: `src/browser/browser.ts` (`scoreTarget()`, `pickBestTarget()`)
- Viewport check: `src/browser/browser.ts` (in `page()` method after `init()`)
- `PageOptions.targetUrl`: filter targets by URL substring
- `PageOptions.minViewport`: custom threshold or `false` to disable
- CLI: `bp connect --target-url localhost:3000` to filter targets

## Core Design Patterns

### Multi-Selector First
Every action accepts `string | string[]`. Tries each selector in order until one succeeds.
- Implementation: `src/browser/page.ts:994-1034` (`findElement()`)
- Wait logic: `src/wait/strategies.ts:114-152` (`waitForAnyElement()`)

```typescript
await page.click(['#submit', '.fallback', 'button[type=submit]']);
```

### Built-in Smart Waiting
Every action implicitly waits for element visibility before interaction. No separate `waitFor()` needed.
- Visibility check: `src/wait/strategies.ts:26-45` (checks display, visibility, opacity, rect)
- Default timeout: 30s, polling: 100ms
- **Fast-fail on static pages:** Element presence waits (`visible`/`attached`) fail fast instead of polling for the full timeout when the page is fully loaded and the DOM is not mutating. Uses `isPageStatic()` heuristic with a 200ms MutationObserver observation window. Implementation: `src/wait/strategies.ts:132-167`.

### Optional Actions
All actions support `optional: true` to skip failures gracefully instead of throwing.
- Returns `false` instead of throwing: `src/browser/page.ts:151-152`

```typescript
await page.click('#cookie-banner', { optional: true }); // Returns false if not found
```

### Composition Over Configuration
Complex patterns (custom dropdowns, multi-step forms) are composed from primitives, not special methods with 10 options.
- Custom select example: `src/browser/page.ts:296-349`

## Key Files

| Component | Location |
|-----------|----------|
| Browser class | `src/browser/browser.ts` |
| Page class (all actions) | `src/browser/page.ts` |
| Actionability checks | `src/browser/actionability.ts` |
| Element diagnostics | `src/browser/diagnose.ts` |
| Failure hint generation | `src/browser/hint-generator.ts` |
| Snapshot diffing | `src/browser/snapshot-diff.ts` |
| CDP client | `src/cdp/client.ts:53-242` |
| Batch executor | `src/actions/executor.ts` |
| Step types + FailureReason | `src/actions/types.ts` |
| Wait strategies | `src/wait/strategies.ts` |
| Provider interface | `src/providers/types.ts:5-60` |
| BrowserBase provider | `src/providers/browserbase.ts:23-99` |
| Snapshot (accessibility tree) | `src/browser/page.ts:821-967` |
| Device presets | `src/emulation/devices.ts` |
| Request interceptor | `src/network/interceptor.ts` |
| Cookie/storage types | `src/storage/types.ts` |
| Audio I/O module | `src/audio/` (input, output, encoding, permissions, transcribe) |
| Audio input (mic override) | `src/audio/input.ts` |
| Audio output (capture) | `src/audio/output.ts` |
| Transcription (Whisper) | `src/audio/transcribe.ts` |
| CLI | `src/cli/index.ts` |
| CLI audio command | `src/cli/commands/audio.ts` (subcommands: setup, play, capture, roundtrip, check) |
| CLI listen command | `src/cli/commands/listen.ts` (network traffic monitor: ws, http, all) |
| CLI session attach helper | `src/cli/attach.ts` |
| CLI daemon spawn helper | `src/cli/daemon-spawn.ts` |
| CLI daemon command | `src/cli/commands/daemon.ts` |
| Daemon entry point | `src/daemon/index.ts` |
| Daemon server (Unix socket) | `src/daemon/server.ts` |
| Daemon lifecycle (logging, heartbeat, signals) | `src/daemon/lifecycle.ts` |
| Daemon transport (client-side) | `src/daemon/transport.ts` |
| Daemon types & constants | `src/daemon/types.ts` |
| Step validation + aliases | `src/actions/validate.ts` |
| Action highlight overlays | `src/browser/action-highlight.ts` |
| Recording manifest types | `src/recording/manifest.ts` |
| Recording redaction helpers | `src/recording/redaction.ts` |
| Shared string utils | `src/utils/strings.ts` (readString, globToRegex, formatConsoleArg) |
| Runtime: env access | `src/runtime/env.ts` (centralized process.env) |
| Runtime: clock | `src/runtime/clock.ts` (centralized Date.now) |
| Runtime: ID generation | `src/runtime/id.ts` (centralized Math.random) |
| Branded types | `src/types/branded.ts` (SessionId, TargetId, BrowserWsUrl) |
| Fitness tests | `tests/fitness/` (architectural constraints) |
| Consumer type tests | `tests/types/` (compile-only API verification) |
| ast-grep rules | `rules/` (11 structural rules) |
| API report | `etc/browser-pilot.api.md` (API Extractor output) |
| Outcome conditions | `src/actions/conditions.ts` |
| Condition combinators | `src/actions/combinators.ts` |
| Delta extraction | `src/browser/delta.ts` |
| Review extraction | `src/browser/review.ts` |
| Semantic fingerprints | `src/browser/fingerprint.ts` |
| Custom combobox | `src/browser/combobox.ts` |
| File upload helper | `src/browser/upload.ts` |
| Overlay detection | `src/browser/overlay-detect.ts` |
| Safe submit | `src/browser/safe-submit.ts` |
| Target pinning | `src/browser/target-pin.ts` |
| Workflow summaries | `src/trace/workflow-summary.ts` |
| CLI review command | `src/cli/commands/review.ts` |

### Lazy Session Attach (CLI)
`bp exec` and `bp eval` try the daemon fast-path first (Unix socket), then fall back to direct WebSocket. Stale daemons are auto-cleaned. Implementation: `src/cli/attach.ts`.

### WebSocket Daemon
`bp connect` spawns a background daemon that holds the CDP WebSocket open. Subsequent CLI commands connect via Unix socket (~5-15ms) instead of re-establishing WebSocket (~280-1030ms).

```
bp connect                          # Spawns daemon by default
bp connect --no-daemon              # Direct WS only (file-based sessions)
bp connect --daemon-idle 30         # Custom idle timeout (minutes)
bp daemon status                    # Check daemon health
bp daemon stop                      # Stop daemon for default session
bp daemon logs                      # View daemon log
```

- **Daemon-per-session**: Each `bp connect` spawns one daemon tied to the named session
- **60-minute max age**: Sockets older than 60 min are auto-purged, falling back to direct WS
- **Transparent failover**: If daemon is dead/stale, CLI falls back to direct WebSocket silently
- **Centralized logging**: All daemon ops logged to `~/.browser-pilot/sessions/{id}/daemon.log`
- **Heartbeat**: Daemon updates session file every 30s; stale heartbeat triggers fallback
- **Platform**: Linux, macOS, GitHub Actions (Unix sockets) for daemon mode. Cloudflare Workers use direct WS. Workers now expose parts of `node:net` (with compatibility flags), but daemon mode still depends on Unix domain sockets + local process lifecycle, which are CLI/Node runtime concerns.
- Implementation: `src/daemon/` (server, lifecycle, transport, types), `src/cli/daemon-spawn.ts`


### CLI Discovery Surface
The CLI now includes lightweight page-inspection commands in addition to `snapshot`:
- `bp page` — compact overview: URL, title, headings, form fields, interactive controls
- `bp forms` — structured form metadata only
- `bp targets` — list browser tabs/targets with URLs and IDs
- `bp review` — structured business state: headings, forms, alerts, tables, key-values, status labels
- `bp connect --new-tab [--page-url <url>]` — create and attach to a fresh tab

Snapshot text output now uses `ref:e12` notation, which is also the selector syntax agents should reuse in later commands. Refs are cached per session+URL after a snapshot.

### Exec Recording
`bp exec --record` writes a lightweight screenshot trail for the latest replay into the session directory (or `--record-dir` when provided): `recording.json` plus `screenshots/`. `bp connect --record` enables session-level recording for all subsequent exec calls — recording is accumulative across exec calls (frames append, not replace). Session-level settings are stored in `session.metadata.record`. Sensitive field values are redacted based on the field's actual input settings (`password`, `hidden`, `one-time-code`, `cc-number`, etc.). `bp clean --max-size 500MB` trims old sessions by total disk usage and now stops any attached daemons before deletion.

## Audio I/O Pattern

Voice agent testing via JS injection (works on already-running browsers, no special launch flags required).

**Setup order matters:** Audio overrides must be injected *before* the voice agent initializes (calls `getUserMedia`, creates `AudioContext`, etc.). Use `bp audio check` to validate pipeline state after setup.

```
Page.setupAudio()
  ├── AudioInput: getUserMedia monkey-patch → fake MediaStream via AudioContext
  │   └── play(bytes) → decodeAudioData → AudioBufferSourceNode → destination
  └── AudioOutput: AudioNode.connect + HTMLMediaElement.play interception
      └── Per-context ScriptProcessorNode taps PCM → Runtime.addBinding → Node.js

Page.audioRoundTrip()
  1. Start output capture
  2. Play input audio into fake mic
  3. captureUntilSilence (RMS-based, silenceTimeout default 1500ms)
     - noAudioTimeout (15s): early exit if no audio arrives at all
     - Chunks grouped by AudioContext sample rate; best group selected on merge
  4. Return { audio, latencyMs, totalMs }

Transcription: transcribe(CaptureResult) → pcmToWav → fetch(Whisper API)
  - Zero dependencies, manual multipart/form-data
  - Gated on OPENAI_API_KEY (validated immediately)

bp audio check
  - Validates overrides (getUserMedia, AudioNode.connect, AudioContext)
  - Reports tracked AudioContexts with role heuristic:
    non-48kHz context = likely voice agent, 48kHz = browser-pilot input/capture
  - Shows input/output readiness and overall pipeline status
```

- Data transfer: base64-encoded Float32Array via `Runtime.addBinding`, flushed ~1s
- Audio encoding: `src/audio/encoding.ts` (WAV encode/decode, RMS, tone/silence generation)
- Permissions: CDP `Browser.grantPermissions` + JS `navigator.permissions.query` override

## CDP Client Pattern

Message correlation via incrementing ID (`src/cdp/client.ts:155`). Each request stored in pending map with timeout, resolved/rejected on response.

```typescript
const id = ++messageId;
pending.set(id, { resolve, reject, timeout: setTimeout(...) });
ws.send(JSON.stringify({ id, method, params, sessionId }));
```

## Provider Pattern

Providers implement `createSession()` and optional `resumeSession()`. Return `{ wsUrl, sessionId, close() }`.
- Interface: `src/providers/types.ts`
- BrowserBase: POST to API, get connectUrl
- Generic: Pass-through wsUrl

## Batch Execution

`page.batch(steps[], options)` executes steps sequentially with timing. Supports `onFail: 'stop' | 'continue'`.
- Executor: `src/actions/executor.ts:21-73`
- Step types: `src/actions/types.ts:22-71`
- Validation & aliases: `src/actions/validate.ts`

```typescript
const result = await page.batch([
  { action: 'goto', url: 'https://example.com' },
  { action: 'fill', selector: '#email', value: 'test@example.com' },
  { action: 'submit', selector: 'form' },
], { onFail: 'stop' });
```

### Assertion Steps
Batch steps support 5 assertion actions for verifying page state:
- `assertVisible` — requires `selector`, waits for element to be visible
- `assertExists` — requires `selector`, waits for element to be attached to DOM
- `assertText` — requires `expect` (or `value`), optional `selector` (defaults to full page text), substring match
- `assertUrl` — requires `expect` (or `url`), checks current URL contains expected substring
- `assertValue` — requires `selector` and `expect` (or `value`), waits for element then checks its value (exact match)

### Retry Support
Any step can include `retry` (number, default 0) and `retryDelay` (ms, default 500). Retries wrap the full step execution including waits.

```typescript
{ action: 'click', selector: '#flaky-btn', retry: 3, retryDelay: 1000 }
```

### Outcome-Based Execution
Batch steps support outcome conditions to verify state transitions, not just mechanical success. Optional on all steps — simple actions work exactly as before.

```typescript
await page.batch([
  {
    action: 'click',
    selector: '#save-btn',
    expectAny: [
      { kind: 'textAppears', text: 'Changes saved' },
      { kind: 'elementVisible', selector: '#success-toast' },
    ],
    failIf: [
      { kind: 'textAppears', text: 'Error' },
    ],
    dangerous: true,  // Never auto-retry if ambiguous
  },
]);
```

Condition kinds: `urlMatches`, `elementVisible`, `elementHidden`, `textAppears`, `textChanges`, `networkResponse`, `stateSignatureChanges`.

Evaluation order: `failIf` (any match = failed) → `expectAll` (all must match) → `expectAny` (any match = success).

`StepResult` gains: `outcomeStatus` (`success` | `failed` | `ambiguous` | `unsafe_to_retry`), `matchedConditions`, `retrySafe`.

Dangerous steps that result in ambiguous outcome get `unsafe_to_retry` and are never auto-retried.

- Implementation: `src/actions/conditions.ts`
- Types: `src/actions/types.ts` (Condition, OutcomeStatus, MatchedCondition)
- Combinators: `src/actions/combinators.ts` (conditionAny, conditionAll, conditionNot, conditionRace)

### Delta & Review Surfaces
Two read surfaces for "what changed?" and "what is the business state?":

- `page.captureState()` → `PageState` — lightweight state snapshot
- `page.delta(before)` → `DeltaResult` — URL, heading, field, button, alert changes
- `page.review()` → `ReviewResult` — headings, forms, alerts, tables, key-value pairs, status labels
- Batch actions: `{ action: 'review' }`, `{ action: 'delta' }`
- CLI: `bp review`
- Implementation: `src/browser/delta.ts`, `src/browser/review.ts`

### Semantic Fingerprints
Stable element identity across rerenders using semantic fingerprints (role + name + section path + stable attributes).
- `buildFingerprintMap(nodes)` — fingerprints all interactive nodes
- `recoverStaleRef(staleFingerprint, currentFingerprints)` — recovers stale refs with confidence scoring
- Implementation: `src/browser/fingerprint.ts`

### Smart Widget Primitives
- `chooseOption(page, config)` — state machine for custom comboboxes: open → search → select → verify
- `uploadFiles(page, config)` — file upload with CDP `setInputFiles` + acceptance verification
- `detectOverlay(page)` — detect visible modal/overlay with role/z-index heuristics
- Batch actions: `{ action: 'chooseOption', ... }`, `{ action: 'upload', selector: '...', files: [...] }`
- Implementation: `src/browser/combobox.ts`, `src/browser/upload.ts`, `src/browser/overlay-detect.ts`

### Safe Submit
`submitAndVerify(page, options)` — submit with built-in outcome evaluation. Never auto-retries.
- Implementation: `src/browser/safe-submit.ts`

### Target Pinning
Fingerprint and recover browser targets across target ID churn.
- `createTargetFingerprint(targetId, url, title)` → `TargetFingerprint`
- `recoverPinnedTarget(pin, targets)` → `PinRecoveryResult` (exact, url_match, title_match, best_guess)
- Implementation: `src/browser/target-pin.ts`

### Workflow Summaries
Business-readable workflow evidence from batch results.
- `buildWorkflowSummary(batchResult)` → `WorkflowSummary`
- `formatWorkflowSummary(summary)` → compact text report
- Implementation: `src/trace/workflow-summary.ts`

## Snapshot Format

Accessibility tree extraction via `Accessibility.getFullAXTree`. Nodes get refs (e1, e2...) for identification.
- Implementation: `src/browser/page.ts:825-967`
- Types: `src/browser/types.ts:100-145`

`Page.snapshot({ roles })` supports role-filtered snapshots, and `Page.forms()` enumerates `input`, `select`, and `textarea` controls with label/value metadata for CLI discovery commands and the `forms` batch action.

## Error Types & Failure Classification

- `ElementNotFoundError`: `src/browser/types.ts:148-157`
- `TimeoutError`: `src/browser/types.ts:159-163`
- `NavigationError`: `src/browser/types.ts:166-171`
- `CDPError`: `src/cdp/protocol.ts` (for CDP-level errors)
- `ActionabilityError`: `src/browser/actionability.ts` (stores `failureType` and `coveringElement`)

### Structured Failure Reasons
`StepResult.failureReason` classifies errors for agent consumption:
`missing` | `hidden` | `covered` | `disabled` | `readonly` | `detached` | `replaced` | `notEditable` | `timeout` | `navigation` | `cdpError` | `unknown`

Each failure includes a `suggestion` string guiding the agent to the next action, and `hints` with alternative selectors when applicable.

## Testing

Unit tests use mocked CDP (`tests/unit/`). Integration tests use real browser via provider (`tests/integration/`).
- Test server: `tests/fixtures/server.ts`
- Test harness: `tests/utils/harness.ts`

```typescript
import { test, expect } from 'bun:test';

test('clicks element', async () => {
  // ...
});
```

## Conventions

- All actions scroll into view before interaction
- DOM node ID cached after first `DOM.getDocument()`, reset on navigation
- Event listeners cleaned up after use (prevents memory leaks)
- Event listener tracker persists across navigations via `Page.addScriptToEvaluateOnNewDocument`
- No production dependencies - pure Web Standard APIs (WebSocket, fetch)

## Improvement Plan

See `PLAN.md` for the full improvement plan. All 8 phases have been implemented:
- **Phase 1**: Outcome-based execution with conditions (`expectAny`, `expectAll`, `failIf`, `dangerous`)
- **Phase 2**: Delta and review surfaces (`page.delta()`, `page.review()`, `bp review`)
- **Phase 3**: Semantic fingerprints for stable element identity
- **Phase 4**: Smart widget primitives (`chooseOption`, `uploadFiles`, `detectOverlay`)
- **Phase 5**: Safe submit and condition combinators (`submitAndVerify`, `conditionRace`)
- **Phase 6**: Target pinning and recovery
- **Phase 7**: Workflow transcript summaries
- **Phase 8**: Safety fitness tests (no site-specific rules, no dangerous auto-retry, runtime portability)
