# Browser-Pilot Enhancement Research

Research document for implementing debugging and automation features for AI agents.

## Table of Contents

1. [Feature Overview](#feature-overview)
2. [BP Diagnose & Find](#1-bp-diagnose--find)
3. [BP Snapshot Diff](#2-bp-snapshot-diff)
4. [Session Logging](#3-session-logging)
5. [Visual Ref Overlay](#4-visual-ref-overlay-inspect)
6. [Failure Hints](#5-failure-hints)
7. [Shared Utilities](#6-shared-utilities)
8. [Testing Strategy](#7-testing-strategy)
9. [Documentation Updates](#8-documentation-updates)

---

## Feature Overview

| Feature | Priority | Complexity | Dependencies |
|---------|----------|------------|--------------|
| `bp diagnose` | 1 | Medium | Snapshot, fuzzy matching |
| `bp find` | 1 | Low | Integrated with diagnose |
| Failure hints | 2 | Medium | Diagnose utilities |
| `bp snapshot --diff` | 3 | Medium | Snapshot types |
| Session logging | 4 | Medium | Session management |
| `bp snapshot --inspect` | 5 | Medium | CDP injection |

---

## 1. BP Diagnose & Find

### 1.1 Command Interface

```bash
# Exact match - full diagnostics
bp diagnose "ref:e4"
bp diagnose "#submit-button"
bp diagnose "[data-testid='login']"

# Fuzzy match - returns top 5 candidates with lightweight diagnostics
bp diagnose "submit"           # Text-based fuzzy match
bp diagnose "login button"     # Multi-word fuzzy match

# Options
bp diagnose <selector> --json          # JSON output
bp diagnose <selector> --max 10        # Show top 10 instead of 5
bp diagnose <selector> -s <session>    # Use specific session
```

### 1.2 Output Format

**Exact Match (single element found):**
```typescript
interface DiagnoseExactResult {
  matched: true;
  selector: string;
  ref: string;
  element: {
    role: string;
    name: string;
    nodeId: number;
    backendNodeId: number;
  };
  visibility: {
    isVisible: boolean;
    display: string;
    visibility: string;
    opacity: number;
    width: number;
    height: number;
    inViewport: boolean;
  };
  interactivity: {
    disabled: boolean;
    readonly: boolean;
    covered: boolean;
    coveringElement?: {
      ref: string;
      role: string;
      name: string;
      selector: string;
    };
    clickable: boolean;
    reason?: string;  // Why not clickable
  };
  attributes: Record<string, string>;
  suggestedSelectors: string[];  // Alternative selectors for this element
}
```

**Fuzzy Match (no exact match, top candidates):**
```typescript
interface DiagnoseFuzzyResult {
  matched: false;
  query: string;
  candidates: Array<{
    score: number;           // 0-1 confidence
    ref: string;
    selector: string;
    role: string;
    name: string;
    visible: boolean;
    disabled: boolean;
    matchReason: string;     // Why this matched
  }>;
}
```

### 1.3 Key Implementation Files

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| Visibility checks | `src/wait/strategies.ts` | 66-93 | `isElementVisible()` |
| Deep query (shadow DOM) | `src/wait/strategies.ts` | 30-60 | `DEEP_QUERY_SCRIPT` |
| Snapshot generation | `src/browser/page.ts` | 1093-1255 | Accessibility tree extraction |
| Element finding | `src/browser/page.ts` | 1918-2030 | Selector resolution |
| Box model | `src/browser/page.ts` | 2073-2115 | `getBoxModel()` |
| Ref mapping | `src/browser/page.ts` | 69-70, 1118-1129 | Ref storage |
| Types - Snapshot | `src/browser/types.ts` | 106-152 | `SnapshotNode`, `InteractiveElement` |
| Types - Accessibility | `src/cdp/protocol.ts` | 97-141 | `AXNode`, `AXProperty` |
| Types - DOM | `src/cdp/protocol.ts` | 60-88 | `DOMNode` |
| Types - Box Model | `src/cdp/protocol.ts` | 258-266 | `BoxModel` |

### 1.4 CDP Methods Required

```typescript
// Element inspection
'Accessibility.getFullAXTree'      // Get all accessibility properties
'DOM.getBoxModel'                  // Get element dimensions
'DOM.describeNode'                 // Get DOM node properties
'DOM.querySelector'                // Find element by selector
'DOM.requestNode'                  // Get frontend node from RemoteObject
'DOM.pushNodesByBackendIdsToFrontend'  // Resolve backendNodeId

// Visibility & coverage detection (via Runtime.evaluate)
'Runtime.evaluate'                 // Run JS for visibility, overlay checks
```

### 1.5 New Utilities to Build

```typescript
// src/browser/diagnose.ts (NEW FILE)

interface DiagnoseOptions {
  maxCandidates?: number;  // Default: 5
  includeHidden?: boolean; // Include non-visible elements
}

// Main diagnostic collector
async function diagnoseElement(
  page: Page,
  selector: string,
  options?: DiagnoseOptions
): Promise<DiagnoseExactResult | DiagnoseFuzzyResult>;

// Visibility diagnostics (enhanced from strategies.ts)
async function getVisibilityState(
  cdp: CDPClient,
  nodeId: number
): Promise<VisibilityState>;

// Overlay/coverage detection
async function detectCoveringElement(
  cdp: CDPClient,
  nodeId: number
): Promise<CoveringElement | null>;

// Fuzzy matcher
function fuzzyMatchElements(
  query: string,
  elements: InteractiveElement[],
  maxResults: number
): FuzzyMatch[];

// String similarity (Levenshtein or Jaro-Winkler)
function stringSimilarity(a: string, b: string): number;
```

### 1.6 Fuzzy Matching Algorithm

```
Input: query string, InteractiveElement[]
Output: Top N candidates with scores

1. Normalize query: lowercase, split into words
2. For each element:
   a. Score against name (highest weight)
   b. Score against role (medium weight)
   c. Score against selector parts (lower weight)
   d. Combine scores with weights
3. Sort by combined score descending
4. Return top N with match reasons
```

**Scoring weights:**
- Exact name match: 1.0
- Name contains query: 0.8
- Role matches expected for action: 0.3
- Selector contains query word: 0.2
- String distance < 3: 0.5

### 1.7 Overlay Detection Script

```javascript
// Inject via Runtime.evaluate
function isCovered(nodeId) {
  const el = /* resolve nodeId to element */;
  const rect = el.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const topEl = document.elementFromPoint(centerX, centerY);

  if (topEl === el || el.contains(topEl)) {
    return { covered: false };
  }

  return {
    covered: true,
    coveringElement: {
      tagName: topEl.tagName,
      id: topEl.id,
      className: topEl.className,
      // Generate selector for covering element
    }
  };
}
```

---

## 2. BP Snapshot Diff

### 2.1 Command Interface

```bash
# Compare current snapshot to saved file
bp snapshot --diff before.json

# Save current snapshot for later comparison
bp snapshot -o before.json

# Compare two saved snapshots
bp snapshot --diff before.json --compare-to after.json

# Output options
bp snapshot --diff before.json --json      # Machine-readable
bp snapshot --diff before.json --summary   # Summary only
```

### 2.2 Output Format

```typescript
interface SnapshotDiff {
  metadata: {
    before: { url: string; timestamp: string; title: string };
    after: { url: string; timestamp: string; title: string };
    generatedAt: string;
  };

  summary: {
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
  };

  changes: {
    added: SnapshotNode[];      // New elements (with after refs)
    removed: SnapshotNode[];    // Deleted elements (with before refs)
    changed: Array<{
      key: string;              // Stable identifier
      before: SnapshotNode;
      after: SnapshotNode;
      changedFields: string[];  // ['disabled', 'value', 'checked']
    }>;
  };
}
```

**Pretty output format:**
```
Snapshot Diff: https://example.com/form
  Before: 2026-01-31T10:30:00Z (45 elements)
  After:  2026-01-31T10:31:00Z (47 elements)

Changes:
  + [e15] button "Order Confirmed" (new)
  + [e16] link "View Receipt" (new)
  ~ [e7] button "Submit" disabled: false → true
  ~ [e5] textbox "Email" value: "" → "test@example.com"
  - [e3] dialog "Cookie Banner" (removed)

Summary: +2 added, -1 removed, ~2 changed
```

### 2.3 Element Matching Strategy

**Challenge:** Refs are NOT stable across snapshots (reset on each snapshot call).

**Solution:** Hybrid matching using stable identifiers:

```typescript
// Create stable key for matching
function getElementKey(node: SnapshotNode, path: string[]): string {
  // Combine role + name + tree position
  return `${node.role}::${node.name || ''}::${path.join('/')}`;
}

// Matching priority:
// 1. Exact: role + name + tree position
// 2. Fuzzy: role + name (ignore position)
// 3. Fallback: tree position only
```

### 2.4 Key Implementation Files

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| Snapshot types | `src/browser/types.ts` | 107-152 | `PageSnapshot`, `SnapshotNode` |
| Snapshot generation | `src/browser/page.ts` | 1093-1255 | Core snapshot logic |
| Ref assignment | `src/browser/page.ts` | 1115-1129 | Sequential ref generation |
| CLI snapshot | `src/cli/commands/snapshot.ts` | 1-85 | Command implementation |
| Session storage | `src/cli/session.ts` | 30-39, 54-99 | Ref cache persistence |

### 2.5 New Files to Create

```typescript
// src/browser/snapshot-diff.ts (NEW FILE)

interface DiffOptions {
  includeUnchanged?: boolean;
  maxDepth?: number;
}

function diffSnapshots(
  before: PageSnapshot,
  after: PageSnapshot,
  options?: DiffOptions
): SnapshotDiff;

function matchElements(
  beforeTree: SnapshotNode[],
  afterTree: SnapshotNode[]
): ElementMatches;

function formatDiffPretty(diff: SnapshotDiff): string;
function formatDiffJson(diff: SnapshotDiff): string;
```

---

## 3. Session Logging

### 3.1 Requirements

1. **Always-on logging** - Every command automatically logged
2. **Full replay data** - All info needed for future replay
3. **Easy access** - Simple way to find log file path
4. **Structured format** - Machine-readable, grep-friendly

### 3.2 Log Location & Format

```
~/.browser-pilot/sessions/
  {sessionId}/
    session.json          # Session metadata (existing)
    log.jsonl             # Structured event log (NEW - JSON Lines)
```

**JSON Lines format** (one JSON object per line):
```json
{"seq":1,"ts":"2026-01-31T10:30:45.123Z","type":"command","cmd":"goto","args":{"url":"https://example.com"},"status":"success","durationMs":1250,"urlAfter":"https://example.com"}
{"seq":2,"ts":"2026-01-31T10:30:46.400Z","type":"command","cmd":"click","args":{"selector":"#login"},"status":"success","durationMs":150,"selectorUsed":"#login"}
{"seq":3,"ts":"2026-01-31T10:30:46.600Z","type":"command","cmd":"fill","args":{"selector":"#email","value":"test@example.com"},"status":"failed","error":"Element not found","hints":[...]}
```

### 3.3 Log Entry Schema

```typescript
interface LogEntry {
  seq: number;                    // Sequence number
  ts: string;                     // ISO timestamp
  type: 'command' | 'event' | 'error' | 'diagnostic';

  // For commands
  cmd?: ActionType;
  args?: Record<string, unknown>;
  status?: 'pending' | 'success' | 'failed';
  durationMs?: number;
  selectorUsed?: string;
  urlBefore?: string;
  urlAfter?: string;
  error?: string;
  hints?: HintResult[];

  // For events (CDP events if captured)
  event?: string;
  data?: Record<string, unknown>;
}
```

### 3.4 CLI Commands for Log Access

```bash
# Get log file path
bp session --log-path              # Current/default session
bp session --log-path <sessionId>  # Specific session

# View recent log entries
bp session --log-tail              # Last 20 entries
bp session --log-tail 50           # Last 50 entries

# Session info with log stats
bp session --info <sessionId>
```

**Output of `bp session --info`:**
```
Session: abc123
  Provider: browserbase
  Created: 2026-01-31T10:30:00Z
  Last Activity: 2026-01-31T10:45:00Z
  Current URL: https://example.com/dashboard

Logs:
  Path: ~/.browser-pilot/sessions/abc123/log.jsonl
  Entries: 42
  Size: 15.2 KB
  First: 2026-01-31T10:30:00Z
  Last: 2026-01-31T10:45:00Z
```

### 3.5 Key Implementation Files

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| Session storage | `src/cli/session.ts` | 41, 54-99 | Session persistence |
| Session metadata | `src/cli/session.ts` | 11-28 | `SessionData` interface |
| Tracer | `src/trace/tracer.ts` | 8-33, 73 | `TraceEvent`, `emit()` |
| Batch executor | `src/actions/executor.ts` | 20-73 | Step result tracking |
| CLI exec | `src/cli/commands/exec.ts` | 111-172 | Command execution |

### 3.6 Integration Points

**Where to log:**

1. **In `execCommand()`** (`src/cli/commands/exec.ts`):
   - Log command start with parameters
   - Log each step result
   - Log final state

2. **In `connectCommand()`** (`src/cli/commands/connect.ts`):
   - Log connection details
   - Log initial page state

3. **In `Tracer.emit()`** (`src/trace/tracer.ts`):
   - Add file output option alongside console
   - Route to session log file

### 3.7 New Files to Create

```typescript
// src/cli/session-logger.ts (NEW FILE)

class SessionLogger {
  constructor(sessionId: string);

  log(entry: Omit<LogEntry, 'seq' | 'ts'>): void;
  logCommand(cmd: string, args: unknown, result: unknown): void;
  logError(error: Error, context?: unknown): void;

  getLogPath(): string;
  getLogStats(): LogStats;
  tailLog(n: number): LogEntry[];
}

// Integrate with existing session management
function getSessionLogger(sessionId: string): SessionLogger;
```

---

## 4. Visual Ref Overlay (--inspect)

### 4.1 Command Interface

```bash
# Take snapshot and show refs visually on page
bp snapshot --inspect

# Keep overlay visible (doesn't auto-close)
bp snapshot --inspect --keep

# Combine with other options
bp snapshot --inspect --format interactive
```

### 4.2 Behavior

1. Take accessibility snapshot (as usual)
2. Inject overlay script into page
3. Show ref labels (e1, e2, etc.) next to each interactive element
4. Highlight element boundaries with dashed outlines
5. Auto-cleanup after command (unless `--keep`)

### 4.3 Overlay Design

**Visual appearance:**
- Small red labels with white text showing ref (e.g., "e4")
- Positioned at top-left corner of each element
- Dashed red outline around element boundaries
- `pointer-events: none` to not interfere with page
- High z-index (10000) to appear above content

**Safety requirements:**
- Use `data-bp-*` attributes (won't conflict with selectors)
- Inject styles via `<style>` tag with unique selectors
- Guard against double-injection
- Clean up completely on toggle/close

### 4.4 Injection Script Pattern

Based on existing recording script (`src/recording/script.ts`):

```typescript
export const OVERLAY_SCRIPT = `(function() {
  if (window.__bpOverlayInstalled) return;
  window.__bpOverlayInstalled = true;

  // Inject styles
  const style = document.createElement('style');
  style.id = '__bp-overlay-styles';
  style.textContent = \`
    [data-bp-ref] {
      outline: 2px dashed rgba(255, 0, 0, 0.5) !important;
      outline-offset: 2px !important;
    }
    .__bp-ref-label {
      position: absolute;
      background: #e53935;
      color: white;
      padding: 1px 4px;
      font-size: 10px;
      font-family: monospace;
      font-weight: bold;
      z-index: 10000;
      pointer-events: none;
      border-radius: 2px;
      line-height: 1.2;
    }
  \`;
  document.head.appendChild(style);

  // Overlay container
  const container = document.createElement('div');
  container.id = '__bp-overlay-container';
  container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10000;';
  document.body.appendChild(container);

  // Will be called with ref data from CDP
  window.__bpShowOverlay = function(refs) {
    refs.forEach(({ ref, rect }) => {
      const label = document.createElement('div');
      label.className = '__bp-ref-label';
      label.textContent = ref;
      label.style.left = (rect.left + window.scrollX) + 'px';
      label.style.top = (rect.top + window.scrollY) + 'px';
      container.appendChild(label);
    });
  };

  window.__bpClearOverlay = function() {
    container.innerHTML = '';
    document.querySelectorAll('[data-bp-ref]').forEach(el => {
      el.removeAttribute('data-bp-ref');
    });
  };

  window.__bpRemoveOverlay = function() {
    window.__bpClearOverlay();
    container.remove();
    style.remove();
    delete window.__bpOverlayInstalled;
    delete window.__bpShowOverlay;
    delete window.__bpClearOverlay;
    delete window.__bpRemoveOverlay;
  };
})();`;
```

### 4.5 Key Implementation Files

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| Recording script | `src/recording/script.ts` | 1-467 | Reference pattern |
| Recording injection | `src/recording/recorder.ts` | 51-96 | CDP injection sequence |
| Snapshot generation | `src/browser/page.ts` | 1093-1255 | Ref assignment |
| Box model | `src/browser/page.ts` | 2073-2115 | Element positioning |
| CDP client | `src/cdp/client.ts` | 149-246 | `send()` method |

### 4.6 CDP Methods Required

```typescript
// Script injection
'Runtime.evaluate'                      // Inject overlay script
'Page.addScriptToEvaluateOnNewDocument' // Persist across navigations (optional)

// Element positioning
'DOM.getBoxModel'                       // Get element coordinates
'DOM.pushNodesByBackendIdsToFrontend'   // Resolve refs to nodes
```

### 4.7 New Methods to Add

```typescript
// src/browser/page.ts - Add to Page class

async injectRefOverlay(snapshot: PageSnapshot): Promise<void> {
  // 1. Inject overlay script
  await this.cdp.send('Runtime.evaluate', {
    expression: OVERLAY_SCRIPT,
    awaitPromise: false
  });

  // 2. Collect element positions
  const refPositions = [];
  for (const el of snapshot.interactiveElements) {
    const backendNodeId = this.refMap.get(el.ref);
    if (!backendNodeId) continue;

    const box = await this.getBoxModel(/* resolve nodeId */);
    if (box) {
      refPositions.push({
        ref: el.ref,
        rect: { left: box.content[0], top: box.content[1], ... }
      });
    }
  }

  // 3. Show overlays
  await this.cdp.send('Runtime.evaluate', {
    expression: `window.__bpShowOverlay(${JSON.stringify(refPositions)})`
  });
}

async removeRefOverlay(): Promise<void> {
  await this.cdp.send('Runtime.evaluate', {
    expression: 'window.__bpRemoveOverlay && window.__bpRemoveOverlay()'
  });
}
```

---

## 5. Failure Hints

### 5.1 Requirements

1. Auto-suggest 2-3 alternatives on element not found
2. Based on fuzzy matching against current page state
3. Only for key actions: click, fill, submit, select, check, focus, hover
4. Clearly labeled per action/selector in batch mode
5. Different hint types (not just more of the same)

### 5.2 Hint Structure

```typescript
interface FailureHint {
  selector: string;           // Suggested selector
  reason: string;             // Why this might work
  confidence: 'high' | 'medium' | 'low';
  element: {
    ref: string;
    role: string;
    name: string;
    disabled?: boolean;
  };
}

// Enhanced error class
class ElementNotFoundError extends Error {
  selectors: string[];
  hints?: FailureHint[];

  constructor(selectors: string[], hints?: FailureHint[]) {
    super(`Element not found: ${selectors.join(', ')}`);
    this.selectors = selectors;
    this.hints = hints;
  }
}
```

### 5.3 Hint Output Format

**CLI output:**
```
Step 2: click on #submit-btn
  FAILED - Element not found: #submit-btn

  Suggestions:
  1. ref:e4 - Button "Submit" (exact role match)
  2. [data-testid="confirm"] - Button "Confirm" (similar text)
  3. form button[type=submit] - First submit button in form
```

**JSON output (in StepResult):**
```json
{
  "index": 2,
  "action": "click",
  "selector": "#submit-btn",
  "success": false,
  "error": "Element not found: #submit-btn",
  "hints": [
    {
      "selector": "ref:e4",
      "reason": "Button with name 'Submit' (exact role match)",
      "confidence": "high",
      "element": { "ref": "e4", "role": "button", "name": "Submit" }
    },
    {
      "selector": "[data-testid='confirm']",
      "reason": "Button with similar action intent",
      "confidence": "medium",
      "element": { "ref": "e7", "role": "button", "name": "Confirm" }
    }
  ]
}
```

### 5.4 Actions with Hint Support

| Action | Target Role(s) | Hint Strategy |
|--------|---------------|---------------|
| `click` | button, link, menuitem | Match role + fuzzy name |
| `fill` | textbox, searchbox | Match input type + label |
| `submit` | button[type=submit], form | Find form submissions |
| `select` | combobox, listbox | Match select/dropdown patterns |
| `check/uncheck` | checkbox, radio | Match checkable elements |
| `focus` | any focusable | Match by name/label |
| `hover` | any | Match nearby elements |

### 5.5 Implementation Strategy

**Lazy snapshot on failure:**
```typescript
// In action methods (e.g., click)
async click(selector, options) {
  try {
    const element = await this.findElement(selector, options);
    if (!element) throw new ElementNotFoundError(selector);
    // ... perform click
  } catch (error) {
    if (error instanceof ElementNotFoundError) {
      // Only snapshot on failure (don't slow happy path)
      const snapshot = await this.snapshot();
      const hints = generateHints(error.selectors, snapshot, 'click');
      throw new ElementNotFoundError(error.selectors, hints);
    }
    throw error;
  }
}
```

### 5.6 Key Implementation Files

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| Error types | `src/browser/types.ts` | 154-164 | `ElementNotFoundError` |
| Click action | `src/browser/page.ts` | 255-295 | Primary failure point |
| Fill action | `src/browser/page.ts` | 300-363 | Input failures |
| Submit action | `src/browser/page.ts` | 561-617 | Form submission |
| Select action | `src/browser/page.ts` | 404-505 | Dropdown failures |
| Batch executor | `src/actions/executor.ts` | 42-52 | Error handling |
| StepResult | `src/actions/types.ts` | 99-129 | Result interface |

### 5.7 Integration with Diagnose

The hint generation should reuse diagnose utilities:

```typescript
// src/browser/hint-generator.ts (NEW FILE)

import { fuzzyMatchElements, stringSimilarity } from './diagnose';

function generateHints(
  failedSelectors: string[],
  snapshot: PageSnapshot,
  actionType: ActionType,
  maxHints: number = 3
): FailureHint[] {
  // 1. Extract search intent from failed selectors
  const intent = extractIntent(failedSelectors);

  // 2. Filter candidates by action-appropriate roles
  const roleFilter = ACTION_ROLE_MAP[actionType];
  const candidates = snapshot.interactiveElements
    .filter(el => roleFilter.includes(el.role));

  // 3. Fuzzy match using diagnose utilities
  const matches = fuzzyMatchElements(intent.text, candidates, maxHints * 2);

  // 4. Diversify hint types
  return diversifyHints(matches, maxHints);
}

// Ensure hints are different types, not just more of the same
function diversifyHints(matches: FuzzyMatch[], max: number): FailureHint[] {
  const hints: FailureHint[] = [];
  const usedTypes = new Set<string>();

  for (const match of matches) {
    const hintType = getHintType(match); // 'ref', 'testid', 'css', 'text'
    if (!usedTypes.has(hintType) && hints.length < max) {
      hints.push(toHint(match));
      usedTypes.add(hintType);
    }
  }

  return hints;
}
```

---

## 6. Shared Utilities

### 6.1 Fuzzy Matching Module

Used by both `diagnose` and failure hints:

```typescript
// src/browser/fuzzy-match.ts (NEW FILE)

// Levenshtein distance
export function levenshtein(a: string, b: string): number;

// Jaro-Winkler similarity (0-1)
export function jaroWinkler(a: string, b: string): number;

// Combined similarity score
export function stringSimilarity(a: string, b: string): number {
  const jw = jaroWinkler(a.toLowerCase(), b.toLowerCase());
  const containsBonus = b.toLowerCase().includes(a.toLowerCase()) ? 0.2 : 0;
  return Math.min(1, jw + containsBonus);
}

// Fuzzy match against element list
export function fuzzyMatchElements(
  query: string,
  elements: InteractiveElement[],
  maxResults: number
): FuzzyMatch[] {
  const scored = elements.map(el => ({
    element: el,
    score: scoreElement(query, el)
  }));

  return scored
    .filter(s => s.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => ({
      ...s.element,
      score: s.score,
      matchReason: explainMatch(query, s.element)
    }));
}
```

### 6.2 Selector Generation

Generate alternative selectors for elements:

```typescript
// src/browser/selector-generator.ts (NEW FILE)

export function generateSelectors(
  element: InteractiveElement,
  refMap: Map<string, number>
): string[] {
  const selectors: string[] = [];

  // 1. Ref selector (most reliable)
  selectors.push(`ref:${element.ref}`);

  // 2. Role + name (semantic)
  if (element.name) {
    selectors.push(`[role="${element.role}"][aria-label="${element.name}"]`);
  }

  // 3. data-testid if available
  // 4. ID if available
  // 5. CSS path as fallback

  return selectors;
}
```

### 6.3 Visibility Utilities

Enhanced from existing `strategies.ts`:

```typescript
// src/browser/visibility.ts (NEW FILE)

export interface VisibilityState {
  visible: boolean;
  display: string;
  visibility: string;
  opacity: number;
  width: number;
  height: number;
  inViewport: boolean;
  reasons: string[];  // Why not visible
}

export async function getVisibilityState(
  cdp: CDPClient,
  nodeId: number
): Promise<VisibilityState>;

export async function isCoveredByOverlay(
  cdp: CDPClient,
  nodeId: number
): Promise<{ covered: boolean; coveringElement?: ElementInfo }>;
```

---

## 7. Testing Strategy

### 7.1 Unit Tests

**Location:** `tests/unit/`

```typescript
// tests/unit/diagnose.test.ts
- Test fuzzy matching algorithm with various inputs
- Test scoring weights and ranking
- Test overlay detection logic (mocked CDP)
- Test selector generation

// tests/unit/snapshot-diff.test.ts
- Test element matching across snapshots
- Test change detection (added/removed/changed)
- Test edge cases (empty snapshots, renamed elements)

// tests/unit/session-logger.test.ts
- Test log entry formatting
- Test log file rotation
- Test concurrent writes

// tests/unit/failure-hints.test.ts
- Test hint generation from snapshots
- Test hint diversification
- Test action-specific role filtering
```

### 7.2 Integration Tests

**Location:** `tests/integration/`

```typescript
// tests/integration/diagnose.test.ts
- Real page with various elements
- Test exact vs fuzzy matching
- Test overlay detection with modal dialogs
- Test disabled element detection

// tests/integration/snapshot-diff.test.ts
- Take snapshot, make changes, take another snapshot
- Verify diff detects added/removed/changed elements
- Test across navigations

// tests/integration/inspect-overlay.test.ts
- Inject overlay on real page
- Verify visual positioning
- Verify cleanup removes all injected elements
- Test with shadow DOM

// tests/integration/failure-hints.test.ts
- Attempt click on non-existent element
- Verify hints suggest real alternatives
- Test across different page types
```

### 7.3 CLI Tests

**Location:** `tests/cli/`

```typescript
// tests/cli/diagnose.test.ts
- Test command parsing
- Test output formats (pretty, JSON)
- Test session handling

// tests/cli/snapshot-diff.test.ts
- Test --diff flag parsing
- Test file comparison
- Test output formatting

// tests/cli/session-log.test.ts
- Test log path discovery
- Test log tailing
- Test session info output
```

### 7.4 Test Fixtures Needed

```typescript
// tests/fixtures/diagnose-page.html
// Page with various interactive elements for diagnose testing

// tests/fixtures/overlay-modal.html
// Page with modal/overlay covering elements

// tests/fixtures/dynamic-form.html
// Form that changes state (for diff testing)
```

---

## 8. Documentation Updates

### 8.1 Files to Update

| Priority | File | Updates Needed |
|----------|------|----------------|
| **HIGH** | `src/cli/index.ts` | Add diagnose, find to HELP text (lines 42-53) |
| **HIGH** | `docs/cli.md` | Add command sections for all new features |
| **HIGH** | `README.md` | Add CLI examples (lines 327-361) |
| **HIGH** | Create `src/cli/commands/diagnose.ts` | New command with help text |
| **MEDIUM** | `docs/skill/SKILL.md` | Add to quick reference (line 47-54) |
| **MEDIUM** | `docs/skill/REFERENCE.md` | Full reference for new features |
| **MEDIUM** | `docs/guides/snapshots.md` | Reference --diff and --inspect |
| **MEDIUM** | `src/cli/commands/snapshot.ts` | Add --diff, --inspect options |
| **LOW** | `docs/getting-started.md` | Add troubleshooting section |
| **LOW** | `CLAUDE.md` | Update command list |
| **LOW** | `CHANGELOG.md` | Add to [Unreleased] |

### 8.2 New Documentation Sections

**For `docs/cli.md`:**

```markdown
## bp diagnose

Diagnose element selection issues and find alternatives.

### Usage

```bash
# Exact match - full diagnostics
bp diagnose "#submit-button"

# Fuzzy match - find similar elements
bp diagnose "submit"
```

### Options

- `--json` - Output as JSON
- `--max <n>` - Show top N candidates (default: 5)
- `-s, --session <id>` - Use specific session

### Output

When an exact match is found, shows:
- Visibility state (display, opacity, in viewport)
- Interactivity (disabled, covered by overlay)
- Alternative selectors for the element

When no exact match, shows top candidates with:
- Match score and reason
- Element role and name
- Visibility and disabled state
```

**For `docs/skill/SKILL.md`:**

```markdown
## Debugging Failed Actions

When an action fails, browser-pilot provides hints:

```bash
# Action failed
bp exec '{"action":"click","selector":"#submit"}'
# Error: Element not found
# Suggestions:
#   1. ref:e4 - Button "Submit" (exact match)
#   2. [data-testid="confirm"] - Similar element

# Use diagnose to investigate
bp diagnose "#submit"
bp diagnose "submit"  # Fuzzy search
```
```

### 8.3 CLI Help Text Template

```typescript
// src/cli/commands/diagnose.ts

const DIAGNOSE_HELP = `
bp diagnose - Diagnose element selection and find alternatives

USAGE:
  bp diagnose <selector>           Diagnose specific selector
  bp diagnose "<fuzzy query>"      Fuzzy search for elements

EXAMPLES:
  bp diagnose "#login-btn"         Full diagnostics for element
  bp diagnose "submit"             Find elements matching "submit"
  bp diagnose "ref:e4"             Diagnose by element ref

OPTIONS:
  --json              Output as JSON
  --max <n>           Max candidates for fuzzy match (default: 5)
  -s, --session <id>  Use specific session

OUTPUT (exact match):
  - Visibility: display, opacity, in viewport
  - Interactivity: disabled, covered by overlay
  - Alternative selectors

OUTPUT (fuzzy match):
  - Top N candidates ranked by similarity
  - Role, name, visibility for each
`;
```

---

## Appendix: File Structure for New Code

```
src/
├── browser/
│   ├── diagnose.ts          # NEW: Diagnose utilities
│   ├── fuzzy-match.ts       # NEW: String similarity, matching
│   ├── hint-generator.ts    # NEW: Failure hint generation
│   ├── selector-generator.ts # NEW: Alternative selector generation
│   ├── snapshot-diff.ts     # NEW: Snapshot comparison
│   ├── visibility.ts        # NEW: Enhanced visibility checks
│   └── overlay.ts           # NEW: Visual overlay injection
├── cli/
│   ├── commands/
│   │   ├── diagnose.ts      # NEW: bp diagnose command
│   │   └── snapshot.ts      # MODIFY: Add --diff, --inspect
│   └── session-logger.ts    # NEW: Session logging
└── trace/
    └── tracer.ts            # MODIFY: Add file output option

tests/
├── unit/
│   ├── diagnose.test.ts     # NEW
│   ├── fuzzy-match.test.ts  # NEW
│   ├── snapshot-diff.test.ts # NEW
│   └── session-logger.test.ts # NEW
├── integration/
│   ├── diagnose.test.ts     # NEW
│   ├── snapshot-diff.test.ts # NEW
│   └── inspect-overlay.test.ts # NEW
└── fixtures/
    ├── diagnose-page.html   # NEW
    ├── overlay-modal.html   # NEW
    └── dynamic-form.html    # NEW
```

---

## Next Steps

1. **Phase 1: Core Infrastructure**
   - Implement fuzzy matching module
   - Implement diagnose command
   - Add failure hints to actions

2. **Phase 2: Snapshot Enhancements**
   - Implement snapshot diff
   - Implement visual overlay (--inspect)

3. **Phase 3: Logging**
   - Implement session logger
   - Add log access commands

4. **Phase 4: Polish**
   - Update all documentation
   - Add comprehensive tests
   - Performance optimization
