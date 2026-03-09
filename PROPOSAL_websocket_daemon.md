# Proposal: WebSocket Daemon for Persistent CDP Connections

## Problem

Every `bp exec`, `bp eval`, `bp snapshot`, etc. command follows this lifecycle:

```
CLI start → resolve session JSON → WebSocket handshake → Target.attachToTarget
→ Page.enable + DOM.enable + Runtime.enable + Network.enable
→ addScriptToEvaluateOnNewDocument → execute action → disconnect WebSocket → exit
```

The overhead per command:
- **WebSocket handshake**: ~50-150ms local, ~200-800ms to cloud providers (BrowserBase/Browserless)
- **CDP domain enablement**: ~20-50ms (4 parallel `enable` calls + script injection)
- **Target attachment**: ~10-30ms
- **Graceful disconnect**: ~200ms (close event + fallback timer in `transport.ts:84`)

**Total overhead: ~280-1030ms per command**, paid on every single invocation. For a 10-step agent workflow calling `bp exec` sequentially, that's 3-10 seconds of pure connection overhead.

## Proposal: Optional CDP Daemon

When a user runs `bp connect`, optionally spawn a lightweight background daemon process that:

1. Holds the WebSocket connection to the browser open
2. Keeps CDP domains enabled and the target attached
3. Exposes a local Unix domain socket for CLI commands to connect to
4. Multiplexes CDP commands from multiple CLI invocations over the single persistent WebSocket

### Architecture

```
Before (current):
  bp exec ──WebSocket──► Chrome CDP
  bp exec ──WebSocket──► Chrome CDP    (new connection each time)
  bp exec ──WebSocket──► Chrome CDP

After (with daemon):
  bp exec ──Unix socket──► bp-daemon ──WebSocket──► Chrome CDP
  bp exec ──Unix socket──► bp-daemon     (reuses connection)
  bp exec ──Unix socket──► bp-daemon

Fallback (daemon unavailable):
  bp exec ──WebSocket──► Chrome CDP     (current behavior, unchanged)
```

### Session File Extension

The existing `SessionData` in `~/.browser-pilot/sessions/{id}.json` gains two optional fields:

```typescript
interface SessionData {
  // ... existing fields ...

  /** Daemon connection info (present when daemon is running) */
  daemon?: {
    /** Unix socket path for daemon communication */
    socketPath: string;
    /** Daemon process PID (for health checks and cleanup) */
    pid: number;
    /** Timestamp when daemon was started */
    startedAt: string;
  };
}
```

### Socket Path Convention

```
~/.browser-pilot/sessions/{sessionId}/daemon.sock
```

This places the socket alongside the existing log directory (`{sessionId}/log.jsonl`), keeping per-session artifacts grouped. The path is short enough to stay under the 108-byte Unix socket path limit on Linux (104 on macOS).

**Platform notes:**
- Linux: `sun_path` limit is 108 bytes. `~/.browser-pilot/sessions/` is ~40 chars + session ID (~12 chars) + `/daemon.sock` (12 chars) = ~64 chars. Safe.
- macOS: `sun_path` limit is 104 bytes. Same math applies. Safe.
- GitHub Actions: `$HOME` is `/home/runner`, same structure works.
- Windows/WSL: Unix sockets work in WSL. Native Windows would need named pipes — out of scope for v1.

### Daemon Protocol

The daemon speaks a simple JSON-over-Unix-socket protocol. Each message is a newline-delimited JSON object.

**Request (CLI → Daemon):**
```typescript
interface DaemonRequest {
  /** Unique request ID for correlation */
  id: number;
  /** CDP method to execute */
  method: string;
  /** CDP params */
  params?: Record<string, unknown>;
  /** Override sessionId (null = browser-level, undefined = use attached session) */
  sessionId?: string | null;
}
```

**Response (Daemon → CLI):**
```typescript
interface DaemonResponse {
  /** Matching request ID */
  id: number;
  /** CDP result (on success) */
  result?: unknown;
  /** Error message (on failure) */
  error?: string;
}
```

**Events (Daemon → CLI, unsolicited):**
```typescript
interface DaemonEvent {
  /** No id field — distinguishes from responses */
  method: string;
  params: Record<string, unknown>;
}
```

This mirrors the CDP protocol shape intentionally — the daemon acts as a transparent CDP proxy. CLI code can swap the transport layer without changing any CDP logic.

### Daemon Lifecycle

#### Startup (during `bp connect`)

