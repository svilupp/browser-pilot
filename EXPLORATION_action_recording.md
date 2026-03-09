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
- **`timestampMs`**: Absolute Unix milliseconds. Robust — deltas between frames are always derivable from timestamps (`frames[i].timestamp - frames[i-1].timestamp`). Timestamps in filenames mean you can reconstruct temporal ordering from the filesystem alone, without needing the manifest.
- **`action`**: Human-readable action name for quick browsing (`click`, `fill`, `goto`, `evaluate`, etc.)
- **`.webp`**: Default format. Quality 40 produces ~20-60KB frames — enough to see outlines and text, not pixel-perfect.

Why timestamps over deltas in filenames:
1. **Composable**: Multiple sessions' screenshots can be merged/compared using absolute timestamps
2. **Robust**: No accumulation errors — each filename is independently meaningful
3. **Derivable**: `deltaMs = timestamp[i] - timestamp[i-1]` — trivial to compute downstream
4. **Sortable**: Timestamps sort correctly alongside seq numbers
5. **Debuggable**: Can correlate a screenshot to wall-clock time without reading the manifest

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
export function stepToHighlightKind(step: StepResult): HighlightKind | null;
```

The mapping function handles:
- `click` → `'click'`
- `fill`, `type` → `'fill'` / `'type'`
- `select` → `'select'`
- `goto` → `'navigate'`
- `evaluate` → `'evaluate'`  ← **key for the "JS badge" requirement**
- `assertVisible`, `assertExists`, `assertText`, `assertUrl`, `assertValue` → `'assert-pass'` (success) or `'assert-fail'` (failure)
- `submit` → `'submit'`
- `hover` → `'hover'`
- `focus` → `'focus'`
- `scroll` → `'scroll'`
- `press`, `shortcut` → `'evaluate'` (keyboard action, no visible element — show "KB" badge)
- `wait` → `null` (skip screenshot)
- `snapshot`, `forms`, `text` → `null` (observation only, skip screenshot)

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

  /** Screenshot filename (relative to manifest directory) */
  screenshot: string;

  /** Page URL at time of capture */
  pageUrl?: string;

  /** Page title at time of capture */
  pageTitle?: string;
}
```

### Timestamps — The Time Signal

All timing is based on **absolute timestamps** (ms since epoch). Deltas are derived, never stored as primary data.

Downstream video assembly:
```
deltaMs = frames[i].timestamp - frames[i-1].timestamp
frameDuration = max(deltaMs * speedFactor, minFrameMs)
```

Example at 4x speed with 250ms minimum:
- Timestamps `1741500001200`, `1741500001550` → delta 350ms → 250ms (min floor)
- Timestamps `1741500001550`, `1741500002750` → delta 1200ms → 300ms (1200/4)
- Timestamps `1741500002750`, `1741500007750` → delta 5000ms → 1250ms (5000/4)

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
  frames,
};

