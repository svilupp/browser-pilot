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

**Examples:**

```bash
# Local Chrome (auto-discovers)
bp connect --provider generic --name dev

# BrowserBase
bp connect -p browserbase -n prod --api-key $BROWSERBASE_API_KEY

# Resume session
bp connect --resume my-session
```

### exec

Execute actions on the current session.

```bash
bp exec <actions> [options]
```

**Options:**
- `-s, --session <id>` - Session to use (uses most recent if not specified)
- `-o, --output <format>` - Output format: `json`, `pretty` (default: `pretty`)
- `--trace` - Enable tracing output

**Examples:**

```bash
# Single action
bp exec '{"action":"goto","url":"https://example.com"}'

# Multiple actions
bp exec '[
  {"action":"fill","selector":"#search","value":"test"},
  {"action":"submit","selector":"form"}
]'

# With session and JSON output
bp exec -s my-session -o json '{"action":"snapshot"}'
```

### snapshot

Get page accessibility snapshot.

```bash
bp snapshot [options]
```

**Options:**
- `-s, --session <id>` - Session to use
- `-o, --output <format>` - Output: `json`, `pretty`
- `--format <type>` - Snapshot format: `full`, `interactive`, `text` (default: `text`)

**Examples:**

```bash
# Text representation (best for LLMs)
bp snapshot -s my-session --format text

# Interactive elements only
bp snapshot -s my-session --format interactive

# Full snapshot as JSON
bp snapshot -s my-session --format full -o json
```

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

List all saved sessions.

```bash
bp list [options]
```

**Options:**
- `-o, --output <format>` - Output: `json`, `pretty`

**Example:**

```bash
bp list
# ID          PROVIDER     CREATED              URL
# my-session  browserbase  2024-01-15 10:30:00  https://example.com
# dev         generic      2024-01-15 09:00:00  about:blank
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

## Global Options

These options work with all commands:

- `-s, --session <id>` - Session ID to use
- `-o, --output <format>` - Output format: `json` or `pretty`
- `--trace` - Enable execution tracing

## Action DSL

The `exec` command accepts actions in JSON format:

```typescript
interface Action {
  action: 'goto' | 'click' | 'fill' | 'type' | 'select' | 'check' |
          'uncheck' | 'submit' | 'press' | 'focus' | 'hover' |
          'scroll' | 'wait' | 'snapshot' | 'screenshot';

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
  method?: 'enter' | 'click' | 'enter+click';  // submit
  clear?: boolean;        // fill (default: true)
  delay?: number;         // type (ms between keystrokes)
}
```

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
  "createdAt": "2024-01-15T10:30:00Z",
  "lastActivity": "2024-01-15T10:35:00Z",
  "currentUrl": "https://example.com"
}
```

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
bp exec -s agent-session -o json '[
  {"action":"goto","url":"https://example.com"},
  {"action":"snapshot"}
]'

# 3. Agent reads state
bp snapshot -s agent-session --format interactive -o json

# 4. Agent continues...
bp exec -s agent-session -o json '[
  {"action":"click","selector":"#next-page"}
]'
```
