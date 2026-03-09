# Action Recording: Visual Screenshot Trail

Detailed implementation plan for screenshot-based "video" recording of agent actions.

---

## Current Infrastructure (What Already Exists)

### Session Storage (`~/.browser-pilot/sessions/`)
```
~/.browser-pilot/sessions/
├── {sessionId}.json              # Session metadata (provider, wsUrl, targetId, timestamps)
├── {sessionId}/
│   └── log.jsonl                 # JSON Lines action log (seq, ts, cmd, args, status, durationMs)
```

- **SessionLogger** (`src/cli/session-logger.ts:45-252`): Appends JSONL entries synchronously. Supports dual-write to an `exportLogPath` for local project convenience. Cached singletons per session.
- **Auto-cleanup**: Sessions >2 days old auto-deleted on `bp list` (`src/cli/session.ts:159-185`).
- **Clean command**: `bp clean --max-age <hours>` or `--all` via `deleteSessionFull()` which removes both JSON + log directory.

### Action Metadata Already Captured
- **StepResult** (`src/actions/types.ts:139-181`): `action`, `selector`, `selectorUsed`, `success`, `durationMs`, `error`, `failureReason`, `coveringElement`, `suggestion`, `hints`
- **LogEntry** (`src/cli/session-logger.ts:15-28`): `seq`, `ts`, `type`, `cmd`, `args`, `status`, `durationMs`, `selectorUsed`, `urlBefore`, `urlAfter`, `error`, `hints`
- **RichRecordedEvent** (`src/recording/types.ts:189-206`): `ElementPosition` (bbox + clickPoint), `PageState` (url, title, timestamp), `StateChange` (navigation, dialogs, value changes), `annotation`

### Screenshot & Overlay Support
- `page.screenshot({ format, quality, fullPage })` → base64 string via `Page.captureScreenshot` CDP (`src/browser/page.ts:1423-1452`)
- WebP supported natively by CDP with quality 0-100
- Overlay system (`src/browser/overlay.ts`): Injects `data-bp-ref` outlines + floating labels, idempotent, cleanly removable
- Click coordinates computed in every `click()` via `DOM.getContentQuads` / `DOM.getBoxModel` (`src/browser/page.ts:411-430`) — **computed but discarded**

### Batch Executor Loop (`src/actions/executor.ts:99-192`)
```
for each step:
  stepStart = Date.now()
  retry loop (up to step.retry+1 attempts):
    executeStep(step, timeout)
    → push StepResult { index, action, selector, selectorUsed, success, durationMs, result, text }
  on failure:
    → classifyFailure() → failureReason
    → generateHints() → hints
    → push StepResult with error details
    → if onFail:'stop' && !optional → return early
return BatchResult { success, steps[], totalDurationMs }
```

---

## Design: Screenshot Storage Alongside Logs

### Default Location: Session Directory
Screenshots live **inside the existing session directory**, alongside `log.jsonl`:

```
~/.browser-pilot/sessions/{sessionId}/
├── log.jsonl                           # Existing action log
├── screenshots/                        # NEW: screenshot frames
│   ├── 0001-1741500000000-goto.webp
│   ├── 0002-1741500001200-click.webp
│   ├── 0003-1741500001550-fill.webp
│   └── ...
└── recording.json                      # NEW: manifest linking frames + metadata
```

### Export Path Override
When `--export-log <path>` is set on the session (already supported), screenshots **also** get written to the export location:

```
my-project/.browser-pilot/
├── log.jsonl                           # Existing export log (dual-write)
├── screenshots/                        # NEW: export screenshots
│   ├── 0001-1741500000000-goto.webp
│   └── ...
└── recording.json                      # NEW: export manifest
```

This pairs screenshots with logs in the project directory by default when `exportLogPath` is configured.

### File Naming Convention
```
{seq:04d}-{timestampMs}-{action}.webp
```

- **`seq`** (4-digit zero-padded): Matches `LogEntry.seq` — ties screenshot to log entry. Ensures sort order.
- **`timestampMs`**: Unix milliseconds. Captures notion of time between frames. Two frames with timestamps `1741500001200` and `1741500001550` → 350ms apart. Downstream video assembly uses these deltas to control frame duration.
- **`action`**: Human-readable action name for quick browsing (`click`, `fill`, `goto`, `evaluate`, etc.)
- **`.webp`**: Default format. Quality 40 produces ~20-60KB frames — enough to see outlines and text, not pixel-perfect.

