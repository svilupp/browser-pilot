# browser-pilot

Lightweight CDP-based browser automation for AI agents. Zero production dependencies. Works in Node.js, Bun, and Cloudflare Workers.

## Commands

```bash
bun test                    # Run all tests
bun test tests/unit         # Unit tests only (fast, mocked CDP)
bun test tests/integration  # Integration tests (real browser)
bun typecheck               # TypeScript check
```

Before PR: run `bun test && bun typecheck`

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
| CLI | `src/cli/index.ts` |

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
