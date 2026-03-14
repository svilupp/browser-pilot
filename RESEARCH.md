# Research: Connecting Browser-Pilot to Any Running Chrome Session

> **Date:** 2026-03-14
> **Subject:** How Chrome's new autoConnect / `DevToolsActivePort` discovery works and how browser-pilot can use it to connect to any running Chrome — no launch flags needed

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [The Problem: Chrome 136+ Broke the Old Way](#the-problem-chrome-136-broke-the-old-way)
3. [The New Way: DevToolsActivePort + autoConnect (Chrome 144+)](#the-new-way-devtoolsactiveport--autoconnect-chrome-144)
4. [DevToolsActivePort File Deep Dive](#devtoolsactiveport-file-deep-dive)
5. [CDP Connection Flow Once You Have the WebSocket URL](#cdp-connection-flow-once-you-have-the-websocket-url)
6. [CDP Domain Availability: User Chrome vs Automation Chrome](#cdp-domain-availability-user-chrome-vs-automation-chrome)
7. [All Chrome Connection Methods Compared](#all-chrome-connection-methods-compared)
8. [What Browser-Pilot Already Has](#what-browser-pilot-already-has)
9. [Implementation Plan for Browser-Pilot](#implementation-plan-for-browser-pilot)
10. [Validation Strategy](#validation-strategy)
11. [Edge Cases and Gotchas](#edge-cases-and-gotchas)
12. [Sources](#sources)

---

## Executive Summary

**Goal:** Let browser-pilot connect to any running Chrome session — the user's actual browser with their cookies, logins, and state — for CLI-first automation.

**How:** Chrome 144+ (stable since Jan 2026) introduced a way for users to enable remote debugging from within a running Chrome instance at `chrome://inspect/#remote-debugging`. When enabled, Chrome writes a `DevToolsActivePort` file containing the port and WebSocket path. Browser-pilot can read this file, construct the WebSocket URL, and connect with its existing zero-dependency CDP client.

**Key findings:**
- The discovery mechanism is trivially simple: read a 2-line text file, construct a `ws://` URL
- All CDP domains browser-pilot uses (DOM, Runtime, Page, Network, Input, Accessibility, etc.) work identically on a user's running Chrome
- Browser-pilot already has `getBrowserWebSocketUrl()` for port-based discovery — autoConnect just adds file-based discovery as a faster/more reliable strategy
- The daemon advantage is huge: once connected, browser-pilot caches the WebSocket for ~5-15ms reconnects, while other tools cold-start every time
- No new dependencies needed — this is pure file I/O + the existing CDP client

---

## The Problem: Chrome 136+ Broke the Old Way

### What Changed

Starting in **Chrome 136** (mid-2025), `--remote-debugging-port` and `--remote-debugging-pipe` are **silently ignored** when Chrome is launched with its default user data directory.

```bash
# This USED TO WORK — now silently does nothing on Chrome 136+
chrome --remote-debugging-port=9222

# This still works, but creates a SEPARATE profile (no cookies/logins)
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug
```

### Why Google Did This

Attackers were using Chrome Remote Debugging to bypass App-Bound Encryption and steal cookies. Remote debugging lets the browser itself decrypt cookies for the debugging session, making cookie theft trivial.

### The Impact

- Any tool that ran `chrome --remote-debugging-port=9222` against the user's real profile now gets silently ignored
- The port doesn't open, no `DevToolsActivePort` file is written
- Tools see "DevToolsActivePort file doesn't exist" errors
- **You can still debug a separate profile** with `--user-data-dir`, but you lose all user state (cookies, logins, extensions)

### Exceptions
- **Chrome for Testing** (`chrome-for-testing` binary) — exempt from this restriction
- **Headless Chrome** — continues to work with temporary profiles
- **Chrome 144+ autoConnect** — the new sanctioned way to debug your real profile

---

## The New Way: DevToolsActivePort + autoConnect (Chrome 144+)

### How It Works (User's Perspective)

1. User opens their normal Chrome browser
2. User navigates to `chrome://inspect/#remote-debugging`
3. User clicks to enable remote debugging (one-time toggle, persists)
4. Chrome starts an HTTP/WebSocket server on a random localhost port
5. Chrome writes a `DevToolsActivePort` file to the user data directory

### How It Works (Tool's Perspective)

1. Determine Chrome's user data directory (platform-specific, see below)
2. Read `<userDataDir>/DevToolsActivePort` — a 2-line text file
3. Parse: line 1 = port, line 2 = WebSocket path
4. Connect WebSocket to `ws://127.0.0.1:<port><path>`
5. Chrome shows a **permission dialog** to the user — they must approve
6. Once approved, full CDP access is available

### Security Gates (Cannot Be Bypassed)

1. **User must enable remote debugging** — one-time action at `chrome://inspect/#remote-debugging`
2. **Permission dialog on every connection** — Chrome prompts user each time a client connects
3. **"Controlled by automation" banner** — visible while connected
4. The `chrome://inspect` page is a privileged Chrome internal page that cannot be navigated to or interacted with via CDP

**Bottom line:** Full automation without any user interaction is not possible with autoConnect. The user must opt in. This is intentional security design.

---

## DevToolsActivePort File Deep Dive

### File Format

Plain text, two lines:

```
<port>
/devtools/browser/<guid>
```

Example:
```
9222
/devtools/browser/fa1e7ced-c136-4379-a030-360f9f0eb6b4
```

Together they form: `ws://127.0.0.1:9222/devtools/browser/fa1e7ced-c136-4379-a030-360f9f0eb6b4`

### File Location by Platform

| Platform | Channel=stable | Env Var Overrides |
|----------|---------------|-------------------|
| **Linux** | `~/.config/google-chrome/DevToolsActivePort` | `$CHROME_CONFIG_HOME` > `$XDG_CONFIG_HOME` |
| **macOS** | `~/Library/Application Support/Google/Chrome/DevToolsActivePort` | — |
| **Windows** | `%LOCALAPPDATA%\Google\Chrome\User Data\DevToolsActivePort` | — |

**Other channels:**

| Channel | Linux dir name | macOS/Win suffix |
|---------|---------------|-----------------|
| stable | `google-chrome` | (none) |
| beta | `google-chrome-beta` | ` Beta` |
| dev | `google-chrome-dev` | ` Dev` |
| canary | `chrome-canary` | ` Canary` |

### File Lifecycle

| Event | What happens |
|-------|-------------|
| Chrome starts with `--remote-debugging-port` | File written after port binds |
| Chrome starts with `--remote-debugging-port=0` | File written with randomly chosen port |
| User enables debugging at `chrome://inspect` (M144+) | File written |
| Chrome shuts down normally | **File is NOT deleted** (stale file remains) |
| Chrome crashes | **File is NOT deleted** (stale file remains) |
| Normal Chrome launch (no debugging) | File is NOT created, existing stale files NOT cleaned |
| ChromeDriver starts | Deletes existing file before launching Chrome |

### Stale File Detection

Since Chrome doesn't clean up on exit, tools must handle stale files:

```
1. Read DevToolsActivePort
2. Try HTTP GET http://127.0.0.1:<port>/json/version
3. If connection refused → file is stale
4. If GUID in response doesn't match line 2 → file is stale (different Chrome instance)
5. If both match → Chrome is alive and this is the right instance
```

### Multiple Instances / Profiles

- The file is written to the **user data directory** (parent of profile directories like `Default/`, `Profile 1/`)
- Only one Chrome process can lock a user data directory at a time
- Therefore: **one DevToolsActivePort file per running Chrome instance**
- Multiple Chrome instances require separate `--user-data-dir` flags

### Known Issues

- **Linux path bug:** Puppeteer had a typo resolving `~/.config` → `/home/<user>/config` (missing dot). Fixed in puppeteer/puppeteer#14600. Browser-pilot should use `$XDG_CONFIG_HOME` with fallback to `$HOME/.config`.
- **Snap/Flatpak Chrome on Linux:** Different data directory paths. Snap: `~/snap/chromium/common/chromium/`. Would need additional detection logic.
- **Chromium vs Chrome:** Chromium uses `chromium/` instead of `google-chrome/` on Linux, `Chromium/` instead of `Google/Chrome/` on macOS.

---

## CDP Connection Flow Once You Have the WebSocket URL

This is the same flow browser-pilot already uses. No changes needed here.

```
1. WebSocket connect    ws://127.0.0.1:<port>/devtools/browser/<guid>
        ↓                   This is the BROWSER-level session
2. Target.getTargets()  → List of all tabs/workers/etc.
        ↓
3. scoreTarget()        → Pick best page target (browser-pilot already does this)
        ↓
4. Target.attachToTarget({ targetId, flatten: true })
        ↓                   Returns sessionId for the PAGE-level session
5. Enable domains       Page.enable, DOM.enable, Runtime.enable, etc.
        ↓                   (browser-pilot already does this in Page.init())
6. Ready                Full CDP access to the page
```

### The `/json/version` HTTP Endpoint

Even with autoConnect, the HTTP endpoints are available on the same port:

```
GET http://127.0.0.1:<port>/json/version   → Browser info + webSocketDebuggerUrl
GET http://127.0.0.1:<port>/json/list      → All debuggable targets
GET http://127.0.0.1:<port>/json/protocol  → Full CDP protocol schema
PUT http://127.0.0.1:<port>/json/new?url=  → Create new tab
GET http://127.0.0.1:<port>/json/activate/<id> → Focus a tab
GET http://127.0.0.1:<port>/json/close/<id>    → Close a tab
```

Browser-pilot already uses `/json/version` in `getBrowserWebSocketUrl()` and `/json/list` in `discoverTargets()`.

---

## CDP Domain Availability: User Chrome vs Automation Chrome

**Key finding: No meaningful restrictions.** All standard CDP domains work the same way on a user's Chrome.

### Browser-Level Session (initial WebSocket)

Available: `Browser`, `Target`, `SystemInfo`, `IO`
NOT available: `Page`, `DOM`, `CSS`, `Network`, etc. (these are page-level)

### Page-Level Session (after `Target.attachToTarget`)

Available: **Everything** — `Page`, `DOM`, `CSS`, `Network`, `Runtime`, `Debugger`, `Input`, `Emulation`, `Accessibility`, `Fetch`, etc.

### The One Minor Difference

`Browser.getCommandLine()` only works if Chrome was launched with `--enable-automation`. On a user's Chrome (connected via autoConnect), this method won't return useful data. **Browser-pilot doesn't use this method**, so it's a non-issue.

### Verified: All browser-pilot CDP domains work

Every CDP domain browser-pilot uses is fully available on page sessions regardless of how Chrome was started:

| Domain | Used by browser-pilot | Works on user's Chrome? |
|--------|----------------------|------------------------|
| Target | Yes (discovery, attach) | Yes |
| Page | Yes (navigate, screenshot, scripts) | Yes |
| DOM | Yes (queries, box model, focus) | Yes |
| Runtime | Yes (evaluate, bindings) | Yes |
| Input | Yes (mouse, keyboard) | Yes |
| Network | Yes (cookies, interception) | Yes |
| Emulation | Yes (viewport, UA, geo) | Yes |
| Accessibility | Yes (snapshots) | Yes |
| Fetch | Yes (request interception) | Yes |
| Browser | Yes (permissions, downloads) | Yes |

---

## All Chrome Connection Methods Compared

| Method | User Interaction | Real Profile? | Chrome Version | browser-pilot support |
|--------|-----------------|---------------|----------------|----------------------|
| `--remote-debugging-port` + custom `--user-data-dir` | None | No (separate profile) | Any | Yes (generic provider) |
| `--remote-debugging-port` + default profile | None | Yes | **< 136 only** | Yes (generic provider) |
| `--remote-debugging-pipe` | None | Depends | Any | No (not needed) |
| **autoConnect (`DevToolsActivePort`)** | **Enable once + approve dialog** | **Yes** | **M144+** | **Not yet — this research** |
| `chrome.debugger` extension API | Install extension | Yes | Any | No (requires extension) |
| Chrome for Testing | None | No (test binary) | Any | Yes (generic provider) |

**autoConnect is the only way to get the user's real profile on Chrome 136+** without requiring Chrome for Testing.

---

## What Browser-Pilot Already Has

Browser-pilot is already 90% of the way there. The existing architecture maps perfectly:

### Existing Discovery (generic.ts)

```typescript
// Already in src/providers/generic.ts
export async function getBrowserWebSocketUrl(host = 'localhost:9222'): Promise<string>
export async function discoverTargets(host = 'localhost:9222'): Promise<Target[]>
```

### Existing CLI Auto-Discovery (connect.ts)

```typescript
// Already in bp connect — if no wsUrl and provider is generic:
wsUrl = await getBrowserWebSocketUrl('localhost:9222');
```

### What's Missing

1. **`DevToolsActivePort` file reader** — read 2 lines from a text file, construct wsUrl
2. **Platform-specific Chrome user data dir resolver** — 10 lines of code
3. **Stale file validation** — try connecting, handle failure gracefully
4. **CLI flag** — `bp connect --auto` or `bp connect --provider local-chrome`

That's it. No new CDP logic, no new WebSocket handling, no new page interaction code.

---

## Implementation Plan for Browser-Pilot

### Phase 1: DevToolsActivePort Discovery (Core)

Add to `src/providers/generic.ts` (or a new `src/providers/local-chrome.ts`):

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

/**
 * Parse DevToolsActivePort file content into a WebSocket URL.
 */
export function parseDevToolsActivePort(content: string): string {
  const lines = content.trim().split('\n');
  if (lines.length < 2) throw new Error('DevToolsActivePort: expected 2 lines');

  const port = parseInt(lines[0].trim(), 10);
  const wsPath = lines[1].trim();

  if (!Number.isFinite(port) || port < 1 || port > 65535)
    throw new Error(`DevToolsActivePort: invalid port "${lines[0]}"`);
  if (!wsPath.startsWith('/'))
    throw new Error(`DevToolsActivePort: invalid path "${wsPath}"`);

  return `ws://127.0.0.1:${port}${wsPath}`;
}

/**
 * Resolve Chrome user data directory for the current platform.
 */
export function getChromeUserDataDir(
  channel: 'stable' | 'beta' | 'dev' | 'canary' = 'stable'
): string {
  const p = platform();

  if (p === 'linux') {
    const configHome = process.env.CHROME_CONFIG_HOME
      ?? process.env.XDG_CONFIG_HOME
      ?? join(homedir(), '.config');
    const dirName = channel === 'canary' ? 'chrome-canary'
      : channel === 'stable' ? 'google-chrome'
      : `google-chrome-${channel}`;
    return join(configHome, dirName);
  }

  if (p === 'darwin') {
    const suffix = channel === 'stable' ? '' : ` ${channel.charAt(0).toUpperCase() + channel.slice(1)}`;
    return join(homedir(), 'Library', 'Application Support', `Google`, `Chrome${suffix}`);
  }

  if (p === 'win32') {
    const suffix = channel === 'stable' ? '' : ` ${channel.charAt(0).toUpperCase() + channel.slice(1)}`;
    return join(process.env.LOCALAPPDATA ?? '', 'Google', `Chrome${suffix}`, 'User Data');
  }

  throw new Error(`Unsupported platform: ${p}`);
}

/**
 * Discover Chrome WebSocket URL via DevToolsActivePort file.
 * Falls back to HTTP discovery on common ports.
 */
export async function discoverLocalChrome(options: {
  channel?: 'stable' | 'beta' | 'dev' | 'canary';
  userDataDir?: string;
} = {}): Promise<string> {
  // Strategy 1: DevToolsActivePort file (Chrome 144+ autoConnect, or --remote-debugging-port)
  const userDataDir = options.userDataDir ?? getChromeUserDataDir(options.channel);
  const portFilePath = join(userDataDir, 'DevToolsActivePort');

  if (existsSync(portFilePath)) {
    try {
      const content = readFileSync(portFilePath, 'utf8');
      const wsUrl = parseDevToolsActivePort(content);

      // Validate: is Chrome actually running on this port?
      const port = new URL(wsUrl).port;
      await fetch(`http://127.0.0.1:${port}/json/version`);
      return wsUrl;
    } catch {
      // File exists but Chrome isn't responding — stale file, try fallback
    }
  }

  // Strategy 2: HTTP discovery on common debugging ports
  for (const port of [9222, 9229]) {
    try {
      return await getBrowserWebSocketUrl(`127.0.0.1:${port}`);
    } catch { /* try next */ }
  }

  throw new Error(
    'Could not find a running Chrome instance.\n\n' +
    'To connect browser-pilot to your Chrome:\n' +
    '  Chrome 144+:  Open chrome://inspect/#remote-debugging and enable it\n' +
    '  Any Chrome:   Launch with --remote-debugging-port=9222\n' +
    '  Direct:       bp connect --url ws://...\n'
  );
}
```

### Phase 2: CLI Integration

Update `bp connect`:

```bash
# NEW: Auto-discover running Chrome via DevToolsActivePort
bp connect --auto                        # stable channel
bp connect --auto --channel canary       # canary channel
bp connect --auto --chrome-data-dir /path/to/profile

# EXISTING (unchanged):
bp connect --url ws://...                # direct WebSocket
bp connect --provider browserbase        # cloud provider
```

### Phase 3: Stale File Cleanup (Nice-to-have)

Optionally add `bp chrome status` or similar:

```bash
bp chrome status          # Check if Chrome is running + debuggable
bp chrome discover        # Find all running Chrome instances
```

---

## Validation Strategy

### Unit Tests

```typescript
// DevToolsActivePort parsing
test('parses valid DevToolsActivePort', () => {
  expect(parseDevToolsActivePort('9222\n/devtools/browser/abc-123\n'))
    .toBe('ws://127.0.0.1:9222/devtools/browser/abc-123');
});

test('rejects malformed DevToolsActivePort', () => {
  expect(() => parseDevToolsActivePort('')).toThrow();
  expect(() => parseDevToolsActivePort('not-a-number\n/path')).toThrow();
  expect(() => parseDevToolsActivePort('9222')).toThrow();
  expect(() => parseDevToolsActivePort('0\n/path')).toThrow();
  expect(() => parseDevToolsActivePort('99999\n/path')).toThrow();
  expect(() => parseDevToolsActivePort('9222\nno-leading-slash')).toThrow();
});

// Platform path resolution
test('resolves Chrome data dir for each platform', () => {
  // Mock platform() and homedir(), verify paths
});
```

### Integration Test (requires real Chrome)

```typescript
test('connects to local Chrome via DevToolsActivePort', async () => {
  const browser = await Browser.connect({ provider: 'generic', wsUrl: await discoverLocalChrome() });
  const page = await browser.page();
  const snap = await page.snapshot();
  expect(snap).toBeTruthy();
  await browser.disconnect();
});
```

### Manual Validation Checklist

- [ ] Open Chrome normally (no flags)
- [ ] Navigate to `chrome://inspect/#remote-debugging`, enable it
- [ ] Run `bp connect --auto`
- [ ] Verify connection succeeds, session created
- [ ] `bp snapshot` — see accessibility tree of current tab
- [ ] `bp exec '{"action":"goto","url":"https://example.com"}'` — navigate
- [ ] `bp exec '{"action":"screenshot"}'` — take screenshot
- [ ] Verify Chrome shows "being controlled" banner
- [ ] Disconnect — Chrome continues running normally
- [ ] Test with stale DevToolsActivePort file (kill Chrome, try connect → clear error)
- [ ] Test on Linux, macOS, Windows
- [ ] Test with `--channel canary` if Canary installed

---

## Edge Cases and Gotchas

### Stale DevToolsActivePort Files

Chrome does NOT delete the file on shutdown or crash. Browser-pilot must:
1. Read the file
2. Try to connect (or HTTP ping)
3. If connection refused → treat as stale, fall back to port scanning
4. Give a clear error message if nothing works

### Chrome 136+ with Default Profile

If the user launches Chrome with `--remote-debugging-port=9222` on Chrome 136+, it's **silently ignored** when using the default profile. The `DevToolsActivePort` file won't be written. Browser-pilot should detect this and suggest autoConnect instead.

### IPv6 / Localhost Resolution

Use `127.0.0.1` explicitly, not `localhost`. Some systems resolve `localhost` to `::1` (IPv6), causing `ECONNREFUSED` on WebSocket connections. Puppeteer 17+ had this exact bug.

### Snap/Flatpak Chrome on Linux

Sandboxed Chrome installations have different user data paths:
- **Snap:** `~/snap/chromium/common/chromium/`
- **Flatpak:** `~/.var/app/org.chromium.Chromium/config/chromium/`

Phase 1 can skip these; document as known limitation.

### Multiple Chrome Installations

If the user has both Chrome stable and Canary, each has a separate user data directory and potentially separate `DevToolsActivePort` files. The `--channel` flag lets users specify which one.

### WebSocket URL Contains a GUID

The GUID in the WebSocket path (`/devtools/browser/<guid>`) is unique per Chrome session. If Chrome restarts, the GUID changes. A stale WebSocket URL will fail to connect (HTTP 404 or WebSocket upgrade failure).

### Daemon Compatibility

The existing daemon architecture works perfectly with autoConnect:
- `bp connect --auto` discovers the WebSocket URL and creates a session
- The daemon caches the WebSocket connection
- Subsequent `bp exec` / `bp snapshot` commands connect via Unix socket (~5-15ms)
- If Chrome restarts, the daemon detects the stale connection and falls back

---

## Sources

- [Chrome Blog: Remote debugging port security changes (Chrome 136+)](https://developer.chrome.com/blog/remote-debugging-port)
- [Chrome Blog: Debug your browser session with autoConnect](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)
- [Chrome DevTools Protocol documentation](https://chromedevtools.github.io/devtools-protocol/)
- [Chromium source: devtools_http_handler.cc (writes DevToolsActivePort)](https://source.chromium.org/chromium/chromium/src/+/main:content/browser/devtools/devtools_http_handler.cc;l=109)
- [Chromium docs: User Data Directory](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md)
- [CDP FAQ: DevToolsActivePort format](https://github.com/ChromeDevTools/devtools-protocol/issues/55)
- [GitHub: ChromeDevTools/chrome-devtools-mcp (reference implementation)](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [Puppeteer Linux path bug (Issue #14600)](https://github.com/nicholmikey/nicholmikey)
- [chrome-devtools-mcp DevToolsActivePort path issues (#818, #914)](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/818)
- [Selenium Chrome 136 regression (#15688)](https://github.com/SeleniumHQ/selenium/issues/15688)
- [CDP Browser domain reference](https://chromedevtools.github.io/devtools-protocol/tot/Browser/)
- [CDP Target domain reference](https://chromedevtools.github.io/devtools-protocol/tot/Target/)