Why this naming works:
1. **Sortable**: `0001-...` sorts correctly in any file browser
2. **Composable**: All screenshots from one session share the sessionId directory
3. **Time-aware**: Millisecond timestamps let video assembly calculate inter-frame delays
4. **Unique**: `seq` + `timestamp` guarantees uniqueness even for sub-millisecond actions
5. **Debuggable**: Action name in filename lets you browse screenshots without opening them

---

## Detailed Field-by-Field Specification

### New Fields on `StepResult` (`src/actions/types.ts`)

```typescript
export interface StepResult {
  // ... existing fields (index, action, selector, selectorUsed, success, durationMs, etc.)

  /** Absolute timestamp (ms since epoch) when this step completed */
  timestamp?: number;

  /** Viewport coordinates where the action occurred (center of interacted element) */
  coordinates?: { x: number; y: number };

  /** Element bounding box at time of action (viewport-relative) */
  boundingBox?: { x: number; y: number; width: number; height: number };

  /** Path to screenshot file captured after this step (when recording enabled) */
  screenshotPath?: string;
}
```

### How Coordinates Get Populated

**Pattern**: Follow existing `_lastMatchedSelector` on Page class (`src/browser/page.ts:155`).

Add to Page class:
```typescript
private _lastActionCoordinates: { x: number; y: number } | null = null;
private _lastActionBoundingBox: { x: number; y: number; width: number; height: number } | null = null;

/** Called internally by click(), fill(), hover(), etc. after resolving element position */
private setLastActionPosition(
  coords: { x: number; y: number },
  bbox: { x: number; y: number; width: number; height: number }
): void {
  this._lastActionCoordinates = coords;
  this._lastActionBoundingBox = bbox;
}

getLastActionCoordinates(): { x: number; y: number } | null {
  return this._lastActionCoordinates;
}

getLastActionBoundingBox(): { x: number; y: number; width: number; height: number } | null {
  return this._lastActionBoundingBox;
}
```

**Where to call `setLastActionPosition()`**:

| Action Method | Where coordinates are computed | Current line | Change |
|---|---|---|---|
| `click()` | `clickX, clickY` from `DOM.getContentQuads` | `page.ts:412-430` | After computing, call `setLastActionPosition()` |
| `hover()` | Same quad/box computation | `page.ts:1148-1204` | Same |
| `fill()` | After `findElement()` + scroll | `page.ts:468-530` | Add quad/box computation before fill |
| `type()` | After `findElement()` + scroll | `page.ts:532-570` | Same |
| `select()` | After `findElement()` | `page.ts:296-349` | Same |
| `check()`/`uncheck()` | After `findElement()` | `page.ts:572-620` | Same |
| `submit()` | After `findElement()` | `page.ts:622-700` | Same |
| `focus()` | After `findElement()` | `page.ts:700-730` | Same |
| `scroll()` | After `findElement()` | `page.ts:740-800` | Same |

For non-element actions (`goto`, `evaluate`, `press`, `wait`), coordinates remain `null` — no element was interacted with.

**In the executor** (`src/actions/executor.ts:121-130`), after step execution:
```typescript
results.push({
  // ...existing fields
  timestamp: Date.now(),
  coordinates: this.page.getLastActionCoordinates() ?? undefined,
  boundingBox: this.page.getLastActionBoundingBox() ?? undefined,
});
```

### Bounding Box Extraction Helper

Shared helper since multiple actions need it (avoids duplicating quad → bbox logic):