```
bp connect [--daemon]
  │
  ├── Normal flow: connect → pick page → save session → disconnect
  │
  └── With daemon (default on, --no-daemon to disable):
        1. connect → pick page → save session (with daemon field)
        2. Fork daemon subprocess: `bun ./src/daemon/index.ts <sessionId>`
        3. Daemon inherits the WebSocket connection (or reconnects immediately)
        4. Parent process exits, daemon continues in background
        5. Daemon writes PID to session file
        6. Daemon creates Unix socket at socketPath
```

**Implementation detail:** The daemon process is spawned with `child_process.fork()` (or `Bun.spawn` with `detached: true` + `unref()`). The parent doesn't wait for it — just spawns and exits. The daemon itself:
- Opens (or inherits) the WebSocket to Chrome
- Attaches to the saved `targetId`
- Enables CDP domains
- Starts listening on the Unix socket
- Writes a heartbeat timestamp to the session file periodically (every 30s)

#### Attachment (during `bp exec` / `bp eval` / etc.)

```typescript
// In src/cli/attach.ts — modified attachSession():

async function attachSession(session, options) {
  // 1. Try daemon first (if daemon info present in session)
  if (session.daemon) {
    try {
      const transport = await connectToDaemon(session.daemon.socketPath, { timeout: 500 });
      // Daemon already has target attached + domains enabled
      // Return a CDPClient backed by daemon transport — zero CDP setup needed
      return { session, browser, page };
    } catch {
      // Daemon not responding — fall through to direct connection
      cleanupStaleDaemon(session);
    }
  }

  // 2. Fallback: direct WebSocket (current behavior, unchanged)
  browser = await connect({ provider: session.provider, wsUrl: session.wsUrl });
  // ... existing code ...
}
```

The timeout for daemon connection is aggressive (500ms) because Unix sockets are local-only — if it doesn't respond in 500ms, it's dead.

#### Health Checks

The daemon maintains liveness via:

1. **PID check**: `process.kill(pid, 0)` — zero-signal checks if process exists (no actual signal sent)
2. **Socket probe**: Attempt connect with 500ms timeout
3. **Heartbeat**: Daemon updates `session.daemon.lastHeartbeat` in the session JSON every 30s

CLI commands check in this order: PID exists → socket connects → proceed. If any check fails, clean up daemon info from session and fall back to direct connection.

#### Shutdown

The daemon shuts down on:

1. **`bp close <session>`**: Sends a shutdown command to the daemon before deleting the session
2. **`bp connect --resume <session>`**: If re-connecting, stops old daemon first
3. **Browser disconnection**: If the Chrome WebSocket closes, daemon exits
4. **Idle timeout**: Configurable, default 1 hour of no commands received
5. **SIGTERM/SIGINT**: Graceful shutdown (close WebSocket, remove socket file, update session)
6. **Stale cleanup**: If CLI detects daemon is dead (PID gone), removes socket file and daemon field from session

### Daemon Implementation

New files:

```
src/daemon/
  index.ts          — Entry point (spawned as subprocess)
  server.ts         — Unix socket server, request routing
  proxy.ts          — CDPClient wrapper that forwards requests
  lifecycle.ts      — Heartbeat, idle timeout, shutdown logic
  types.ts          — DaemonRequest/DaemonResponse/DaemonEvent types
```

The daemon is deliberately simple — it's a **transparent CDP proxy**, not a feature-rich server. It:

- Accepts connections on a Unix socket
- Forwards CDP commands to Chrome over the persistent WebSocket
- Relays CDP events back to connected clients
- Manages the CDP session (keeps target attached, domains enabled)
- Handles reconnection to Chrome if the WebSocket drops (with backoff)

```typescript
// Simplified daemon/server.ts sketch
import { createServer } from 'node:net';

function startDaemonServer(socketPath: string, cdpClient: CDPClient) {
  const server = createServer((socket) => {
    const reader = createLineReader(socket); // newline-delimited JSON

    reader.on('line', async (line) => {
      const request: DaemonRequest = JSON.parse(line);
      try {
        const result = await cdpClient.send(request.method, request.params, request.sessionId);
        socket.write(JSON.stringify({ id: request.id, result }) + '\n');
      } catch (err) {
        socket.write(JSON.stringify({ id: request.id, error: err.message }) + '\n');
      }
    });

    // Forward CDP events to this client
    const forwardEvent = (method: string, params: Record<string, unknown>) => {
      socket.write(JSON.stringify({ method, params }) + '\n');
    };
    cdpClient.onAny(forwardEvent);

    socket.on('close', () => {
      cdpClient.offAny(forwardEvent); // not implemented yet, but easy to add
    });
  });

  server.listen(socketPath);
  return server;
}
```

