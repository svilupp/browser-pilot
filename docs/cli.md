# CLI Reference

The browser-pilot CLI (`bp`) provides session-based browser control from the command line.

## Installation

The CLI is included with the package:

```bash
bun add browser-pilot
# Now you can use: bunx bp or npx bp

# Or install globally
bun add -g browser-pilot
# Now you can use: bp
```

## Commands

### connect

Create or resume a browser session.

```bash
bp connect [options]
```

**Options:**
- `-p, --provider <type>` - Provider: `browserbase`, `browserless`, `generic` (default: `generic`)
- `-n, --name <name>` - Session name (auto-generated if not provided)
- `-r, --resume <id>` - Resume existing session
- `--url <wsUrl>` - WebSocket URL (for generic provider)
- `--api-key <key>` - API key (or use env vars)
- `--project-id <id>` - Project ID (BrowserBase)
- `--export-log <path>` - Duplicate logs to specified file for local analysis
- `--no-daemon` - Skip daemon creation (direct WebSocket only)
- `--daemon-idle <mins>` - Daemon idle timeout in minutes (default: 60)
- `--record` - Enable screenshot recording for all subsequent `bp exec` calls in this session
- `--record-format <type>` - Screenshot format for session recording: `webp`, `png`, `jpeg`
- `--record-quality <n>` - Screenshot quality for session recording (0-100, for `webp`/`jpeg`)
- `--no-highlights` - Disable action overlays on session recording screenshots

**Examples:**

```bash
# Local Chrome (auto-discovers)
bp connect --provider generic --name dev

# With export log for local debugging
bp connect --provider generic --name dev --export-log ./logs/session.jsonl

# BrowserBase
bp connect -p browserbase -n prod --api-key $BROWSERBASE_API_KEY

# Resume session
bp connect --resume my-session

# Without daemon (direct WebSocket only)
bp connect --provider generic --name dev --no-daemon

# Enable recording for all exec calls in this session
bp connect --provider generic --name dev --record
bp connect --record --record-format webp --record-quality 40
```

### exec

Execute actions on the current session.

> **Full guide:** [Action Recording Guide](./guides/action-recording.md) — when to use `bp record` vs `bp exec --record`, artifact layout, and redaction behavior.

```bash
bp exec <actions> [options]
```

**Options:**
- `-s, --session <id>` - Session to use (uses most recent if not specified)
- `--file <path>` - Read actions from a JSON file
- `-f, --format <format>` - Output format: `json`, `pretty` (default: `pretty`)
- `--trace` - Enable tracing output
- `--record` - Capture a screenshot trail while replaying
- `--record-dir <path>` - Override the replay recording output directory
- `--record-format <type>` - Screenshot format: `webp`, `png`, `jpeg`
- `--record-quality <n>` - Screenshot quality for `webp`/`jpeg` (0-100)
- `--no-highlights` - Disable action overlays on replay screenshots

**Examples:**

```bash
# Single action
bp exec '{"action":"goto","url":"https://example.com"}'

# Multiple actions
bp exec '[
  {"action":"fill","selector":"#search","value":"test"},
  {"action":"submit","selector":"form"}
]'

# Replay with screenshots + recording.json
bp exec --record --file workflow.json

# With session and JSON output
bp exec -s my-session --json '{"action":"snapshot"}'
```

**Preferred agent workflow:** use `bp snapshot -i` first, target `ref:eN` values in `bp exec` actions, and fall back to `bp diagnose` if an action fails. Reserve raw JavaScript evaluation for inspection/debugging after the high-level actions have already failed.

**Replay recording notes:**
- `bp exec --record` writes `recording.json` plus `screenshots/` for the latest replay
- Recording can also be enabled at the session level via `bp connect --record` — all subsequent `bp exec` calls in that session are recorded automatically
- When session-level recording is active, frames from multiple `bp exec` calls accumulate in the same `recording.json` manifest
- Per-call `--record` flags on `bp exec` override session-level defaults
- Sensitive fields are redacted automatically based on field metadata (`password`, `hidden`, `one-time-code`, `cc-*`)
- Failed replays still write the manifest so you can inspect the captured trail

### snapshot

Get page accessibility snapshot.

```bash
bp snapshot [options]
```

**Options:**
- `-s, --session <id>` - Session to use
- `-f, --format <format>` - Output: `json`, `pretty`
- `-i, --interactive` - Show interactive elements only (recommended)
- `--format <type>` - Snapshot format: `full`, `interactive`, `text` (default: `text`)
- `--diff <file>` - Compare with saved snapshot and show differences
- `--inspect` - Inject visual ref labels on the page
- `--keep` - Keep overlay visible (with `--inspect`)