await fs.promises.writeFile(
  join(outputDir, 'recording.json'),
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

## Password/Sensitive Data Redaction

The recording script (`src/recording/script.ts`) already redacts password fields as `[REDACTED]`. Apply the same logic:

- In `getHighlightLabel()`: if step targets an `input[type=password]`, show `[REDACTED]` instead of value
- In manifest `RecordingFrame.value`: redact password values
- Detection: check element attributes via `DOM.getAttributes` for `type="password"`, or check if the value was already redacted by the recorder

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
  → screenshot: 0005-1741500003200-assertText.webp
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
    └── 0005-1741500003200-assertText.webp  (27 KB)

./my-project/.browser-pilot/              (export mirror)
├── log.jsonl
├── recording.json
└── screenshots/
    └── (same files)
```

### 5. Downstream video assembly (external tool)
```bash
# Read recording.json, derive deltas from absolute timestamps, assemble frames
video-from-manifest ./my-project/.browser-pilot/recording.json \
  --speed 4x --min-frame-ms 250 --output demo.mp4
```

---

## Implementation Phases with Testing & Validation

### Phase 1: `getElementPosition()` helper on Page

**Files**: `src/browser/page.ts`

**What**: Extract the quad→bbox logic from `click()` into a shared `getElementPosition()` method. Wire it into `click()` first (replace inline quad computation), storing results via `setLastActionPosition()`.

**Testing & Validation**:

Unit tests (`tests/unit/element-position.test.ts`):
- **Quad-based position**: Mock `DOM.getContentQuads` returning `[[100,100, 200,100, 200,200, 100,200]]` → verify center `{x:150, y:150}`, bbox `{x:100, y:100, width:100, height:100}`
- **Non-rectangular quads** (CSS transforms): Mock quads `[[50,100, 250,80, 230,220, 70,200]]` → verify center is average of corners, bbox encloses all points
- **Quads fallback to box model**: Mock `DOM.getContentQuads` throwing → verify fallback to `DOM.getBoxModel` with `content:[100,100], width:100, height:100` → same result
- **Both fail → null**: Mock both CDP calls failing → verify returns `null`, no throw
- **Empty quads array**: Mock `{ quads: [] }` → verify fallback to box model
- **Click still works**: Existing click tests pass unchanged (regression)
- **Position persists on Page**: After `click()`, `getLastActionCoordinates()` returns non-null; after `goto()` (no element), returns `null`

Potential failures to guard against:
- **Detached elements**: Element removed between `findElement()` and `getElementPosition()` — must not throw, return null
- **Zero-size elements**: Hidden elements with 0x0 quads — bbox should still be valid (0 width/height), coordinates should be the point
- **Iframe coordinates**: Elements in iframes report frame-local coordinates — document this limitation, don't try to convert to page coordinates (matches existing click behavior)

### Phase 2: Wire coordinates into StepResult + executor

**Files**: `src/actions/types.ts`, `src/actions/executor.ts`

**What**: Add `timestamp`, `coordinates`, `boundingBox`, `screenshotPath` fields to `StepResult`. Executor reads position from Page after each step.

**Testing & Validation**:

Unit tests (extend `tests/unit/batch-executor.test.ts`):
- **Coordinates populated on click**: Execute `{ action: 'click', selector: '#btn' }` → verify `StepResult.coordinates` is `{x: number, y: number}`, not undefined
- **Coordinates null for goto**: Execute `{ action: 'goto', url: '...' }` → verify `StepResult.coordinates` is undefined
- **Coordinates null for evaluate**: Execute `{ action: 'evaluate', value: '1+1' }` → verify coordinates undefined
- **Timestamp present and monotonic**: Execute 3 steps → verify all have `timestamp`, and `steps[0].timestamp <= steps[1].timestamp <= steps[2].timestamp`
- **Timestamp is absolute**: Verify `StepResult.timestamp` is within reasonable range of `Date.now()` (not relative to batch start)
- **BoundingBox dimensions positive**: For any step with bbox, verify `width > 0` and `height > 0`
- **Coordinates within bbox**: When both present, verify `bbox.x <= coords.x <= bbox.x + bbox.width` and same for y
- **Failed step still gets timestamp**: Execute a failing step → verify timestamp is set even on failure
- **Optional step that returns false**: Step with `optional: true` on missing element → coordinates should be undefined (not an error)
- **Backward compatibility**: Existing batch executor tests pass without modification (new fields are optional)

Potential failures to guard against:
- **Mock page doesn't implement getLastActionCoordinates()**: Update `createMockPage()` in test harness to include the new methods, returning configurable values
- **Position reset between steps**: Ensure `_lastActionCoordinates` is reset to null at start of each executor step, so a previous step's coordinates don't leak into a step that has no element (like `evaluate`)

### Phase 3: Populate position in all action methods

**Files**: `src/browser/page.ts`

**What**: Add `getElementPosition()` + `setLastActionPosition()` calls to `fill()`, `type()`, `select()`, `check()`, `uncheck()`, `submit()`, `focus()`, `hover()`, `scroll()`.

**Testing & Validation**:

Unit tests (extend `tests/unit/element-position.test.ts`):
- **Each action populates coordinates**: For every element-targeting action, mock CDP → execute → verify `getLastActionCoordinates()` is non-null
- **Table-driven test**: Single parameterized test covering all 10 action methods: `[{action:'fill', setup: ...}, {action:'hover', setup: ...}, ...]` → all produce coordinates

Integration tests (extend existing or new `tests/integration/element-position.test.ts`):
- **Real browser coordinates match visible position**: Click a button at known position → verify coordinates are within the button's actual viewport bounds (use a test page with fixed-position elements)
- **Coordinates after scroll**: Element below fold → scroll into view → click → coordinates should reflect post-scroll viewport position (not page-absolute)
- **fill() on text input**: Fill an input → verify bbox roughly matches the input's position on the test page

Potential failures to guard against:
- **Performance regression**: `getElementPosition()` adds 1 extra CDP call per action (or zero if reusing existing quad data from click). Measure — should be <5ms overhead. If concerning, only call `getElementPosition()` when recording is enabled (but this couples Page to recording concern — prefer always capturing)
- **select() with custom dropdowns**: The `select()` method has two code paths (native `<select>` and custom trigger/option). Both paths need position tracking. Test both.
- **submit() multiple code paths**: `submit()` tries Enter key, then click on submit button. Position should reflect the submit button, not some intermediate state. Verify the last position set is the meaningful one.

### Phase 4: Action highlight module

**Files**: New `src/browser/action-highlight.ts`

**What**: JS injection that creates visual overlays (outlines, crosshairs, badges) per action type. Inject → screenshot → remove lifecycle.

**Testing & Validation**:

Unit tests (`tests/unit/action-highlight.test.ts`):
- **stepToHighlightKind mapping**: Every ActionType maps to expected HighlightKind or null. Table-driven:
  ```
  click → 'click', fill → 'fill', goto → 'navigate', evaluate → 'evaluate',
  wait → null, snapshot → null, forms → null, text → null
  ```
- **Assert success vs failure**: `assertText` with `success:true` → `'assert-pass'`, with `success:false` → `'assert-fail'`
- **getHighlightLabel**: `fill` with value `"hello"` → `'"hello"'`, `evaluate` → `'JS'`, `press` with key `'Enter'` → `'Enter'`, `click` → `undefined`

Integration tests (`tests/integration/action-highlight.test.ts`):
- **Highlight injects and is visible**: Inject click highlight at `{x:200, y:200}` on test page → take screenshot → verify highlight container exists (`document.getElementById('__bp-action-highlight')` is not null)
- **Highlight removes cleanly**: Inject → remove → verify container is gone, no leftover DOM nodes with `__bp-action-highlight`
- **Highlight doesn't interfere with element finding**: Inject highlight → `page.click('#some-button')` → should succeed (highlight has `pointer-events:none`)
- **Highlight idempotent**: Inject twice → should not create two containers, just replace
- **Highlight with no bbox (evaluate)**: Inject `evaluate` kind with no bbox → verify "JS" badge appears in top-right corner
- **Highlight with bbox + label**: Inject `fill` kind with bbox and label `"test@example.com"` → verify badge text matches
- **Highlight z-index**: Highlight should be above all page content (z-index 99999). Test with a page that has z-index:9999 elements — highlight should still be visible in screenshot

Potential failures to guard against:
- **CSP (Content Security Policy)**: Pages with strict CSP may block inline style injection. The overlay uses inline styles via `element.style.cssText` — this works even with CSP that blocks `<style>` tags. But verify with a CSP-restricted test page.
- **Page navigates between inject and remove**: If `goto` triggers a navigation after highlight inject, the highlight is gone (new document). The remove call should be a no-op, not throw. Guard with try/catch.
- **Shadow DOM**: Highlights are injected into the main document, not shadow roots. This is fine — the highlight container is a sibling of page content, not inside any component.
- **Very long labels**: URL badges for `goto` could be 200+ chars. Truncate labels to ~80 chars with `...` suffix.

### Phase 5: Recording mode in executor

**Files**: `src/actions/executor.ts`, `src/actions/types.ts`

**What**: When `options.record` is set, after each step: inject highlight → screenshot → write file → remove highlight. Accumulate frames for manifest.

**Testing & Validation**:

Unit tests (extend `tests/unit/batch-executor.test.ts`):
- **Recording creates screenshots dir**: Execute batch with `record: { outputDir: tmpDir }` → verify `screenshots/` subdirectory created
- **Screenshot files written**: Execute 3 steps → verify 3 `.webp` files exist in screenshots dir
- **Filename format**: Verify each file matches pattern `/^\d{4}-\d{13,}-\w+\.webp$/`
- **Timestamps in filenames are monotonically increasing**: Parse timestamps from filenames → verify `ts[0] <= ts[1] <= ts[2]`
- **Skipped actions produce no screenshot**: Execute `{ action: 'wait', timeout: 100 }` → verify no screenshot file for that step
- **Failed step still gets screenshot**: Execute a batch where step 2 fails → verify screenshot exists for the failed step
- **StepResult.screenshotPath set**: Verify each non-skipped step has `screenshotPath` pointing to an existing file
- **StepResult.screenshotPath undefined for skipped actions**: `wait` step → `screenshotPath` is undefined
- **Recording disabled by default**: Execute batch without `record` option → verify no screenshots dir, no screenshotPath on any StepResult
- **Screenshot is valid image**: Read the file bytes, verify WebP magic bytes (`RIFF....WEBP`) at start
- **Custom format/quality**: `record: { format: 'jpeg', quality: 60 }` → files end in `.jpeg`, are valid JPEG (magic bytes `\xFF\xD8`)
- **highlights: false**: Execute with `record: { highlights: false }` → verify `injectActionHighlight` was NOT called (mock it)
- **Batch with onFail:'stop'**: Step 2 fails → recording stops at step 2 → only 2 screenshot files, not more
- **Batch with onFail:'continue'**: Step 2 fails → recording continues → all steps get screenshots

Integration tests (`tests/integration/recording.test.ts`):
- **Full recording round-trip**: Connect to test page → execute `goto`, `fill`, `click` with recording → verify screenshot files are non-empty WebP images that can be decoded
- **Screenshot captures highlight**: Execute click with recording → read screenshot → inject into page as `<img>` → the red crosshair overlay should be visible (or at minimum, the file size should be larger than a plain screenshot of the same page, indicating overlay is present)
- **Screenshot captures page state AFTER action**: Execute `fill` with recording → screenshot should show the filled value in the input field
- **Highlight removed after screenshot**: After recording completes, verify no highlight container exists in the DOM

Potential failures to guard against:
- **Disk write failures**: `outputDir` doesn't exist or not writable → `fs.promises.mkdir` with `recursive: true` at start, and catch write errors per-screenshot (log warning, don't abort the batch)
- **Screenshot fails (CDP error)**: Browser tab closed or navigated during screenshot → catch error, log it, skip that frame, continue recording
- **Performance**: Each screenshot adds ~50-200ms (CDP capture + file write). A 100-step batch could add 5-20 seconds. This is acceptable for recording mode. Document this overhead.
- **Memory**: Base64 screenshots are ~30-80KB strings. Ephemeral per-step — no memory accumulation concern.
- **Concurrent recordings**: Two `bp exec --record` calls with same session → screenshots dir is shared, seq numbers could collide. Guard: include a batch-run identifier in filename, or use a subdirectory per batch invocation (`screenshots/{batchId}/`)
- **Very large pages**: Full-page screenshots of long pages could produce multi-MB images. Default to viewport-only screenshots (not `fullPage`), which are bounded by viewport dimensions.

### Phase 6: Manifest generation

**Files**: `src/actions/types.ts` (types), `src/actions/executor.ts` or new `src/recording/manifest.ts`

**What**: After batch execution, write `recording.json` manifest with all frame metadata.

**Testing & Validation**:

Unit tests (`tests/unit/recording-manifest.test.ts`):
- **Manifest written**: Execute batch with recording → verify `recording.json` exists alongside screenshots dir
- **Manifest is valid JSON**: `JSON.parse(fs.readFileSync('recording.json', 'utf-8'))` does not throw
- **Schema version**: `manifest.version === 1`
- **Frame count matches screenshots**: `manifest.frames.length` equals number of screenshot files on disk
- **Frame seq matches filename prefix**: Each frame's `seq` matches the `0001`, `0002` prefix of its `screenshot` filename
- **Frame timestamps match filename timestamps**: Parse timestamp from filename, compare to `frame.timestamp` — must be equal
- **Timestamps are monotonically increasing**: `frames[i].timestamp <= frames[i+1].timestamp` for all i
- **Derived deltas are correct**: `frames[i].timestamp - frames[i-1].timestamp` produces expected gap (verify with controlled timing)
- **startUrl and endUrl populated**: Both are valid URL strings
- **Viewport dimensions match**: `manifest.viewport` matches the actual viewport used during recording
- **Success field accurate**: If all steps succeeded → `manifest.success === true`; if any failed → `manifest.success === false`
- **screenshot field is relative path**: `frame.screenshot` should be just the filename (e.g., `0001-...-goto.webp`), not an absolute path
- **Empty batch produces empty manifest**: Zero steps → `manifest.frames` is `[]`, manifest still valid
- **pageUrl captured per-frame**: Each frame's `pageUrl` reflects the URL at time of that screenshot (important: URL changes after `goto`)

Potential failures to guard against:
- **Manifest write fails**: Disk full or permissions → catch and warn, don't crash the batch (screenshots are already on disk, manifest can be reconstructed from filenames)
- **URL retrieval fails between steps**: `page.url()` could fail if browser disconnected → catch, use previous known URL
- **Title retrieval**: `page.title()` via CDP → may fail, use empty string as fallback
- **Atomicity**: Write manifest to a temp file first, then rename — prevents partial manifests on crash. (Or just accept that partial manifests are fine since they're reconstructible from screenshots.)

### Phase 7: Session logger integration

**Files**: `src/cli/session-logger.ts`, `src/cli/commands/exec.ts`

**What**: Add `screenshotFile` field to `LogEntry`, populated when recording is enabled. Each JSONL line references its screenshot.

**Testing & Validation**:

Unit tests (extend `tests/unit/session-logging.test.ts` or new file):
- **LogEntry with screenshotFile**: Call `logCommand()` with screenshot filename → verify JSONL line contains `"screenshotFile":"0001-...-click.webp"`
- **LogEntry without screenshotFile**: Call `logCommand()` without screenshot → verify field is absent (not `null`, not empty string)
- **Log-screenshot cross-reference**: Execute batch with recording → parse `log.jsonl` → for each entry with `screenshotFile`, verify the file exists in `screenshots/`
- **Seq alignment**: Log entry `seq` should match the screenshot filename prefix (both are 1-based)

Integration tests:
- **End-to-end log + screenshot pairing**: Run `bp exec --record` → read log.jsonl → verify screenshotFile references resolve to actual files

Potential failures to guard against:
- **logCommand() signature change**: Adding a parameter to `logCommand()` could break existing callers. Use an options object or make it optional with a default. Check all call sites.
- **Export log also gets screenshotFile**: The dual-write to `exportLogPath` should include the `screenshotFile` field. Verify the export log entries match core log entries.

### Phase 8: Export path mirroring

**Files**: `src/actions/executor.ts` or new recording helper

**What**: When session has `exportLogPath`, screenshot files + manifest are also written to the export directory (same dual-write pattern as JSONL logs).

**Testing & Validation**:

Unit tests:
- **Screenshots dual-written**: Execute with recording + export path → verify screenshot files exist in both session dir and export dir
- **Manifest dual-written**: `recording.json` exists in both locations
- **File contents identical**: `Buffer.compare(coreFile, exportFile) === 0` for each screenshot
- **Export dir created if missing**: Export path points to non-existent directory → verify it's created with `recursive: true`
- **Export write failure doesn't abort**: Make export dir read-only → verify core screenshots still written, warning logged

Potential failures to guard against:
- **Double disk usage**: Dual-writing doubles storage. Document this. Consider symlinks as alternative (but they don't work across filesystems). Accept the tradeoff — screenshots are small.
- **Different base paths in manifest**: The `screenshot` field in manifest is a relative path. In both core and export manifests, it should be relative to the manifest location (i.e., `screenshots/0001-...webp`). Verify this works for both locations.
- **Race conditions**: Two concurrent `bp exec` calls with same export path → could interleave screenshots. Same mitigation as Phase 5 (batch-run subdirectory or include batch ID in filenames).

### Phase 9: CLI flags

**Files**: `src/cli/commands/exec.ts`, optionally `src/cli/commands/run.ts`

**What**: Add `--record`, `--record-dir`, `--record-format`, `--record-quality`, `--no-highlights`, `--record-before` flags.

**Testing & Validation**:

Unit tests (`tests/unit/cli-record-flags.test.ts`):
- **Flag parsing**: `--record` alone → `record: {}` with defaults
- **Flag parsing with format**: `--record --record-format jpeg` → `record: { format: 'jpeg' }`
- **Flag parsing with quality**: `--record --record-quality 60` → `record: { quality: 60 }`
- **Flag parsing with dir**: `--record-dir /tmp/rec` → `record: { outputDir: '/tmp/rec' }`
- **--no-highlights**: `--record --no-highlights` → `record: { highlights: false }`
- **Invalid quality**: `--record-quality 150` → error or clamp to 100
- **Invalid format**: `--record-format bmp` → error with valid options listed
- **--record not set**: No `record` option passed to batch executor

Integration tests:
- **CLI end-to-end**: Run `bp exec --record --record-format jpeg --record-quality 50 '[{"action":"goto","url":"..."}]'` → verify JPEG files created at expected quality
- **--record-dir creates custom dir**: Specify `--record-dir /tmp/test-recording` → screenshots appear there, not in session dir

Potential failures to guard against:
- **Flag conflicts**: `--record-dir` without `--record` → should it imply `--record`? Yes — if any record-related flag is set, enable recording.
- **Relative vs absolute paths**: `--record-dir ./recordings` → resolve relative to cwd, not to session dir
- **Help text**: Document all new flags in CLI help. Verify with `bp exec --help` output.

### Phase 10: Cleanup enhancement

**Files**: `src/cli/commands/clean.ts`

**What**: Add `--max-size` flag to remove oldest sessions until total size is under limit.

**Testing & Validation**:

Unit tests (`tests/unit/clean-max-size.test.ts`):
- **Size parsing**: `"100MB"` → 104857600 bytes, `"1GB"` → 1073741824, `"500KB"` → 512000
- **Oldest sessions removed first**: Create 5 sessions with known sizes and timestamps → `--max-size` that requires removing 2 oldest → verify correct 2 removed, 3 remain
- **Already under limit**: Total size < limit → no sessions removed
- **All sessions over limit**: Single session exceeds limit → still kept (don't delete everything, warn instead)
- **Size calculation includes screenshots**: Session with 10 screenshots → verify total size includes screenshots directory

Potential failures to guard against:
- **Size calculation performance**: Recursively computing directory sizes for many sessions could be slow. Use `fs.statSync` per file, not shell `du`. Cache if needed.
- **Race condition with concurrent access**: Session being written while cleanup runs → skip sessions with very recent `lastActivity` (e.g., within last 60 seconds)
- **Symlinks**: Don't follow symlinks when computing size (could lead to counting files outside the session directory)

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
| Time in filenames | Absolute timestamps (ms since epoch) | Robust, composable, deltas always derivable |
| Time in manifest | Absolute timestamps only, no stored deltas | Deltas are derived: `frames[i].ts - frames[i-1].ts` |
| Password redaction | `[REDACTED]` in labels and manifest values | Security — don't leak credentials into screenshots/manifests |
| Navigation timing | Screenshot after existing navigation wait completes | Existing wait infrastructure handles load state |
| Viewport consistency | Use current viewport (defaults to 1280x720 per existing validation) | All frames same dimensions for video assembly |