### Transport Abstraction

To make the daemon transparent to existing CDP client code, we introduce a `DaemonTransport` that implements the existing `Transport` interface from `src/cdp/transport.ts`:

```typescript
// src/daemon/transport.ts
import { connect as netConnect } from 'node:net';
import type { Transport } from '../cdp/transport.ts';

export function createDaemonTransport(socketPath: string, options?: { timeout?: number }): Promise<Transport> {
  const { timeout = 500 } = options ?? {};

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Daemon connection timeout')), timeout);
    const socket = netConnect(socketPath, () => {
      clearTimeout(timer);
      resolve({
        send(message) { socket.write(message + '\n'); },
        async close() { socket.end(); },
        onMessage(handler) { /* line-delimited reader */ },
        onClose(handler) { socket.on('close', handler); },
        onError(handler) { socket.on('error', (e) => handler(e)); },
      });
    });
    socket.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}
```

This means existing `CDPClient` code works identically whether backed by a WebSocket (direct) or a Unix socket (via daemon). The swap happens at the transport layer only.

### CLI Changes

#### `bp connect`

```diff
  bp connect [options]

  Options:
+   --no-daemon           Skip daemon creation (use file-based sessions only)
+   --daemon-idle <mins>  Daemon idle timeout in minutes (default: 60)
    ... existing options ...
```

Default behavior changes: `bp connect` now spawns a daemon unless `--no-daemon` is passed. The output gains a `daemon` field:

```json
{
  "success": true,
  "sessionId": "abc123",
  "provider": "generic",
  "currentUrl": "https://example.com",
  "daemon": { "pid": 12345, "socketPath": "/home/user/.browser-pilot/sessions/abc123/daemon.sock" }
}
```

#### `bp close`

Enhanced to stop the daemon before session cleanup:

```typescript
// Signal daemon to shut down
if (session.daemon) {
  try {
    process.kill(session.daemon.pid, 'SIGTERM');
    // Wait briefly for graceful shutdown
    await waitForPidExit(session.daemon.pid, 2000);
  } catch {
    // Already dead, continue cleanup
  }
  // Remove socket file
  await fs.unlink(session.daemon.socketPath).catch(() => {});
}
```

#### `bp daemon` (new command, optional)

For debugging and manual control:

```
bp daemon status [session]    — Show daemon PID, uptime, connection state
bp daemon stop [session]      — Stop daemon for a session
bp daemon restart [session]   — Restart daemon for a session
bp daemon logs [session]      — Tail daemon log output
```

### Error Handling & Failover Matrix

| Scenario | Behavior |
|----------|----------|
| Daemon running, healthy | CLI connects via Unix socket (fast path) |
| Daemon PID exists but socket unresponsive | Kill PID, clean up, fall back to direct WS |
| Daemon PID gone, socket file exists | Remove stale socket, fall back to direct WS |
| Session has no daemon field | Direct WS connection (current behavior) |
| Daemon loses Chrome connection | Daemon attempts reconnect with backoff; if unrecoverable, exits |
| Multiple CLI commands simultaneously | Daemon multiplexes — each gets its own socket connection, shares CDP WS |
| `--no-daemon` flag | No daemon spawned, pure file-based session (current behavior) |
| Chrome crashes | Daemon detects WS close, exits, CLI falls back on next command |

### Performance Expectations

| Path | Estimated Latency |
|------|-------------------|
| Current (direct WS, local) | ~280ms overhead per command |
| Current (direct WS, cloud) | ~700-1030ms overhead per command |
| Daemon (Unix socket, local Chrome) | ~5-15ms overhead per command |
| Daemon (Unix socket, cloud Chrome) | ~5-15ms overhead per command |
| Daemon fallback to direct WS | Same as current (+ ~500ms failed probe) |

The daemon path eliminates:
- WebSocket handshake (0ms — already connected)
- CDP domain enablement (0ms — already enabled)
- Target attachment (0ms — already attached)
- Graceful disconnect (0ms — daemon stays connected)

What remains:
- Unix socket connect (~1-3ms)
- JSON serialization/deserialization (~1-2ms)
- CDP command round-trip to Chrome (~5-10ms for the actual command)

### Implementation Plan