**Examples:**

```bash
# Interactive elements only (recommended — shows buttons, inputs, links)
bp snapshot -i

# Text representation (full accessibility tree)
bp snapshot -s my-session --format text

# Full snapshot as JSON
bp snapshot -s my-session --format full --json

# Compare with previous state
bp snapshot -s my-session > before.json
# ... perform actions ...
bp snapshot -s my-session --diff before.json

# Visual inspection with ref labels
bp snapshot -s my-session --inspect --keep
```

### diagnose

Debug element selection issues. Finds exact matches, fuzzy matches, and explains why selectors might fail.

```bash
bp diagnose <selector> [options]
```

**Options:**
- `-s, --session <id>` - Session to use
- `-f, --format <format>` - Output: `json`, `pretty`
- `--max <n>` - Maximum candidates to return (default: 5)

**Examples:**

```bash
# Diagnose a CSS selector
bp diagnose '#submit-button' -s my-session

# Machine-readable output for AI agents
bp diagnose '#submit' -s my-session --json

# Find up to 10 candidates
bp diagnose '.btn' -s my-session --max 10
```

**Output includes:**
- Exact matches with visibility status
- Fuzzy matches with similarity scores
- Reasons elements might not be interactable (hidden, disabled, covered)
- Suggested alternative selectors

### text

Extract text content from the page.

```bash
bp text [options]
```

**Options:**
- `-s, --session <id>` - Session to use
- `--selector <css>` - Extract text from specific element

**Examples:**

```bash
# Full page text
bp text -s my-session

# Specific element
bp text -s my-session --selector ".main-content"
```

### screenshot

Take a screenshot.

```bash
bp screenshot [options]
```

**Options:**
- `-s, --session <id>` - Session to use
- `--output <file>` - Output file path (default: `screenshot.png`)
- `--format <type>` - Format: `png`, `jpeg`, `webp`
- `--quality <n>` - Quality 0-100 (jpeg/webp only)
- `--full-page` - Capture full page

**Examples:**

```bash
bp screenshot -s my-session --output page.png
bp screenshot -s my-session --full-page --output full.png
bp screenshot -s my-session --format jpeg --quality 80 --output page.jpg
```

### list

List all saved sessions with optional log access.

```bash
bp list [options]
```

**Options:**
- `-s, --session <id>` - Filter to specific session
- `-f, --format <format>` - Output: `json`, `pretty`
- `--log-path` - Show path to session log file
- `--log-tail <n>` - Show last N log entries
- `--info` - Show detailed session info including log stats

**Examples:**

```bash
# List all sessions
bp list
# ID          PROVIDER     CREATED              URL
# my-session  browserbase  2024-01-15 10:30:00  https://example.com
# dev         generic      2024-01-15 09:00:00  about:blank

# Show session log path
bp list -s my-session --log-path
# /Users/you/.browser-pilot/sessions/my-session/log.jsonl

# View recent commands
bp list -s my-session --log-tail 10

# Full session info with log stats
bp list -s my-session --info
```

### record

Record browser actions to JSON for replay. Captures human interactions and saves them as steps compatible with `page.batch()`. This is ideal for humans who want to create automations by demonstrating workflows rather than writing code.

```bash
bp record [options]
```

**Options:**
- `-s, --session [id]` - Session to use:
  - Omit `-s`: auto-connect to local browser
  - `-s` alone: use most recent session
  - `-s <id>`: use specific session
- `-f, --file <path>` - Output file (default: `recording.json`)
- `--timeout <ms>` - Auto-stop after timeout

**Examples:**

```bash
# Auto-connect to local Chrome and record
bp record

# Use most recent session
bp record -s

# Use specific session with custom output
bp record -s my-session -f login-flow.json

# Replay a recording
bp exec --file recording.json
```

**Notes:**
- Sensitive fields are automatically redacted as `[REDACTED]` based on field settings such as `type="password"`, `type="hidden"`, and secret/autofill hints like `autocomplete="one-time-code"` or `cc-number`
- Selectors are multi-selector arrays ordered by reliability
- Press Ctrl+C to stop recording and save

### clean

Remove old sessions, logs, and replay artifacts.

```bash
bp clean [options]
```

**Options:**
- `--max-age <hours>` - Remove sessions older than N hours (default: `24`)
- `--max-size <size>` - Remove oldest sessions until total size drops below the limit
- `--dry-run` - Show what would be removed without deleting
- `--all` - Remove all sessions

**Examples:**

