# Action Recording: Visual Screenshot Trail

Exploration of what browser-pilot needs to support screenshot-based "video" recording of agent actions.

## What Already Exists

### Rich Action Metadata (ready to use)
- **StepResult** (`src/actions/types.ts:139-181`): Every batch action already captures `action`, `selector`, `selectorUsed`, `success`, `durationMs`, `error`, `failureReason`, `suggestion`
- **RichRecordedEvent** (`src/recording/types.ts:189-206`): Full event context including `ElementPosition` (bounding box + click point), `PageState` (url, title, timestamp), `StateChange` (navigation, dialog open/close, value changes), and `annotation` (human-readable description)
- **RawRecordedEvent** (`src/recording/types.ts:254-273`): Captures click coordinates (`client: { x, y }`), element metadata, selectors, timestamps
- **Timeline** (`src/recording/types.ts:336-341`): Unified timeline entries (action, network-request, network-response, ws-frame, ws-event) with timestamps

### Screenshot Support (ready to use)
- `page.screenshot()` already wraps `Page.captureScreenshot` CDP command (`src/browser/page.ts:1445-1452`)
- Supports `png | jpeg | webp`, quality control, viewport vs full-page capture
- Returns base64-encoded data — can be saved to disk trivially
- Already a batch action: `{ action: 'screenshot' }` works in step sequences

### Visual Overlay System (ready to use)
- `src/browser/overlay.ts`: Injects red dashed outlines + ref labels on elements via DOM manipulation
- Uses `data-bp-ref` attributes, absolutely-positioned labels, z-index 10000
- Idempotent injection via `Runtime.evaluate` + `Runtime.callFunctionOn`
- Already resolves elements by `backendNodeId` (more reliable than selectors)

### Click Coordinates (computed but not persisted)
- `click()` computes exact `clickX, clickY` via `DOM.getContentQuads` or `DOM.getBoxModel` (`src/browser/page.ts:411-430`)
- These coordinates are used for hit-target verification but **discarded after the click**
- Same pattern in `hover()` and other positional actions

---

## What Needs to Change

### Layer 1: Persist Action Coordinates in StepResult

**Effort: Small** — The coordinates are already computed, just not stored.

Add to `StepResult`:
```typescript
/** Coordinates where the action occurred (viewport-relative) */
coordinates?: { x: number; y: number };

/** Element bounding box at time of action */
boundingBox?: { x: number; y: number; width: number; height: number };
```

Changes needed:
- `src/actions/types.ts`: Add fields to `StepResult`
- `src/browser/page.ts`: Return coordinates from `click()`, `hover()`, `fill()` etc. Currently these methods return `boolean`; they'd need to return a richer result, or the Page class stores the last-action coordinates (similar to `_lastMatchedSelector` pattern at line 155)
- `src/actions/executor.ts`: Pipe coordinates into `StepResult`

**Approach**: Follow the existing `_lastMatchedSelector` pattern — add `_lastActionCoordinates` and `_lastActionBoundingBox` to Page, set them in each action method, read them in the executor.

### Layer 2: Action-Aware Visual Highlighting

**Effort: Small-Medium** — Extends the existing overlay system.

Create highlight overlays that are action-specific rather than ref-specific:

| Action | Visual Indicator |
|--------|-----------------|
| click | Crosshair/pulse at click point + element outline |
| fill/type | Element outline + text badge showing entered value |
| select | Element outline + selected option badge |
| hover | Element outline (lighter style) |
| scroll | Arrow indicator showing scroll direction |
| goto/navigation | URL badge at top of viewport |
| submit | Form outline highlight |
| assert* | Green checkmark overlay on success, red X on failure |

Implementation: New module `src/browser/action-highlight.ts` that:
1. Takes an action type + coordinates + bounding box
2. Injects a temporary DOM overlay (similar to `overlay.ts` but action-styled)
3. Returns a cleanup function (or auto-removes after screenshot)

The overlay should be injected **after** the action completes but **before** the screenshot is taken, so the screenshot captures the result state with visual annotation.

### Layer 3: Automatic Screenshot Capture per Action

**Effort: Medium** — This is the core new capability.

Two integration points:

#### Option A: Batch Executor Hook (recommended)
Add a recording mode to `BatchExecutor.execute()`:

```typescript
interface BatchOptions {
  // ... existing fields
  /** Capture screenshots with action highlights after each step */
  record?: {
    /** Directory to write screenshots */
    outputDir: string;
    /** Image format */
    format?: 'png' | 'jpeg' | 'webp';
    /** Quality (jpeg/webp only) */
    quality?: number;
    /** Whether to add visual highlights before capture */
    highlights?: boolean;
    /** Capture before + after each action (doubles screenshots) */
    beforeAfter?: boolean;
  };
}
```

In the executor loop (`src/actions/executor.ts:104-183`), after each step:
1. If `record` is set and step succeeded (or failed interestingly):
   - Inject action-highlight overlay (coordinates + action type)
   - Call `page.screenshot()`
   - Save to `outputDir/step-{index:03d}-{action}.png`
   - Remove overlay
   - Attach screenshot path to `StepResult`

2. Add `screenshotPath?: string` to `StepResult` for downstream consumers