```typescript
/** Extract viewport coordinates and bounding box for an element */
private async getElementPosition(nodeIdOrObjectId: { nodeId?: number; objectId?: string }): Promise<{
  center: { x: number; y: number };
  bbox: { x: number; y: number; width: number; height: number };
} | null> {
  try {
    const { quads } = await this.cdp.send<{ quads: number[][] }>('DOM.getContentQuads', nodeIdOrObjectId);
    if (quads?.length > 0) {
      const q = quads[0]!;
      const minX = Math.min(q[0]!, q[2]!, q[4]!, q[6]!);
      const maxX = Math.max(q[0]!, q[2]!, q[4]!, q[6]!);
      const minY = Math.min(q[1]!, q[3]!, q[5]!, q[7]!);
      const maxY = Math.max(q[1]!, q[3]!, q[5]!, q[7]!);
      return {
        center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
        bbox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      };
    }
  } catch { /* fallthrough to box model */ }

  if (nodeIdOrObjectId.nodeId) {
    const box = await this.getBoxModel(nodeIdOrObjectId.nodeId);
    if (box) {
      return {
        center: { x: box.content[0]! + box.width / 2, y: box.content[1]! + box.height / 2 },
        bbox: { x: box.content[0]!, y: box.content[1]!, width: box.width, height: box.height },
      };
    }
  }
  return null;
}
```

---

## Action Highlight Overlays

New module: `src/browser/action-highlight.ts`

### Highlight Types

```typescript
export type HighlightKind =
  | 'click'       // Red crosshair at click point + element outline
  | 'fill'        // Blue outline + value badge
  | 'type'        // Blue outline + keystroke badge
  | 'select'      // Purple outline + chosen value badge
  | 'hover'       // Light gray outline (subtle)
  | 'scroll'      // Arrow indicator at scroll position
  | 'navigate'    // URL bar badge at top of viewport
  | 'submit'      // Orange form outline
  | 'assert-pass' // Green checkmark badge
  | 'assert-fail' // Red X badge
  | 'evaluate'    // Yellow "JS" badge at top-right corner
  | 'focus'       // Dotted blue outline

export interface HighlightOptions {
  kind: HighlightKind;
  /** Element bounding box (viewport coords) — null for page-level actions */
  bbox?: { x: number; y: number; width: number; height: number };
  /** Click/action point (viewport coords) */
  point?: { x: number; y: number };
  /** Label text (filled value, selected option, URL, etc.) */
  label?: string;
}
```

### Visual Design per Kind

```typescript
const HIGHLIGHT_STYLES: Record<HighlightKind, { outline: string; badge: string; marker?: string }> = {
  'click':       { outline: '3px solid rgba(229,57,53,0.8)',   badge: '#e53935', marker: 'crosshair' },
  'fill':        { outline: '3px solid rgba(33,150,243,0.8)',  badge: '#2196f3' },
  'type':        { outline: '3px solid rgba(33,150,243,0.6)',  badge: '#2196f3' },
  'select':      { outline: '3px solid rgba(156,39,176,0.8)', badge: '#9c27b0' },
  'hover':       { outline: '2px dashed rgba(158,158,158,0.5)', badge: '#9e9e9e' },
  'scroll':      { outline: 'none',                            badge: '#607d8b', marker: 'arrow' },
  'navigate':    { outline: 'none',                            badge: '#4caf50' },
  'submit':      { outline: '3px solid rgba(255,152,0,0.8)',   badge: '#ff9800' },
  'assert-pass': { outline: '3px solid rgba(76,175,80,0.8)',   badge: '#4caf50', marker: 'check' },
  'assert-fail': { outline: '3px solid rgba(244,67,54,0.8)',   badge: '#f44336', marker: 'cross' },
  'evaluate':    { outline: 'none',                            badge: '#ffc107' },
  'focus':       { outline: '3px dotted rgba(33,150,243,0.6)', badge: '#2196f3' },
};
```

### Injection Script

Single JS function injected via `Runtime.evaluate` that:

1. Creates a container `<div id="__bp-action-highlight">` with `position:fixed; pointer-events:none; z-index:99999`
2. If `bbox` provided: draws an outline `<div>` positioned over the element
3. If `point` provided and kind is `click`: draws a crosshair (two thin lines intersecting at click point, ~20px arms, red)
4. If `label` provided: draws a badge `<div>` near the element (above bbox, or top-right for page-level actions) with the action color background, white text
5. For `evaluate` kind (no bbox): draws a "JS" badge in the top-right corner of the viewport — signals that something happened under the hood even though no element was visually interacted with
6. For `navigate` kind: draws a URL badge at the top center of the viewport
7. Returns cleanup function registered as `window.__bpRemoveActionHighlight`

