# Research: Chrome DevTools MCP Integration with Browser-Pilot

> **Date:** 2026-03-14
> **Subject:** Technical deep-dive into `chrome-devtools-mcp`, Chrome remote debugging, and integration path with browser-pilot

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [What is chrome-devtools-mcp?](#what-is-chrome-devtools-mcp)
3. [How autoConnect Works](#how-autoconnect-works)
4. [Chrome Remote Debugging Internals](#chrome-remote-debugging-internals)
5. [MCP Tools Exposed (29 total)](#mcp-tools-exposed)
6. [Browser-Pilot Current Architecture](#browser-pilot-current-architecture)
7. [Integration Analysis](#integration-analysis)
8. [Implementation Plan](#implementation-plan)
9. [Validation Strategy](#validation-strategy)
10. [Sources](#sources)

---

## Executive Summary

`chrome-devtools-mcp` is an **official Google project** that wraps Puppeteer behind an MCP server, giving AI agents 29 tools for browser automation, debugging, and performance analysis. Its killer feature is **`--autoConnect`** — connecting to a user's already-running Chrome (M144+) without needing `--remote-debugging-port` at launch time.

**The core insight:** chrome-devtools-mcp's autoConnect reads Chrome's `DevToolsActivePort` file to discover the debugging WebSocket URL. Browser-pilot can do the same thing directly — no Puppeteer needed — since browser-pilot already has its own CDP client. This would let browser-pilot connect to any Chrome session with zero dependencies, which is a significant advantage over chrome-devtools-mcp's Puppeteer dependency.

---

## What is chrome-devtools-mcp?

**Repo:** [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
**License:** Apache-2.0 (Google LLC)
**Latest:** v0.20.0

### Architecture

```
AI Agent <──stdio (MCP JSON-RPC)──> chrome-devtools-mcp <──Puppeteer──> Chrome (CDP/WebSocket)
```

The MCP server is a Node.js process that:
1. Receives MCP tool calls over **stdio** (JSON-RPC)
2. Translates them into **Puppeteer API calls**
3. Puppeteer communicates with Chrome via **CDP over WebSocket**

### Key Dependencies
- `puppeteer` v24.39.0 — browser automation
- `lighthouse` v13.0.3 — performance auditing
- `chrome-devtools-frontend` v1.0.1596260 — bundled DevTools UI
- MCP SDK v1.27.1 — protocol handling

### Key Source Files
| File | Purpose |
|------|---------|
| `src/index.ts` | Server creation (`createMcpServer()`) |
| `src/browser.ts` | Browser connection/launch logic, autoConnect |
| `src/DevToolsConnectionAdapter.ts` | Adapts Puppeteer CDP sessions |
| `src/McpPage.ts` | Page state wrapper around Puppeteer `Page` |
| `src/McpContext.ts` | MCP context management |
| `src/bin/chrome-devtools-mcp-main.ts` | CLI entry point |

### Design Notes
- A **Mutex** serializes all tool execution (only one tool runs at a time)
- Target filter excludes `chrome://` and `chrome-extension://` URLs (except `chrome://newtab` and `chrome://inspect`)
- Google collects telemetry by default (opt out: `--no-usage-statistics`)

---

## How autoConnect Works

This is the most important technical detail for integration.

### The Mechanism

1. **Determine Chrome's user data directory** based on platform + channel:

   | Platform | Channel=stable |
   |----------|---------------|
   | Linux | `~/.config/google-chrome/` |
   | macOS | `~/Library/Application Support/Google/Chrome/` |
   | Windows | `%LOCALAPPDATA%\Google\Chrome\User Data\` |

2. **Read the `DevToolsActivePort` file** from that directory:
   ```
   path.join(userDataDir, 'DevToolsActivePort')
   ```

3. **Parse the file** (two lines):
   ```
   9222
   /devtools/browser/f4f7e416-1c3b-4b4c-b188-1be21ac7097e
   ```
   Line 1 = port, Line 2 = WebSocket path

4. **Construct WebSocket URL**:
   ```
   ws://127.0.0.1:{port}{path}
   ```

5. **Connect** via `puppeteer.connect({ browserWSEndpoint: wsUrl })`

### Requirements for autoConnect
- **Chrome M144+** (stable since Jan 2026)
- User must navigate to `chrome://inspect/#remote-debugging` and enable remote debugging
- Chrome shows a **permission dialog** each time an MCP server requests a session
- While connected, Chrome displays "Chrome is being controlled by automated test software"

### Known Issues
- Incorrect `DevToolsActivePort` path on some Linux configurations ([#818](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/818), [#914](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/914))
- If file not found, errors with a message directing users to `chrome://inspect/#remote-debugging`

---

## Chrome Remote Debugging Internals

### Connection Methods

| Method | Requires Restart? | Chrome Version |
|--------|-------------------|----------------|
| `--remote-debugging-port` | Yes (relaunch) | Any |
| `--remote-debugging-pipe` | Yes (relaunch) | Any |
| `autoConnect` via `chrome://inspect` | **No** | M144+ |
| `chrome.debugger` extension API | No | Any |

### HTTP Discovery Endpoints (port-based debugging)

When Chrome runs with `--remote-debugging-port=<port>`:

| Endpoint | Purpose |
|----------|---------|
| `GET /json/version` | Browser metadata + browser-level WebSocket URL |
| `GET /json` or `GET /json/list` | List of debuggable targets (tabs/pages) |
| `GET /json/protocol` | Full CDP protocol schema |
| `PUT /json/new?url=<url>` | Create new tab (CSRF-protected, requires PUT) |
| `GET /json/activate/<targetId>` | Bring target to foreground |
| `GET /json/close/<targetId>` | Close a target |

### `/json/version` Response
```json
{
  "Browser": "Chrome/120.0.6099.109",
  "Protocol-Version": "1.3",
  "User-Agent": "Mozilla/5.0 ...",
  "V8-Version": "12.0.267.17",
  "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/14706e92-..."
}
```

### `/json/list` Response
```json
[
  {
    "id": "DAB7FB6187B554E10B0BD18821265734",
    "title": "Example Page",
    "type": "page",
    "url": "https://example.com",
    "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/DAB7FB..."
  }
]
```

### `DevToolsActivePort` File

When Chrome has remote debugging enabled (either via `--remote-debugging-port=0` or via the new `chrome://inspect` UI), it writes this file to the user data directory:

```
9222
/devtools/browser/f4f7e416-1c3b-4b4c-b188-1be21ac7097e
```

This is **the key** to autoConnect — no network scanning needed, just read a file.

### CDP Connection Flow

```
1. HTTP Discovery      GET /json/version → webSocketDebuggerUrl
                        (or read DevToolsActivePort file)
        ↓
2. Browser WebSocket   ws://127.0.0.1:9222/devtools/browser/<guid>
        ↓
3. Target Enumeration  Target.getTargets() → list of pages/workers
        ↓
4. Session Attach      Target.attachToTarget({ targetId, flatten: true })
                        → returns sessionId
        ↓
5. Send Commands       { id, method, params, sessionId } on same WebSocket
        ↓
6. Receive Events      { method, params, sessionId } (no id = event)
```

### `--remote-debugging-pipe` vs `--remote-debugging-port`

| Feature | Port | Pipe |
|---------|------|------|
| Transport | WebSocket over TCP | File descriptors (FD 3/4) |
| Multiple clients | Yes | No (single client) |
| HTTP JSON API | Available | Not available |
| Network exposure | Localhost | Process-private |
| Performance | TCP overhead | Direct memory copy |
| Use case | Connect to existing | Launch and control |

### Security (Chrome 136+)

- `--remote-debugging-port` and `--remote-debugging-pipe` are **no longer respected** with the default Chrome profile. Must also pass `--user-data-dir` pointing to a non-default directory.
- Chrome for Testing is exempt from this restriction.
- `autoConnect` (M144+) is the sanctioned way to debug a regular Chrome session.

---

## MCP Tools Exposed

chrome-devtools-mcp exposes **29 tools** (3 in `--slim` mode).

### Input Automation (9)
| Tool | Description |
|------|-------------|
| `click` | Click element by UID from snapshot |
| `click_at` | Click at x,y coordinates |
| `hover` | Hover over element |
| `fill` | Type into input/textarea or select option |
| `fill_form` | Fill multiple form fields at once |
| `type_text` | Type text via keyboard |
| `press_key` | Press key combinations |
| `drag` | Drag element onto another |
| `upload_file` | Upload file through file input |

### Navigation (6)
| Tool | Description |
|------|-------------|
| `navigate_page` | Go to URL, back/forward, reload |
| `new_page` | Create new tab |
| `close_page` | Close tab |
| `select_page` | Switch active page |
| `list_pages` | List open pages |
| `wait_for` | Wait for text to appear |

### Debugging (6)
| Tool | Description |
|------|-------------|
| `evaluate_script` | Execute JavaScript |
| `take_screenshot` | Capture screenshot |
| `take_snapshot` | Accessibility tree (UIDs like `ref:e12`) |
| `list_console_messages` | Console messages with pagination |
| `get_console_message` | Specific console message details |
| `lighthouse_audit` | Lighthouse accessibility/SEO/perf audit |

### Performance (4)
| Tool | Description |
|------|-------------|
| `performance_start_trace` | Start trace recording |
| `performance_stop_trace` | Stop trace, get results |
| `performance_analyze_insight` | Analyze specific trace insight |
| `take_memory_snapshot` | Capture heap snapshot |

### Network (2)
| Tool | Description |
|------|-------------|
| `list_network_requests` | List requests with filtering |
| `get_network_request` | Request/response details by ID |

### Emulation (2)
| Tool | Description |
|------|-------------|
| `emulate` | Network/CPU throttling, geolocation, viewport |
| `resize_page` | Change viewport dimensions |

### Dialog (1)
| Tool | Description |
|------|-------------|
| `handle_dialog` | Accept/dismiss browser dialogs |

### Slim Mode (3 tools only)
Navigation, script evaluation, and screenshots.

---

## Browser-Pilot Current Architecture

### Connection Lifecycle

```
Browser.connect(options)
    ↓
createProvider(options)        ← Factory: browserbase | browserless | generic
    ↓
provider.createSession()       ← Returns { wsUrl, sessionId, close() }
    ↓
createCDPClient(wsUrl)         ← Pure WebSocket, no dependencies
    ↓
Browser instance
    ↓
browser.page()                 ← Target discovery + attach
    ↓
Target.getTargets → scoreTarget() → pickBestTarget()
    ↓
Target.attachToTarget(targetId, { flatten: true })
    ↓
Page.init() → enable CDP domains
    ↓
Page ready
```

### Provider Interface
```typescript
interface Provider {
  readonly name: string;
  createSession(options?: CreateSessionOptions): Promise<ProviderSession>;
  resumeSession?(sessionId: string): Promise<ProviderSession>;
}

interface ProviderSession {
  wsUrl: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  close(): Promise<void>;
}
```

### Existing Generic Provider

The Generic provider (`src/providers/generic.ts`) is already a pass-through:
```typescript
class GenericProvider implements Provider {
  readonly name = 'generic';
  async createSession(): Promise<ProviderSession> {
    return { wsUrl: this.wsUrl, close: async () => {} };
  }
}
```

**It already has discovery helpers:**
```typescript
// Already exists in src/providers/generic.ts:81-110
export async function discoverTargets(host = 'localhost:9222'): Promise<Target[]>
export async function getBrowserWebSocketUrl(host = 'localhost:9222'): Promise<string>
```

### CLI Auto-Discovery

`bp connect` (without `--url`) already auto-discovers local Chrome:
```typescript
// In connect.ts — if no wsUrl and provider is generic:
wsUrl = await getBrowserWebSocketUrl('localhost:9222');
// Queries http://localhost:9222/json/version, retries up to 10 times
```

### CDP Domains Used by Browser-Pilot

Browser-pilot uses these CDP domains directly (no Puppeteer abstraction):

- **Target:** `getTargets`, `createTarget`, `closeTarget`, `attachToTarget`
- **Page:** `enable`, `navigate`, `reload`, `captureScreenshot`, `addScriptToEvaluateOnNewDocument`, `handleJavaScriptDialog`
- **DOM:** `enable`, `getDocument`, `querySelector`, `resolveNode`, `getBoxModel`, `getContentQuads`, `describeNode`, `focus`, `scrollIntoViewIfNeeded`
- **Runtime:** `enable`, `evaluate`, `callFunctionOn`, `addBinding`, `releaseObject`
- **Input:** `dispatchMouseEvent`, `dispatchKeyEvent`, `insertText`
- **Network:** `enable`, `disable`, `setCookie`, `getCookies`, `deleteCookies`
- **Emulation:** `setDeviceMetricsOverride`, `setUserAgentOverride`, `setGeolocationOverride`, etc.
- **Accessibility:** `getFullAXTree`
- **Fetch:** `enable`, `disable`, `continueRequest`, `fulfillRequest`, `failRequest`
- **Browser:** `grantPermissions`, `revokePermissions`, `setDownloadBehavior`

---

## Integration Analysis

### What browser-pilot gains from chrome-devtools-mcp's approach

| Capability | Currently in BP | In chrome-devtools-mcp | Integration Value |
|------------|----------------|----------------------|-------------------|
| Connect to local Chrome (port-based) | Yes (generic provider) | Yes | Already have it |
| **autoConnect (no launch flags)** | **No** | **Yes** | **HIGH — killer feature** |
| Accessibility snapshots | Yes (refs: `e12`) | Yes (UIDs) | Already have it |
| Page automation (click/fill/etc.) | Yes | Yes (via Puppeteer) | Already have it |
| Performance tracing | No | Yes (Lighthouse) | Medium |
| Console message capture | No | Yes | Medium |
| Memory snapshots | No | Yes | Low |
| Network request inspection | Partial (interceptor) | Yes (list/detail) | Medium |
| MCP server interface | No | Yes | Separate concern |

### The Big Win: autoConnect Without Puppeteer

chrome-devtools-mcp uses Puppeteer to connect to Chrome. But the autoConnect discovery mechanism is **just reading a file** — the `DevToolsActivePort` file. Browser-pilot can do this directly:

```typescript
// Pseudocode for what browser-pilot needs
function discoverChromeAutoConnect(channel = 'stable'): string {
  const userDataDir = getChromeUserDataDir(channel); // platform-specific
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const [port, wsPath] = fs.readFileSync(portFile, 'utf8').split('\n');
  return `ws://127.0.0.1:${port.trim()}${wsPath.trim()}`;
}
```

**Browser-pilot advantage:** Zero dependencies. No Puppeteer. Direct CDP over WebSocket using the existing `CDPClient`.

### What Would NOT Be Integrated

- **Puppeteer:** Browser-pilot has its own CDP client — adding Puppeteer would be antithetical to the zero-dependency design
- **MCP server protocol:** This is a separate concern. Browser-pilot is a library/CLI, not an MCP server. An MCP wrapper could be built separately on top of browser-pilot.
- **Lighthouse:** Large dependency. Could be a separate optional module if needed.
- **Telemetry:** Not needed.

---

## Implementation Plan

### Phase 1: autoConnect Provider (Core Feature)

**New file:** `src/providers/local-chrome.ts`

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

export class LocalChromeProvider implements Provider {
  readonly name = 'local-chrome';

  constructor(private options: {
    channel?: 'stable' | 'beta' | 'dev' | 'canary';
    userDataDir?: string;  // override auto-detection
  } = {}) {}

  async createSession(): Promise<ProviderSession> {
    const wsUrl = await this.discoverWebSocketUrl();
    return {
      wsUrl,
      metadata: { provider: 'local-chrome', channel: this.options.channel },
      close: async () => {}, // don't close user's browser
    };
  }

  private async discoverWebSocketUrl(): Promise<string> {
    // Strategy 1: Read DevToolsActivePort file (autoConnect, M144+)
    const userDataDir = this.options.userDataDir ?? getChromeUserDataDir(this.options.channel);
    const portFilePath = join(userDataDir, 'DevToolsActivePort');

    if (existsSync(portFilePath)) {
      const content = readFileSync(portFilePath, 'utf8').trim();
      const lines = content.split('\n');
      if (lines.length >= 2) {
        const port = parseInt(lines[0].trim(), 10);
        const wsPath = lines[1].trim();
        if (port > 0 && port <= 65535 && wsPath.startsWith('/')) {
          return `ws://127.0.0.1:${port}${wsPath}`;
        }
      }
    }

    // Strategy 2: Fall back to HTTP discovery on common ports
    for (const port of [9222, 9229]) {
      try {
        return await getBrowserWebSocketUrl(`localhost:${port}`);
      } catch { /* try next */ }
    }

    throw new Error(
      'Could not find a running Chrome instance.\n' +
      'Options:\n' +
      '  1. Chrome 144+: Open chrome://inspect/#remote-debugging and enable it\n' +
      '  2. Any Chrome: Launch with --remote-debugging-port=9222\n' +
      '  3. Specify --url ws://... directly'
    );
  }
}

function getChromeUserDataDir(channel: string = 'stable'): string {
  const p = platform();
  const channelSuffix = channel === 'stable' ? '' :
    channel === 'beta' ? ' Beta' :
    channel === 'dev' ? ' Dev' :
    channel === 'canary' ? ' Canary' : '';

  switch (p) {
    case 'linux':
      const linuxName = channel === 'canary' ? 'chrome-canary' :
        channel === 'stable' ? 'google-chrome' : `google-chrome-${channel}`;
      return join(homedir(), '.config', linuxName);
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', `Google/Chrome${channelSuffix}`);
    case 'win32':
      return join(process.env.LOCALAPPDATA ?? '', `Google\\Chrome${channelSuffix}\\User Data`);
    default:
      throw new Error(`Unsupported platform: ${p}`);
  }
}
```

### Phase 2: CLI Integration

Update `bp connect` to support the new provider:

```bash
# Auto-discover running Chrome (reads DevToolsActivePort)
bp connect --provider local-chrome

# Specify channel
bp connect --provider local-chrome --channel canary

# Shorthand (potential new flag)
bp connect --local
bp connect --auto
```

### Phase 3: Enhanced Discovery (Optional)

Add capabilities that chrome-devtools-mcp has but browser-pilot currently lacks:

1. **Console message capture** — subscribe to `Runtime.consoleAPICalled` and `Runtime.exceptionThrown`
2. **Network request logging** — already partially there via `Network.enable` + event listeners
3. **Performance tracing** — `Tracing.start` / `Tracing.end` / `Tracing.dataCollected` CDP domains

### Phase 4: MCP Server Wrapper (Separate Package)

If desired, build an MCP server that wraps browser-pilot (separate from this integration):

```
AI Agent <──stdio──> bp-mcp-server <──library call──> browser-pilot <──CDP/WS──> Chrome
```

This would be a thin MCP adapter, not a port of chrome-devtools-mcp.

---

## Validation Strategy

### 1. Unit Test: DevToolsActivePort Parsing

```typescript
test('parses DevToolsActivePort file', () => {
  const content = '9222\n/devtools/browser/abc-123\n';
  const wsUrl = parseDevToolsActivePort(content);
  expect(wsUrl).toBe('ws://127.0.0.1:9222/devtools/browser/abc-123');
});

test('handles malformed DevToolsActivePort', () => {
  expect(() => parseDevToolsActivePort('')).toThrow();
  expect(() => parseDevToolsActivePort('not-a-number\n/path')).toThrow();
  expect(() => parseDevToolsActivePort('9222')).toThrow(); // missing path
});
```

### 2. Unit Test: Platform-Specific User Data Dir

```typescript
test('resolves Chrome user data dir per platform', () => {
  // Mock os.platform() and os.homedir()
  const dir = getChromeUserDataDir('stable');
  // Assert platform-specific path
});
```

### 3. Integration Test: Connect to Local Chrome

```typescript
test('connects to local Chrome via autoConnect', async () => {
  // Requires Chrome running with remote debugging enabled
  const browser = await Browser.connect({ provider: 'local-chrome' });
  const page = await browser.page();
  const snapshot = await page.snapshot();
  expect(snapshot).toBeTruthy();
  await browser.disconnect();
});
```

### 4. Manual Validation Checklist

- [ ] Launch Chrome normally (no flags)
- [ ] Navigate to `chrome://inspect/#remote-debugging`
- [ ] Enable remote debugging
- [ ] Run `bp connect --provider local-chrome`
- [ ] Verify connection succeeds
- [ ] Run `bp snapshot` — see accessibility tree of active tab
- [ ] Run `bp exec '{"action":"click","selector":"..."}' ` — interact with the page
- [ ] Verify Chrome shows "being controlled" banner
- [ ] Disconnect — verify Chrome continues running normally

### 5. Fallback Validation

- [ ] Test with Chrome < 144 (no `DevToolsActivePort` file) — should fall back to port scanning
- [ ] Test with Chrome launched via `--remote-debugging-port=9222` — should work via fallback
- [ ] Test with no Chrome running — should give clear error message
- [ ] Test on Linux, macOS, Windows — platform path detection

---

## Key Differences: browser-pilot vs chrome-devtools-mcp

| Aspect | browser-pilot | chrome-devtools-mcp |
|--------|--------------|-------------------|
| CDP Client | Custom, zero-dep | Puppeteer (24.39.0) |
| Dependencies | **0 production** | Puppeteer + Lighthouse + DevTools frontend |
| Runtime | Node, Bun, Workers | Node only |
| Interface | Library + CLI | MCP server (stdio) |
| Snapshot format | `ref:e12` notation | UID-based (similar) |
| autoConnect | **Not yet** (easy to add) | Yes |
| Daemon mode | Yes (Unix socket) | No |
| Session caching | Yes | No |
| Performance tracing | No | Yes (Lighthouse) |
| Console capture | No | Yes |

### Why This Integration Matters

1. **Connect to ANY Chrome session** — users can automate their actual browsing session, with cookies, logins, and state intact
2. **Zero dependencies** — browser-pilot does it without Puppeteer, keeping the package lean
3. **Daemon advantage** — once connected via autoConnect, the daemon caches the WebSocket for ~5-15ms reconnects vs chrome-devtools-mcp's cold-start every time
4. **Worker-compatible** — the discovery logic is Node/Bun only, but once you have the wsUrl, Cloudflare Workers can connect too

---

## Sources

- [npm: chrome-devtools-mcp](https://www.npmjs.com/package/chrome-devtools-mcp)
- [GitHub: ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [Chrome Blog: Chrome DevTools MCP](https://developer.chrome.com/blog/chrome-devtools-mcp)
- [Chrome Blog: Debug your browser session with autoConnect](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)
- [Chrome Blog: Remote debugging port security changes (Chrome 136+)](https://developer.chrome.com/blog/remote-debugging-port)
- [Chrome DevTools Protocol documentation](https://chromedevtools.github.io/devtools-protocol/)
- [chrome.debugger API reference](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Puppeteer.connect() API](https://pptr.dev/api/puppeteer.puppeteer.connect)
- [Playwright BrowserType.connectOverCDP()](https://playwright.dev/docs/api/class-browsertype)
- [CDP FAQ: DevToolsActivePort format](https://github.com/ChromeDevTools/devtools-protocol/issues/55)
- [GitHub Issue #818: Incorrect userdata dir](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/818)
- [GitHub Issue #914: Could not find DevToolsActivePort](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/914)