```bash
# Age-based cleanup
bp clean
bp clean --max-age 4

# Size-based cleanup
bp clean --max-size 500MB
bp clean --max-size 1GB --dry-run
```

**Notes:**
- `--max-size` removes the oldest sessions first and keeps the newest session
- Attached daemons are stopped before their sessions are deleted

### audio

Test voice/audio AI agents. Feed audio as microphone input, capture spoken responses, and optionally transcribe via OpenAI Whisper.

> **Full guide:** [Voice Agent Testing Guide](./guides/voice-agent-testing.md) — setup order, troubleshooting, validation checklist.

```bash
bp audio <subcommand> [options]
```

**Subcommands:**
- `roundtrip` - Play input + capture response (full voice round-trip)
- `play` - Feed audio file into the page's fake microphone
- `capture` - Capture audio output from the page
- `setup` - Set up audio I/O on the session (auto-runs if needed)
- `check` - Validate audio pipeline and report status

**Common Options:**
- `-s, --session [id]` - Session to use (omit: auto-connect, `-s`: latest, `-s <id>`: specific)
- `--transcribe` - Transcribe captured audio via OpenAI Whisper. **Requires `OPENAI_API_KEY`** env var (validated immediately)
- `--language <lang>` - Language hint for transcription (e.g. `en`, `es`)
- `--verbose` - Show per-chunk RMS levels and silence detection diagnostics
- `-i, --input <file>` - Audio file to play (WAV, MP3, OGG)
- `-o, --out <file>` - Save captured audio to WAV file
- `--silence-timeout <ms>` - Stop after N ms of silence (default: 1500)
- `--silence-threshold <n>` - RMS threshold for silence (default: 0.01)
- `--max-duration <ms>` - Maximum capture time (default: 300000)
- `--pre-delay <ms>` - Wait before playing input (default: 0)
- `--timeout <ms>` - Max total round-trip time (default: 120000)
- `--send-selector <sel>` - Click this selector after input finishes (push-to-talk UIs)
- `--no-wait` - Don't wait for playback to finish (play only)
- `--duration <ms>` - Fixed-duration capture (capture only)

**Examples:**

```bash
# Validate audio pipeline before testing
bp audio check -s mysession
# Output: "READY for roundtrip" with agent AudioContext detected

# Full voice agent test: send prompt, capture response, transcribe
bp audio roundtrip -i prompt.wav --transcribe --silence-timeout 1500

# Save response audio for manual review
bp audio roundtrip -i prompt.wav -o response.wav --transcribe

# Push-to-talk agent
bp audio roundtrip -i prompt.wav --send-selector "#send-btn" --transcribe

# Capture audio output (agent already speaking)
bp audio capture --transcribe --silence-timeout 1500

# Just play audio into the microphone
bp audio play -i greeting.wav

# Debug with verbose output
bp audio roundtrip -i prompt.wav --verbose --transcribe --silence-timeout 1500
```

**Important:**
- Audio overrides must be injected BEFORE the voice agent initializes. If capture returns empty, reload the page after `bp audio setup`.
- Default `--silence-timeout` is 1500ms — agents rarely pause >1.5s mid-sentence.
- `--transcribe` adds ~1-2s overhead (Whisper API). Safe to use in hot loops.
- Use `bp audio check` to validate the pipeline before testing.
- Use `--json` for structured output in CI/scripting.

### listen

Monitor network traffic (WebSocket/HTTP) via CDP. Outputs structured JSONL to stdout, status messages to stderr.

```bash
bp listen <mode> [options]
```

**Modes:**
- `ws` - WebSocket traffic only
- `http` - HTTP requests/responses only
- `all` - Both WebSocket and HTTP

**Options:**
- `-s, --session [id]` - Session to use (omit: auto-connect, `-s`: latest, `-s <id>`: specific)
- `-m, --match <glob>` - Filter by URL glob pattern (e.g. `"*realtime*"`)
- `-o, --output <file>` - Write JSONL to file instead of stdout
- `--max-payload <n>` - Max text payload preview length (default: 256)
- `--timeout <ms>` - Auto-stop after N milliseconds
- `-q, --quiet` - Suppress stderr status messages

**Examples:**

```bash
# Debug a voice agent's WebSocket protocol
bp listen ws -m "*voice*" -o voice-traffic.jsonl

# Watch all API calls during a session
bp listen http -m "*/api/*" --max-payload 1024

# Capture everything for 60 seconds
bp listen all -o full-trace.jsonl --timeout 60000

# Pipe to jq for live filtering
bp listen ws | jq 'select(.type == "ws:frame:recv")'
```

### close

Close a session.

