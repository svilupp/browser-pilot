# browser-pilot

Lightweight CDP-based browser automation for AI agents. Zero production dependencies. Works in Node.js, Bun, and Cloudflare Workers.

> **Use `bd` for task tracking.** Run `bd onboard` to get started, then `bd ready` to find work.

## Commands

```bash
bun check                   # TypeScript + lint (run first)
bun test                    # Run all tests
bun test tests/unit         # Unit tests only (fast, mocked CDP)
bun test tests/integration  # Integration tests (real browser)
bun run dev:bp              # Run CLI from source (no build needed)
```

Before PR: run `bun check && bun test`

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
| CDP client | `src/cdp/client.ts:53-242` |
| Batch executor | `src/actions/executor.ts:21-73` |
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

```typescript
const result = await page.batch([
  { action: 'goto', url: 'https://example.com' },
  { action: 'fill', selector: '#email', value: 'test@example.com' },
  { action: 'submit', selector: 'form' },
], { onFail: 'stop' });
```

## Snapshot Format

Accessibility tree extraction via `Accessibility.getFullAXTree`. Nodes get refs (e1, e2...) for identification.
- Implementation: `src/browser/page.ts:825-967`
- Types: `src/browser/types.ts:100-145`

## Error Types

- `ElementNotFoundError`: `src/browser/types.ts:148-157`
- `TimeoutError`: `src/browser/types.ts:159-163`
- `NavigationError`: `src/browser/types.ts:166-171`
- `CDPError`: `src/cdp/client.ts` (for CDP-level errors)

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
- No production dependencies - pure Web Standard APIs (WebSocket, fetch)