### API

```typescript
/** Inject a visual highlight for the action that just occurred */
export async function injectActionHighlight(page: Page, options: HighlightOptions): Promise<void>;

/** Remove the action highlight */
export async function removeActionHighlight(page: Page): Promise<void>;

/** Map a StepResult to the appropriate HighlightKind */
export function stepToHighlightKind(step: StepResult): HighlightKind;
```

The mapping function handles:
- `click` → `'click'`
- `fill`, `type` → `'fill'` / `'type'`
- `select` → `'select'`
- `goto` → `'navigate'`
- `evaluate` → `'evaluate'`  ← **key for your "JS badge" requirement**
- `assertVisible`, `assertExists`, `assertText`, `assertUrl`, `assertValue` → `'assert-pass'` (success) or `'assert-fail'` (failure)
- `submit` → `'submit'`
- `hover` → `'hover'`
- `focus` → `'focus'`
- `scroll` → `'scroll'`
- `press`, `shortcut` → `'evaluate'` (keyboard action, no visible element — show "KB" badge)
- `wait` → no highlight (skip screenshot)
- `snapshot`, `forms`, `text` → no highlight (observation only, skip screenshot)

---

## Recording Mode in BatchExecutor

### New `RecordOptions` type (`src/actions/types.ts`)

```typescript
export interface RecordOptions {
  /** Base directory for screenshots. Defaults to session log directory. */
  outputDir?: string;

  /** Image format. Default: 'webp' */
  format?: 'png' | 'jpeg' | 'webp';

  /** Image quality 0-100 (webp/jpeg only). Default: 40 */
  quality?: number;

  /** Inject visual highlights before capture. Default: true */
  highlights?: boolean;

  /** Also capture BEFORE each action (doubles frame count). Default: false */
  captureBefore?: boolean;

  /** Actions to skip capturing (observation-only actions). Default: ['wait', 'snapshot', 'forms', 'text'] */
  skipActions?: ActionType[];
}
```

### Extended `BatchOptions`

```typescript
export interface BatchOptions {
  timeout?: number;
  onFail?: 'stop' | 'continue';

  /** Enable screenshot recording */
  record?: RecordOptions;
}
```

### Extended `BatchResult`

```typescript
export interface BatchResult {
  success: boolean;
  stoppedAtIndex?: number;
  steps: StepResult[];
  totalDurationMs: number;

  /** Path to recording manifest (when record option provided) */
  recordingManifest?: string;
}
```

### Executor Loop Change (`src/actions/executor.ts`)

```typescript
// Inside execute(), after step result is created:

if (options.record && !skipActions.includes(step.action)) {
  const ts = Date.now();
  const seq = String(i + 1).padStart(4, '0');
  const filename = `${seq}-${ts}-${stepResult.action}.${format}`;
  const filepath = join(screenshotDir, filename);

  // Optional: capture BEFORE state
  if (options.record.captureBefore && !stepResult.success) {
    // before-screenshot would have been captured earlier in the loop (see below)
  }

  // Inject highlight
  if (options.record.highlights !== false) {
    const kind = stepToHighlightKind(stepResult);
    if (kind) {
      await injectActionHighlight(this.page, {
        kind,
        bbox: stepResult.boundingBox,
        point: stepResult.coordinates,
        label: getHighlightLabel(step, stepResult),
      });
    }
  }

  // Capture screenshot
  const base64 = await this.page.screenshot({
    format: options.record.format ?? 'webp',
    quality: options.record.quality ?? 40,
  });

  // Write to disk
  const buffer = Buffer.from(base64, 'base64');
  await fs.promises.writeFile(filepath, buffer);
  stepResult.screenshotPath = filepath;

  // Remove highlight
  if (options.record.highlights !== false) {
    await removeActionHighlight(this.page);
  }

  // Accumulate frame for manifest
  frames.push({
    seq: i + 1,
    timestamp: ts,
    action: stepResult.action,
    selector: stepResult.selectorUsed,
    value: typeof step.value === 'string' ? step.value : undefined,
    coordinates: stepResult.coordinates,
    boundingBox: stepResult.boundingBox,
    success: stepResult.success,
    durationMs: stepResult.durationMs,
    error: stepResult.error,
    screenshot: filename,
  });
}
```