```bash
bp close [options]
```

**Options:**
- `-s, --session <id>` - Session to close (required)

**Example:**

```bash
bp close -s my-session
```

### daemon

Manage the WebSocket daemon for a session. The daemon holds the CDP WebSocket open so subsequent CLI commands connect via fast Unix socket (~5-15ms) instead of re-establishing WebSocket (~280-1030ms).

```bash
bp daemon <subcommand> [session]
```

**Subcommands:**
- `status` - Show daemon PID, uptime, and connection state
- `stop` - Stop daemon for a session
- `logs` - Tail daemon log output

**Examples:**

```bash
# Check daemon health
bp daemon status
bp daemon status my-session

# Stop daemon
bp daemon stop
bp daemon stop my-session

# View daemon logs
bp daemon logs
bp daemon logs my-session
```

**Notes:**
- Daemon spawns automatically on `bp connect` (use `--no-daemon` to disable)
- Each session gets its own daemon with a configurable idle timeout (default: 60 minutes)
- If daemon dies, CLI falls back to direct WebSocket silently
- Daemon logs are stored at `~/.browser-pilot/sessions/{id}/daemon.log`

## Global Options

These options work with all commands:

- `-s, --session <id>` - Session ID to use
- `-f, --format <format>` - Output format: `json` or `pretty`
- `--json` - JSON output (preferred over `-f json`)
- `--pretty` - Alias for `-f pretty`
- `--trace` - Enable execution tracing

## Action DSL

The `exec` command accepts actions in JSON format:

```typescript
interface Action {
  action: 'goto' | 'click' | 'fill' | 'type' | 'select' | 'check' |
          'uncheck' | 'submit' | 'press' | 'shortcut' | 'focus' | 'hover' |
          'scroll' | 'wait' | 'snapshot' | 'screenshot' |
          'assertVisible' | 'assertExists' | 'assertText' |
          'assertUrl' | 'assertValue';

  // Target element(s) - array means try each until one works
  selector?: string | string[];

  // Action-specific properties
  url?: string;           // goto
  value?: string;         // fill, type, select
  key?: string;           // press
  waitFor?: 'visible' | 'hidden' | 'navigation' | 'networkIdle';  // wait

  // Options
  timeout?: number;       // Override default timeout
  optional?: boolean;     // Don't fail if element not found
  method?: 'enter' | 'click' | 'enter+click';  // submit (for buttons)
  // Note: When targeting a <form> element directly, uses form.requestSubmit()
  clear?: boolean;        // fill (default: true)
  delay?: number;         // type (ms between keystrokes)
  blur?: boolean;         // fill, type (trigger blur after input)
  combo?: string;         // shortcut (e.g. "Control+a")
  modifiers?: string[];   // press (e.g. ["Control", "Shift"])
  expect?: string;        // assertText, assertUrl, assertValue
  retry?: number;         // Retry count on failure (default: 0)
  retryDelay?: number;    // Delay between retries in ms (default: 500)
}
```

### Assertion Actions

Five assertion types are available for verifying page state:

| Action | Requires | Behavior |
|--------|----------|----------|
| `assertVisible` | `selector` | Element exists **and** is visible (not hidden, zero-opacity, or zero-size) |
| `assertExists` | `selector` | Element exists in the DOM (may be hidden) |
| `assertText` | `expect` (or `value`), optional `selector` | Page/element text contains the expected substring |
| `assertUrl` | `expect` (or `url`) | Current URL contains the expected substring |
| `assertValue` | `selector`, `expect` (or `value`) | Input element's value matches exactly |

```bash
# Verify an element is visible
bp exec '{"action":"assertVisible","selector":"#welcome-banner"}'

# Check page text contains a string
bp exec '{"action":"assertText","expect":"Order confirmed"}'

# Check text within a specific element
bp exec '{"action":"assertText","selector":".status","expect":"Success"}'

# Assert current URL after navigation
bp exec '{"action":"assertUrl","expect":"/dashboard"}'

# Assert an input's value
bp exec '{"action":"assertValue","selector":"#email","expect":"test@example.com"}'
```

### Retry Support

Any step accepts `retry` and `retryDelay` to automatically re-attempt on failure. This is useful for assertions that depend on async state and for flaky interactions.

```bash
# Retry an assertion up to 3 times, 1s apart
bp exec '{"action":"assertText","expect":"Ready","retry":3,"retryDelay":1000}'

# Retry a click that depends on a slow-loading element
bp exec '{"action":"click","selector":"#dynamic-btn","retry":2}'
```

The default `retryDelay` is 500ms. The step is attempted `retry + 1` times total (1 initial + N retries).