#### Option B: Page-Level Event Emitter
Add an event system to Page so any consumer can listen:

```typescript
page.on('action', (event: ActionEvent) => { ... });
```

This is more flexible but more architectural change. Option A is simpler and covers the primary use case.

**Recommendation**: Start with Option A (batch executor hook). It's self-contained, doesn't change the Page API surface, and the batch executor already has the perfect loop structure for injecting recording logic.

### Layer 4: Screenshot Metadata Manifest

**Effort: Small** — JSON sidecar file for the screenshot sequence.

After batch execution with recording enabled, write a manifest:

```json
{
  "recordedAt": "2026-03-09T12:00:00Z",
  "startUrl": "https://example.com",
  "viewport": { "width": 1280, "height": 720 },
  "totalDurationMs": 4500,
  "frames": [
    {
      "index": 0,
      "timestamp": 1741500000000,
      "action": "goto",
      "url": "https://example.com",
      "durationMs": 1200,
      "screenshot": "step-000-goto.png",
      "success": true
    },
    {
      "index": 1,
      "timestamp": 1741500001200,
      "action": "click",
      "selector": "#login-btn",
      "coordinates": { "x": 640, "y": 400 },
      "boundingBox": { "x": 600, "y": 385, "width": 80, "height": 30 },
      "durationMs": 350,
      "screenshot": "step-001-click.png",
      "success": true
    },
    {
      "index": 2,
      "timestamp": 1741500001550,
      "action": "fill",
      "selector": "#email",
      "value": "test@example.com",
      "coordinates": { "x": 500, "y": 300 },
      "durationMs": 200,
      "screenshot": "step-002-fill.png",
      "success": true
    }
  ]
}
```

This manifest is what downstream video-assembly tools consume. Each frame has enough context to:
- Add captions/annotations in post-processing
- Control frame duration (hold longer on interesting actions)
- Skip or compress uninteresting frames
- Add transitions between navigations

### Layer 5: CLI Integration

**Effort: Small** — Expose recording via CLI flags.

```bash
# Record a batch execution
bp exec --record ./recordings/session-001

# Record with options
bp exec --record ./recordings/session-001 --record-format jpeg --record-quality 80

# Record a workflow file
bp run workflow.json --record ./recordings/
```

This adds `--record <dir>` flag to `bp exec` and `bp run` commands.

---

## Use Cases Enabled

### 1. QA Agent Audit Trail
An AI agent running QA tests produces a screenshot trail showing exactly what it did and what it saw. Each screenshot has the interacted element highlighted. The manifest links screenshots to assertions (pass/fail).

### 2. Bug Report Generation
When a test fails, the recording shows the sequence of actions leading to the failure. The last screenshot shows the error state with the failing element highlighted.

### 3. Demo/Training Video Assembly
Screenshots with action highlights + manifest timestamps → ffmpeg/similar tool assembles a video with appropriate frame durations. Navigations get longer holds, rapid fills get compressed.

### 4. Agent Action Verification
For compliance or debugging, review what an agent actually did: which elements it interacted with, what values it entered, what pages it visited. The visual trail is more trustworthy than logs alone.

### 5. Regression Comparison
Compare screenshot sequences across runs. Same workflow, same steps — visual diff to catch UI regressions that don't break selectors but change appearance.

---

## Implementation Order

| Phase | What | Files Changed | Effort |
|-------|------|--------------|--------|
| 1 | Persist coordinates in StepResult | `types.ts`, `page.ts`, `executor.ts` | 1-2 days |
| 2 | Action-highlight overlays | New `action-highlight.ts`, extends `overlay.ts` patterns | 1-2 days |
| 3 | Batch executor recording mode | `executor.ts`, `types.ts` | 2-3 days |
| 4 | Manifest generation | `executor.ts` or new `recording/manifest.ts` | 0.5 days |
| 5 | CLI flags | `cli/commands/exec.ts`, `cli/commands/run.ts` | 0.5 days |

**Total: ~5-8 days of focused work.**

Phases 1-2 are independently useful (richer action metadata even without recording). Phase 3 is the core feature. Phases 4-5 are integration polish.

---

## Key Design Decisions to Make

1. **Before vs After screenshots**: Capturing before each action doubles storage but shows what the agent "saw" before acting. Recommended: after-only by default, before+after as opt-in.

2. **Screenshot format**: PNG is lossless but large (~500KB-2MB per frame). JPEG at quality 80 is ~50-150KB. For video assembly, JPEG is fine. Default to JPEG 80.

3. **Highlight persistence**: Should highlights be injected into the DOM (and visible to subsequent actions) or only present for the screenshot capture? Recommended: inject → screenshot → remove, so highlights don't interfere with subsequent element finding.

4. **Failed action screenshots**: Should we capture screenshots on failures? Yes — they're often the most valuable frames. Show the element that was targeted (if it exists but failed actionability) or the page state (if element is missing).

5. **Navigation screenshots**: After `goto`, the page might still be loading when we screenshot. We should wait for `networkIdle` or at least `load` before capturing. The existing wait infrastructure handles this.

6. **Viewport consistency**: For video assembly, all screenshots should have consistent dimensions. The viewport validation in `browser.ts` already defaults to 1280x720 — recording mode should enforce this.