### Highlight Label Helper

```typescript
function getHighlightLabel(step: Step, result: StepResult): string | undefined {
  switch (step.action) {
    case 'fill':
    case 'type':
      return typeof step.value === 'string' ? `"${step.value}"` : undefined;
    case 'select':
      return typeof step.value === 'string' ? step.value : undefined;
    case 'goto':
      return step.url;
    case 'evaluate':
      return 'JS';
    case 'press':
      return step.key;
    case 'shortcut':
      return step.combo;
    case 'assertText':
    case 'assertUrl':
    case 'assertValue':
      return result.success ? '✓' : '✗';
    default:
      return undefined;
  }
}
```

---

## Recording Manifest (`recording.json`)

### Schema

```typescript
export interface RecordingManifest {
  /** Schema version for forward compatibility */
  version: 1;

  /** ISO timestamp when recording started */
  recordedAt: string;

  /** Session ID this recording belongs to */
  sessionId: string;

  /** Starting URL */
  startUrl: string;

  /** Ending URL */
  endUrl: string;

  /** Viewport dimensions (consistent across all frames) */
  viewport: { width: number; height: number };

  /** Screenshot format used */
  format: 'png' | 'jpeg' | 'webp';

  /** Quality setting used */
  quality: number;

  /** Total execution time (ms) */
  totalDurationMs: number;

  /** Whether all steps succeeded */
  success: boolean;

  /** Ordered list of captured frames */
  frames: RecordingFrame[];
}

export interface RecordingFrame {
  /** Sequential frame number (1-based, matches filename prefix) */
  seq: number;

  /** Absolute timestamp in ms since epoch */
  timestamp: number;

  /** Time delta from previous frame (ms) — 0 for first frame */
  deltaMs: number;

  /** Action type */
  action: ActionType;

  /** Which selector was used */
  selector?: string;

  /** Value entered/selected (redacted for password fields) */
  value?: string;

  /** URL (for goto actions) */
  url?: string;

  /** Viewport coordinates of action point */
  coordinates?: { x: number; y: number };

  /** Element bounding box */
  boundingBox?: { x: number; y: number; width: number; height: number };

  /** Whether the step succeeded */
  success: boolean;

  /** Step duration (ms) */
  durationMs: number;

  /** Error message if failed */
  error?: string;

  /** Screenshot filename (relative to manifest location) */
  screenshot: string;

  /** Page URL at time of capture */
  pageUrl?: string;

  /** Page title at time of capture */
  pageTitle?: string;
}
```

### `deltaMs` — The Time Gap

Each frame includes `deltaMs`: milliseconds since previous frame. This is the key field for downstream video assembly:

- Video tool reads manifest
- For each frame: hold the screenshot for `max(deltaMs * speedFactor, minFrameMs)`
- Example at 4x speed with 250ms minimum:
  - `deltaMs: 350` → 250ms (min floor)
  - `deltaMs: 1200` → 300ms (1200/4)
  - `deltaMs: 5000` → 1250ms (5000/4) — long wait, hold frame longer
  - `deltaMs: 30000` → could add a "waiting..." overlay or skip

### Manifest Writing

After batch execution completes, if recording was enabled:

```typescript
const manifest: RecordingManifest = {
  version: 1,
  recordedAt: new Date(startTime).toISOString(),
  sessionId,
  startUrl,
  endUrl: await this.page.url(),
  viewport: currentViewport,
  format: options.record.format ?? 'webp',
  quality: options.record.quality ?? 40,
  totalDurationMs: Date.now() - startTime,
  success: allSuccess,
  frames: frames.map((f, i) => ({
    ...f,
    deltaMs: i === 0 ? 0 : f.timestamp - frames[i - 1]!.timestamp,
    pageUrl: /* captured per-frame */,
    pageTitle: /* captured per-frame */,
  })),
};

await fs.promises.writeFile(
  join(screenshotDir, '..', 'recording.json'),
  JSON.stringify(manifest, null, 2)
);
```

---

## Storage Management & Cleanup