### Keyboard Shortcuts

The `press` action supports modifier keys, and the `shortcut` action provides a convenient combo string format:

```bash
# press with modifiers
bp exec '{"action":"press","key":"a","modifiers":["Control"]}'
bp exec '{"action":"press","key":"z","modifiers":["Meta","Shift"]}'

# shortcut (combo string)
bp exec '{"action":"shortcut","combo":"Control+a"}'
bp exec '{"action":"shortcut","combo":"Meta+Shift+z"}'
```

Valid modifiers: `Control`, `Shift`, `Alt`, `Meta`.

### Structured Failure Info

When a step fails, the result includes structured failure data for programmatic consumption:

```json
{
  "success": false,
  "failureReason": "covered",
  "coveringElement": { "tag": "div", "className": "modal-overlay" },
  "suggestion": "Element is blocked by another element. Dismiss the covering element first.",
  "hints": [{ "selector": "#alt-btn", "reason": "Similar element found" }]
}
```

**`failureReason` values:** `missing`, `hidden`, `covered`, `disabled`, `readonly`, `detached`, `replaced`, `notEditable`, `timeout`, `navigation`, `cdpError`, `unknown`.

Each failure includes a `suggestion` string guiding the agent toward recovery. When the failure is element-related, `hints` may contain alternative selectors.

## Workflow Runner

The `run` command executes a JSON workflow file:

```bash
bp run login-flow.json
bp run checkout.json --on-fail continue --json
bp run smoke-test.json --timeout 10000
```

Workflow files can be a bare JSON array or a `{ "steps": [...] }` wrapper:

```json
[
  { "action": "goto", "url": "https://example.com/login" },
  { "action": "fill", "selector": "#email", "value": "user@example.com" },
  { "action": "fill", "selector": "#password", "value": "secret" },
  { "action": "submit", "selector": "form" },
  { "action": "assertUrl", "expect": "/dashboard" },
  { "action": "assertText", "expect": "Welcome" }
]
```

**Options:**
- `--on-fail <stop|continue>` — How to handle failures (default: `stop`)
- `--timeout <ms>` — Default timeout for all steps
- `--json` — Output results as JSON
- `-s, --session <id>` — Session to use (default: most recent)

Steps are validated before execution. Exit code is 0 on success, 1 on failure.

## Session Storage

Sessions are stored in `~/.browser-pilot/sessions/`:

```bash
~/.browser-pilot/sessions/
├── my-session.json
├── dev.json
└── prod.json
```

Each session file contains:

```json
{
  "id": "my-session",
  "provider": "browserbase",
  "wsUrl": "wss://...",
  "providerSessionId": "...",
  "targetId": "ABCD1234...",
  "exportLog": "./logs/my-session.jsonl",
  "createdAt": "2024-01-15T10:30:00Z",
  "lastActivity": "2024-01-15T10:35:00Z",
  "currentUrl": "https://example.com",
  "daemon": {
    "socketPath": "/Users/you/.browser-pilot/sessions/my-session/daemon.sock",
    "pid": 12345,
    "startedAt": "2024-01-15T10:30:01Z"
  }
}
```

The `targetId` field ensures consistent page targeting when multiple browser tabs are open. The `exportLog` field is only present if `--export-log` was used during connect. The `daemon` field is present when a daemon is running for the session.

## Session Attach Behavior

`bp exec` and `bp eval` try the daemon fast-path first (Unix socket), then fall back to direct WebSocket. If a daemon is running for the session, commands connect via Unix socket (~5-15ms overhead). If the daemon is unavailable, they connect directly via WebSocket using the stored `wsUrl`. Stale daemons are auto-cleaned and stale session files are removed on connection failure.

## AI Agent Integration

The CLI is designed for AI agent tool calls. Example tool definition:

```json
{
  "name": "browser",
  "description": "Control a web browser",
  "parameters": {
    "type": "object",
    "properties": {
      "command": {
        "type": "string",
        "enum": ["exec", "snapshot", "text"]
      },
      "actions": {
        "type": "array",
        "description": "Actions for exec command"
      }
    }
  }
}
```

Example agent workflow:

```bash
# 1. Connect once at start
bp connect -p browserbase -n agent-session

# 2. Agent executes actions
bp exec -s agent-session --json '[
  {"action":"goto","url":"https://example.com"},
  {"action":"snapshot"}
]'

# 3. Agent reads state
bp snapshot -s agent-session --format interactive --json

# 4. Agent continues...
bp exec -s agent-session --json '[
  {"action":"click","selector":"#next-page"}
]'
```