#### Phase 1: Core daemon + transparent fallback (MVP)
1. `src/daemon/types.ts` — Protocol types
2. `src/daemon/server.ts` — Unix socket server with CDP forwarding
3. `src/daemon/index.ts` — Daemon entry point (subprocess)
4. `src/daemon/lifecycle.ts` — Heartbeat, idle timeout, signal handling
5. `src/daemon/transport.ts` — `DaemonTransport` implementing `Transport` interface
6. Extend `SessionData` with optional `daemon` field
7. Modify `src/cli/attach.ts` — Try daemon first, fall back to direct WS
8. Modify `src/cli/commands/connect.ts` — Spawn daemon after session save
9. Modify `src/cli/commands/close.ts` — Stop daemon on session close
10. Add `offAny()` to `CDPClient` interface (needed for event cleanup)

#### Phase 2: Robustness
11. Stale daemon cleanup in `listSessions()` and `resolveSession()`
12. Daemon reconnection logic (Chrome WS drops → backoff → reconnect)
13. `bp daemon status/stop/restart` command
14. Daemon stdout/stderr logging to `{sessionId}/daemon.log`
15. Idle timeout configuration

#### Phase 3: Polish
16. Unit tests with mocked Unix sockets
17. Integration tests (spawn daemon, run commands, verify fast path)
18. Benchmark: `bun run bench` measuring per-command overhead with/without daemon
19. Documentation update

### Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Daemon process becomes zombie | PID health check + `waitpid` in cleanup; idle timeout auto-exits |
| Socket file left after crash | Stale detection: PID check before connecting; auto-cleanup in `resolveSession()` |
| Multiple sessions → multiple daemons | Each daemon is session-scoped with its own socket; independent lifecycle |
| Event ordering with multiple clients | Events broadcast to all connected clients; each client gets its own stream |
| CDP session invalidation (navigation) | Daemon re-enables domains on `Page.frameNavigated`; transparent to clients |
| Bun vs Node.js differences | `node:net` and `child_process` are supported in both; Unix sockets are standard |
| GitHub Actions ephemeral environment | Daemon runs for duration of job; if agent restarts, fallback is automatic |

### What This Does NOT Change

- **The file-based session system**: Still the source of truth. Daemon is an optional accelerator.
- **The provider abstraction**: Daemon sits between CLI and CDPClient, not between CDPClient and providers.
- **`Browser.connect()` / `Browser.disconnect()`**: SDK API unchanged. Daemon is a CLI-layer optimization.
- **Cloudflare Workers**: Daemon is Node.js/Bun only (uses `node:net`). Workers continue with direct WS.
- **Session resumption semantics**: `bp connect --resume` still reads the session file. Daemon is a bonus.

### Resolved Design Decisions

1. **Default on.** Daemon spawns by default on `bp connect`. Use `--no-daemon` to opt out.

2. **Event forwarding: all events.** Daemon broadcasts all CDP events to all connected clients. Unix socket bandwidth is local and free. Keeps the daemon a simple transparent proxy.

3. **One daemon per named session** (`bp connect -n <name>`). Each `bp connect` invocation spawns its own daemon tied to the session. If you re-connect the same session, old daemon is stopped first.

4. **No auto-restart.** If daemon dies, CLI falls back to direct WebSocket silently. Keep it simple. All fallback events are logged centrally to `daemon.log` for debugging.

5. **60-minute max socket age.** Daemons and sockets older than 60 minutes are automatically purged. CLI falls back to direct WebSocket when a stale daemon is detected.

6. **Centralized daemon logging.** All daemon operations (startup, shutdown, client connections, CDP errors, heartbeat failures, idle timeouts) logged to `~/.browser-pilot/sessions/{id}/daemon.log`. Viewable via `bp daemon logs`.

7. **Cloudflare Workers / workerd.** Completely unaffected. Daemon uses `node:net` which doesn't exist in workerd. Session files have no `daemon` field, so CLI never attempts the daemon path.

### Implementation Status

Phase 1 (MVP) is implemented:
- `src/daemon/` — types, server, lifecycle, transport, entry point
- `src/cdp/client.ts` — `offAny()`, `createCDPClientFromTransport()`
- `src/browser/browser.ts` — `Browser.fromCDP()` for daemon transport
- `src/cli/attach.ts` — daemon-first with transparent fallback
- `src/cli/daemon-spawn.ts` — subprocess spawning + ready-wait
- `src/cli/commands/connect.ts` — `--no-daemon`, `--daemon-idle`
- `src/cli/commands/close.ts` — daemon stop on session close
- `src/cli/commands/clean.ts` — daemon stop on stale session cleanup
- `src/cli/commands/daemon.ts` — `bp daemon status/stop/logs`
- `src/cli/commands/list.ts` — daemon status in session list
- `src/cli/session.ts` — `SessionData.daemon` field, `getSessionFilePath()`
