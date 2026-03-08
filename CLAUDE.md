# browser-pilot

Lightweight CDP-based browser automation for AI agents. Zero production dependencies. Works in Node.js, Bun, and Cloudflare Workers.

> **Use `bd` for task tracking.** Run `bd onboard` to get started, then `bd ready` to find work.

## Commands

```bash
bun run check:quiet         # All checks, shows errors only (tsc + biome + oxlint + unit tests)
bun run check               # Same checks, verbose output
bun run lint:fix             # Auto-fix formatting (biome)
bun test                    # Run all tests
bun test tests/unit         # Unit tests only (fast, mocked CDP)
bun test tests/integration  # Integration tests (real browser)
bun run dev:bp              # Run CLI from source (no build needed)
```

Before PR: run `bun run check:quiet`

> **Dev tip:** Use `bun run dev:bp` (or `bun ./src/cli/index.ts`) instead of `bp` during development to avoid stale binaries.

## Agent Workflow

```bash
bd ready                            # Find available work
bd show <id>                        # View issue details
bd update <id> --status in_progress # Claim work
bd close <id>                       # Complete work
```

**Session completion (mandatory):**
1. File issues for remaining work
2. Run quality gates: `bun check && bun test`
3. Update/close issues
4. Push changes: `git pull --rebase && bd sync && git push`
5. Verify: `git status` shows "up to date with origin"

## Architecture

```
Browser.connect() → CDPClient → WebSocket → Provider (BrowserBase/Browserless/Generic)
     ↓
   Page → Actions (click/fill/submit) → Wait Strategies → CDP Commands
     ↓
BatchExecutor → Executes Step[] sequentially with timing/error tracking
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
| Step validation + aliases | `src/actions/validate.ts` |

### Lazy Session Attach (CLI)
`bp exec` and `bp eval` no longer do preflight `/json/version` validation. They connect directly via WebSocket and clean up stale sessions on failure. Implementation: `src/cli/attach.ts`.

### CLI Discovery Surface
The CLI now includes lightweight page-inspection commands in addition to `snapshot`:
- `bp page` — compact overview: URL, title, headings, form fields, interactive controls
- `bp forms` — structured form metadata only
- `bp targets` — list browser tabs/targets with URLs and IDs
- `bp connect --new-tab [--page-url <url>]` — create and attach to a fresh tab

Snapshot text output now uses `ref:e12` notation, which is also the selector syntax agents should reuse in later commands. Refs are cached per session+URL after a snapshot.

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

### Structured Failure Reasons (planned — see PLAN_v2.md Epic 4)
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

See `PLAN_v2.md` for the full reliability and effectiveness improvement plan (15 epics). Key themes:
- **Click reliability**: Hit-target retry through transient overlays, viewport validation after scroll
- **Failure classification**: Structured `failureReason` in StepResult with auto-recovery and AI-friendly suggestions
- **Event-driven waits**: Replace all hardcoded `sleep()` calls in submit, selectCustom, iframe context
- **Workflow runner**: `bp run <workflow.json>` for multi-step action + assertion in one invocation
- **Keyboard modifiers**: `press('a', { modifiers: ['Control'] })` and `shortcut('Control+a')` batch action
- **Iframe safety**: Explicit errors on broken frame context, never silent degradation
- **Benchmarks**: Repo-local `bun run bench` with CI regression gates