### Size Expectations

At WebP quality 40:
- Typical frame: 20-60 KB
- 50-step workflow: ~1-3 MB total
- 200-step workflow: ~4-12 MB total

Very manageable. No aggressive cleanup needed for individual sessions.

### Cleanup Integration

**Existing cleanup** (`bp clean --max-age <hours>`) already calls `deleteSessionFull()` which recursively removes the session directory. Screenshots inside `{sessionId}/screenshots/` get cleaned up automatically — no new cleanup code needed.

**New: size-aware cleanup option**:
```bash
bp clean --max-size 100MB    # Remove oldest sessions until total < 100MB
```

**Programmatic cleanup**:
```typescript
// Already works — deleteSessionFull removes the entire session dir
import { deleteSessionFull } from './session.ts';
await deleteSessionFull(sessionId);  // Removes log.jsonl + screenshots/ + recording.json
```

### `.gitignore` Consideration

When using `--export-log` to write into a project directory, the export path should include a note or the CLI should warn:
```
# Add to .gitignore:
.browser-pilot/
```

---

## CLI Integration

### `bp exec` Changes (`src/cli/commands/exec.ts`)

New flags:
```
--record                    Enable screenshot recording (uses session log dir)
--record-dir <path>         Override screenshot output directory
--record-format <fmt>       Screenshot format: webp (default), png, jpeg
--record-quality <n>        Quality 0-100 (default: 40)
--no-highlights             Disable visual highlights on screenshots
--record-before             Also capture state before each action
```

### `bp run` Changes (workflow runner, if it exists)

Same flags as `bp exec`.

### `bp clean` Changes

```
--max-size <size>           Remove oldest sessions until total size < limit (e.g. "100MB", "1GB")
```

### New: `bp recording` command (optional, nice-to-have)

```bash
bp recording list                     # List sessions with recordings
bp recording show <sessionId>         # Print manifest summary
bp recording export <sessionId> <dir> # Copy screenshots + manifest to target dir
bp recording delete <sessionId>       # Delete just the recording (keep logs)
```

---

## Integration with Session Logger

### Log Entry Enhancement

Add optional `screenshotFile` field to `LogEntry`:

```typescript
export interface LogEntry {
  // ...existing fields
  /** Screenshot filename captured for this action (when recording enabled) */
  screenshotFile?: string;
}
```

In `exec.ts`, when recording:
```typescript
logger.logCommand(
  stepResult.action,
  { selector: stepResult.selectorUsed },
  { success: stepResult.success, error: stepResult.error, hints: stepResult.hints },
  stepResult.durationMs,
  // NEW: optional screenshot reference
  stepResult.screenshotPath ? path.basename(stepResult.screenshotPath) : undefined,
);
```

This lets you reconstruct the recording from just the JSONL log — each log entry optionally references its screenshot file.

---

## End-to-End Flow

### 1. Agent starts a session
```bash
bp connect --export-log ./my-project/.browser-pilot/log.jsonl
# Session created: abc123-x7k9z2
# Logs: ~/.browser-pilot/sessions/abc123-x7k9z2/log.jsonl
# Export: ./my-project/.browser-pilot/log.jsonl
```

### 2. Agent executes actions with recording
```bash
bp exec --record '[
  {"action":"goto","url":"https://app.example.com/login"},
  {"action":"fill","selector":"#email","value":"test@example.com"},
  {"action":"fill","selector":"#password","value":"secret123"},
  {"action":"click","selector":"button[type=submit]"},
  {"action":"assertText","expect":"Dashboard"}
]'
```

### 3. What happens internally
```
Step 1: goto → navigate to URL → wait for load
  → screenshot: 0001-1741500000000-goto.webp (URL badge "https://app.example.com/login")
Step 2: fill #email → blue outline on email field, badge shows "test@example.com"
  → screenshot: 0002-1741500001200-fill.webp
Step 3: fill #password → blue outline on password field, badge shows "[REDACTED]"
  → screenshot: 0003-1741500001550-fill.webp
Step 4: click submit → red crosshair on button + outline
  → screenshot: 0004-1741500001800-click.webp
Step 5: assertText "Dashboard" → green checkmark badge
  → screenshot: 0005-1741500003200-assertVisible.webp
```

