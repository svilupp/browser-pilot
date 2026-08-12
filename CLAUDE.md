# browser-pilot

**IMPORTANT: Never commit or push code unless the user explicitly asks you to.**

Lightweight CDP-based browser automation for AI agents. Zero production dependencies. Runs in Node.js, Bun, Cloudflare Workers. Companion package: [Flightplan](https://github.com/svilupp/flightplan).

## Commands

```bash
bun run check:quiet         # All checks (tsc + biome + oxlint + unit + fitness + api) — run before PR
bun run lint:fix            # Auto-fix formatting
bun test tests/unit         # Unit tests (fast, mocked CDP)
bun test tests/integration  # Integration tests (real browser)
bun test tests/fitness      # Architectural fitness functions
bun run dev:bp              # Run CLI from source (avoid stale binaries)
bun run harden              # Full hardening (prek hooks + knip + ast-grep)
bun run api:check           # API Extractor: public API surface
```

Git hooks: `bun install` then `bun run setup:hooks` (prek; pre-commit ≤15s, pre-push ≤90s).

## Architecture

```
Browser.connect() → CDPClient → WebSocket → Provider (BrowserBase/Browserless/Generic)
     ↓                    ↑
   Page → Actions    Daemon (optional, holds WS open)
     ↓                    ↑
BatchExecutor        CLI → Unix socket → Daemon → Chrome
```

Entry: `src/index.ts`. Public API report: `etc/browser-pilot.api.md`.

## Key Files

| Area | Location |
|------|----------|
| Browser class, target scoring, viewport validation | `src/browser/browser.ts` |
| Page class (all actions, snapshot, OOPIF frames) | `src/browser/page.ts` |
| Actionability, diagnostics, hints | `src/browser/actionability.ts`, `diagnose.ts`, `hint-generator.ts` |
| Delta / review / fingerprints | `src/browser/delta.ts`, `review.ts`, `fingerprint.ts` |
| Widget primitives (combobox, upload, overlay, safe submit) | `src/browser/combobox.ts`, `upload.ts`, `overlay-detect.ts`, `safe-submit.ts` |
| Target pinning, action highlights, emit (WS injection) | `src/browser/target-pin.ts`, `action-highlight.ts`, `emit.ts` |
| CDP client + session scoping | `src/cdp/client.ts`, `src/cdp/session-scope.ts` |
| Batch executor, step types, validation, conditions, combinators | `src/actions/` |
| Wait strategies (smart waiting, fast-fail) | `src/wait/strategies.ts` |
| Providers (Browser Use, BrowserBase, generic) | `src/providers/` |
| Audio I/O (input, output, encoding, transcribe) | `src/audio/` |
| CLI entry, commands, attach/daemon-spawn | `src/cli/` |
| Daemon (server, lifecycle, transport, types) | `src/daemon/` |
| Recording (manifest, redaction) | `src/recording/` |
| Runtime abstractions (env, clock, id), branded types | `src/runtime/`, `src/types/branded.ts` |
| Workflow summaries | `src/trace/workflow-summary.ts` |
| Fitness tests, consumer type tests, ast-grep rules | `tests/fitness/`, `tests/types/`, `rules/` |

## Core Patterns (details in source + docs)

- **Multi-selector first**: every action accepts `string | string[]`, tries in order (`docs/guides/multi-selector.md`)
- **Built-in smart waiting**: implicit visibility wait, fast-fail on static pages (`src/wait/strategies.ts`)
- **Optional actions**: `optional: true` returns `false` instead of throwing
- **Composition over configuration**: complex widgets composed from primitives
- **Outcome-based execution**: `expectAny`/`expectAll`/`failIf` conditions, `dangerous` steps never auto-retried; retries bounded by dispatch boundary (`src/actions/conditions.ts`, `docs/guides/batch-actions.md`)
- **Structured failures**: `StepResult.failureReason` classification + suggestions (`src/actions/types.ts`)
- **Per-page session pinning**: each Page pinned to its own flat CDP session (`src/cdp/session-scope.ts`)
- **OOPIF support**: cross-origin iframes via auto-attach; limited action subset (`src/browser/page.ts`)
- **Snapshot refs**: accessibility tree with `ref:e12` selectors, cached per session+URL (`docs/guides/snapshots.md`)
- **Provider pattern**: `createSession()` → `{ wsUrl, sessionId, close() }` (`src/providers/types.ts`, `docs/providers.md`)

## Docs Index

- `docs/getting-started.md`, `docs/cli.md`, `docs/providers.md`
- `docs/api/` — browser, page, types reference
- `docs/guides/` — batch actions, snapshots, multi-selector, recording, tracing, realtime debugging, voice-agent testing, Cloudflare Workers, release checklist
- `docs/automating-browsers/` — agent skill + REFERENCE.md + voice agent testing
- `PLAN.md` — improvement plan (all 8 phases implemented)
- `CHANGELOG.md`

## Conventions

- Actions scroll into view before interaction; event listeners cleaned up after use
- No production dependencies — pure Web Standard APIs (WebSocket, fetch)
- Never activate a tab or bring the browser to the foreground
- Daemon mode is CLI/Node-only (Unix sockets); Workers use direct WS