### 4. Result on disk
```
~/.browser-pilot/sessions/abc123-x7k9z2/
├── log.jsonl
├── recording.json
└── screenshots/
    ├── 0001-1741500000000-goto.webp        (32 KB)
    ├── 0002-1741500001200-fill.webp        (28 KB)
    ├── 0003-1741500001550-fill.webp        (29 KB)
    ├── 0004-1741500001800-click.webp       (31 KB)
    └── 0005-1741500003200-assertVisible.webp (27 KB)

./my-project/.browser-pilot/              (export mirror)
├── log.jsonl
├── recording.json
└── screenshots/
    └── (same files)
```

### 5. Downstream video assembly (external tool)
```bash
# Read recording.json, assemble frames using deltaMs for timing
ffmpeg-from-manifest ./my-project/.browser-pilot/recording.json \
  --speed 4x --min-frame-ms 250 --output demo.mp4
```

---

## Password/Sensitive Data Redaction

The recording script (`src/recording/script.ts`) already redacts password fields as `[REDACTED]`. Apply the same logic:

- In `getHighlightLabel()`: if step targets an `input[type=password]`, show `[REDACTED]` instead of value
- In manifest `RecordingFrame.value`: redact password values
- Detection: check element attributes via `DOM.getAttributes` for `type="password"`, or check if the value was already redacted by the recorder

---

## Implementation Phases

| Phase | What | Files | Effort |
|---|---|---|---|
| **1** | `getElementPosition()` helper + `setLastActionPosition()` in Page + populate in `click()` only | `page.ts` | 0.5 day |
| **2** | Wire coordinates into StepResult + executor | `types.ts`, `executor.ts` | 0.5 day |
| **3** | Populate position in all other action methods (`fill`, `hover`, `select`, etc.) | `page.ts` | 0.5 day |
| **4** | Action highlight module with all HighlightKinds | New `action-highlight.ts` | 1-2 days |
| **5** | Recording mode in executor (screenshot capture + file writing) | `executor.ts` | 1-2 days |
| **6** | Manifest generation + `RecordingManifest` type | `types.ts`, `executor.ts` or new `recording/manifest.ts` | 0.5 day |
| **7** | Session logger integration (screenshotFile in LogEntry) | `session-logger.ts`, `exec.ts` | 0.5 day |
| **8** | Export path mirroring (dual-write screenshots like dual-write logs) | `executor.ts` or new recording helper | 0.5 day |
| **9** | CLI flags (`--record`, `--record-dir`, etc.) | `exec.ts`, optionally `run.ts` | 0.5 day |
| **10** | Cleanup enhancement (`--max-size`) | `clean.ts` | 0.5 day |

**Total: ~6-8 days**

Phases 1-3 are independently useful (richer metadata). Phase 4-6 is the core feature. Phases 7-10 are integration polish.

---

## Key Design Decisions (Resolved)

| Decision | Resolution | Rationale |
|---|---|---|
| Default format | WebP quality 40 | ~20-60KB per frame, enough for outlines/text, smallest files |
| Screenshot location | Session dir (`~/.browser-pilot/sessions/{id}/screenshots/`) | Pairs with logs, auto-cleaned by existing `bp clean` |
| Export location | Alongside export log path when configured | Project-local for convenience |
| Highlight lifecycle | Inject → screenshot → remove | Highlights don't interfere with subsequent element finding |
| Failed actions | Always capture screenshot | Most valuable frames for debugging |
| Observation actions | Skip `wait`, `snapshot`, `forms`, `text` | No visual change to capture |
| evaluate/press/shortcut | Capture with badge ("JS" / key name) | Signals agent did something even without visible element |
| Time representation | Millisecond timestamps in filenames + `deltaMs` in manifest | Enables downstream video assembly with speed control |
| Password redaction | `[REDACTED]` in labels and manifest values | Security — don't leak credentials into screenshots/manifests |
| Navigation timing | Screenshot after existing navigation wait completes | Existing wait infrastructure handles load state |
| Viewport consistency | Use current viewport (defaults to 1280x720 per existing validation) | All frames same dimensions for video assembly |
