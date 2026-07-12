# Batch Actions

Batch actions let you execute multiple browser operations in a single call, reducing latency and providing structured results.

## Why Batch?

Without batching, each action is a separate call:

```typescript
// 5 round trips
await page.goto('https://example.com');
await page.fill('#email', 'user@example.com');
await page.fill('#password', 'secret');
await page.click('#submit');
await page.waitForNavigation();
```

With batching, it's one call:

```typescript
// 1 round trip
const result = await page.batch([
  { action: 'goto', url: 'https://example.com' },
  { action: 'fill', selector: '#email', value: 'user@example.com' },
  { action: 'fill', selector: '#password', value: 'secret' },
  { action: 'click', selector: '#submit' },
  { action: 'wait', waitFor: 'navigation' },
]);
```

This is especially important for:
- AI agents (one tool call per sequence)
- High-latency connections
- Complex workflows

## Basic Usage

```typescript
const result = await page.batch([
  { action: 'goto', url: 'https://example.com' },
  { action: 'click', selector: '#button' },
  { action: 'snapshot' },
]);

console.log(result.success);        // true if all succeeded
console.log(result.totalDurationMs); // total time
console.log(result.steps);           // individual results
```

## Action Types

### Navigation

```typescript
{ action: 'goto', url: 'https://example.com' }
```

### Clicking

```typescript
{ action: 'click', selector: '#button' }
{ action: 'click', selector: ['#primary', '.fallback'] }
{ action: 'click', selector: '#optional', optional: true }
```

### Form Input

```typescript
// Fill (clears first)
{ action: 'fill', selector: '#email', value: 'user@example.com' }
{ action: 'fill', selector: '#email', value: 'user@example.com', clear: false }

// Type (character by character)
{ action: 'type', selector: '#search', value: 'query', delay: 50 }
```

### Selection

```typescript
// Native <select>
{ action: 'select', selector: '#country', value: 'US' }
{ action: 'select', selector: '#tags', value: ['a', 'b', 'c'] }

// Custom dropdown
{
  action: 'select',
  trigger: '.dropdown-trigger',
  option: '.dropdown-item',
  value: 'Option Text',
  match: 'text'  // or 'contains' or 'value'
}
```

### Checkboxes

```typescript
{ action: 'check', selector: '#agree' }
{ action: 'uncheck', selector: '#newsletter' }
```

### Form Submission

```typescript
// Tries Enter key, then click
{ action: 'submit', selector: '#form' }

// Specific method
{ action: 'submit', selector: '#form', method: 'enter' }
{ action: 'submit', selector: '#form', method: 'click' }
```

### Keyboard

```typescript
{ action: 'press', key: 'Enter' }
{ action: 'press', key: 'Escape' }
{ action: 'press', key: 'Tab' }

// With modifiers
{ action: 'press', key: 'a', modifiers: ['Control'] }
{ action: 'press', key: 'z', modifiers: ['Meta', 'Shift'] }

// Shortcut combo string
{ action: 'shortcut', combo: 'Control+a' }
{ action: 'shortcut', combo: 'Meta+Shift+z' }
```

### Focus & Hover

```typescript
{ action: 'focus', selector: '#input' }
{ action: 'hover', selector: '.menu-item' }
```

### Scrolling

```typescript
// Scroll element into view
{ action: 'scroll', selector: '#footer' }

// Scroll to coordinates
{ action: 'scroll', x: 0, y: 1000 }
```

### Waiting

```typescript
{ action: 'wait', selector: '.loaded', waitFor: 'visible' }
{ action: 'wait', selector: '.spinner', waitFor: 'hidden' }
{ action: 'wait', waitFor: 'navigation' }
{ action: 'wait', waitFor: 'networkIdle' }
{ action: 'waitForReady', any: ['main'], loadingHidden: '.spinner', stableForMs: 250 }
```

`waitForReady` combines selector/URL/predicate checks with optional loading-hidden and DOM
stability requirements. `networkIdle` only reports transport quiet; it does not prove that a
hydrated application has finished rendering.

### Content Extraction

```typescript
{ action: 'snapshot' }  // Returns accessibility tree
{ action: 'screenshot' }
{ action: 'screenshot', fullPage: true, format: 'jpeg', quality: 80 }
```

### Page State

```typescript
{ action: 'review' }   // Structured business state
{ action: 'delta' }    // Page change detection
```

### JavaScript Evaluation

```typescript
{ action: 'evaluate', value: 'document.title' }
{ action: 'evaluate', value: '(() => { return someValue; })()' }
```

## Result Structure

```typescript
interface BatchResult {
  success: boolean;          // All steps succeeded?
  stoppedAtIndex?: number;   // Where it stopped (if failed)
  totalDurationMs: number;   // Total execution time
  steps: StepResult[];       // Individual results
}

interface StepResult {
  index: number;
  action: string;
  selector?: string | string[];
  selectorUsed?: string;     // Which selector worked
  success: boolean;
  durationMs: number;
  error?: string;
  failedSelectors?: Array<{ selector: string; reason: string }>;
  result?: unknown;          // For snapshot, screenshot, evaluate

  // Structured failure info (on failed steps)
  failureReason?: FailureReason;   // Classified failure type
  suggestion?: string;             // AI-friendly recovery suggestion
  coveringElement?: { tag: string; id?: string; className?: string }; // When reason is 'covered'
  hints?: FailureHint[];           // Alternative selectors to try

  // Outcome evaluation (when conditions specified)
  outcomeStatus?: OutcomeStatus;      // 'success' | 'failed' | 'ambiguous' | 'unsafe_to_retry'
  matchedConditions?: MatchedCondition[];  // Detailed condition results
  retrySafe?: boolean;                // Whether safe to auto-retry
  effect?: 'observe' | 'idempotent' | 'at_most_once';
  receipt?: { dispatchState: 'not_dispatched' | 'dispatched' | 'uncertain'; retrySafe: boolean; inputEventsSent: string[] };
  dispatchState?: 'not_dispatched' | 'dispatched' | 'uncertain';
  attempts?: number;
  retryDecisionReason?: string;
}

type FailureReason =
  | 'missing'     // Element not found in DOM
  | 'hidden'      // Element exists but not visible
  | 'covered'     // Element blocked by another element
  | 'disabled'    // Element is disabled
  | 'readonly'    // Element is readonly
  | 'detached'    // Element removed from DOM during action
  | 'replaced'    // Element was replaced (unstable)
  | 'notEditable' // Not an editable field
  | 'timeout'     // Timed out waiting
  | 'navigation'  // Navigation failed
  | 'cdpError'    // Browser connection error
  | 'unknown';    // Unclassified error
```

## Error Handling

### Stop on Failure (Default)

```typescript
const result = await page.batch([
  { action: 'click', selector: '#step1' },
  { action: 'click', selector: '#missing' },  // Fails here
  { action: 'click', selector: '#step3' },    // Never executed
], { onFail: 'stop' });

console.log(result.success);       // false
console.log(result.stoppedAtIndex); // 1
console.log(result.steps.length);   // 2 (steps 0 and 1)
```

### Continue on Failure

```typescript
const result = await page.batch([
  { action: 'click', selector: '#step1' },
  { action: 'click', selector: '#missing' },  // Fails, continues
  { action: 'click', selector: '#step3' },    // Still executed
], { onFail: 'continue' });

console.log(result.success);      // false (one step failed)
console.log(result.steps.length); // 3 (all steps attempted)
```

### Optional Steps

```typescript
const result = await page.batch([
  { action: 'click', selector: '#cookie-banner', optional: true },
  { action: 'click', selector: '#main-action' },
]);

// If cookie banner doesn't exist, step 0 returns success: false
// but execution continues, and overall result can still be success: true
```

## Timeouts

```typescript
// Default timeout for all steps
const result = await page.batch(steps, { timeout: 10000 });

// Per-step timeout override
const result = await page.batch([
  { action: 'click', selector: '#fast', timeout: 1000 },
  { action: 'click', selector: '#slow', timeout: 30000 },
]);
```

## Extracting Results

### Snapshot Result

```typescript
const result = await page.batch([
  { action: 'goto', url: 'https://example.com' },
  { action: 'snapshot' },
]);

const snapshot = result.steps[1].result as PageSnapshot;
console.log(snapshot.title);
console.log(snapshot.interactiveElements);
```

### Screenshot Result

```typescript
const result = await page.batch([
  { action: 'screenshot', format: 'png' },
]);

const base64 = result.steps[0].result as string;
await writeFile('screenshot.png', Buffer.from(base64, 'base64'));
```

### Evaluate Result

```typescript
const result = await page.batch([
  { action: 'evaluate', value: 'document.querySelectorAll("a").length' },
]);

const linkCount = result.steps[0].result as number;
```

## Assertions

Assertion steps let you verify page state inside a batch, eliminating extra round trips:

```typescript
const result = await page.batch([
  { action: 'goto', url: 'https://example.com/login' },
  { action: 'fill', selector: '#email', value: 'user@example.com' },
  { action: 'fill', selector: '#password', value: 'secret' },
  { action: 'submit', selector: 'form' },
  { action: 'assertUrl', expect: '/dashboard' },
  { action: 'assertText', expect: 'Welcome', selector: 'h1' },
]);
// result.success is false if any assertion fails
```

Available page-state assertions include `assertVisible`, `assertExists`, `assertText`,
`assertUrl`, and `assertValue`. Trace-backed assertions (`assertNoConsoleErrors`,
`assertTextChanged`, `assertPermission`, and `assertMediaTrackLive`) are also available, as are
the `review` and `delta` read actions.

## Outcome Conditions

Any action step can include conditions to verify the outcome, not just the mechanical interaction:

```typescript
const result = await page.batch([
  { action: 'goto', url: 'https://example.com/login' },
  { action: 'fill', selector: '#email', value: 'user@example.com' },
  { action: 'fill', selector: '#password', value: 'secret' },
  {
    action: 'submit',
    selector: 'form',
    expectAny: [
      { kind: 'urlMatches', pattern: '*/dashboard*' },
      { kind: 'textAppears', text: 'Welcome back' },
    ],
    failIf: [
      { kind: 'textAppears', text: 'Invalid credentials' },
    ],
    dangerous: true,
  },
]);

// result.steps[3].outcomeStatus: 'success' | 'failed' | 'ambiguous' | 'unsafe_to_retry'
// result.steps[3].matchedConditions: detailed evaluation results
// result.steps[3].retrySafe: false (because dangerous: true)
```

### Condition Kinds

| Kind | Fields | What it checks |
|------|--------|---------------|
| `urlMatches` | `pattern: string` | Current URL matches glob |
| `elementVisible` | `selector: string \| string[]` | Element is visible |
| `elementHidden` | `selector: string \| string[]` | Element is hidden/absent |
| `textAppears` | `text: string`, optional `selector` | Text substring found |
| `textChanges` | optional `to`, optional `selector` | Text content changed |
| `networkResponse` | `urlPattern: string`, optional `status` | HTTP response seen |
| `stateSignatureChanges` | optional `mode` | Page state fingerprint changed |
| `selectedTab` | optional `selector`, `name`, `landmark` | Selected tab matches |
| `fieldValue` | `selector`, `value` | Field has the expected value |
| `checkbox` | `selector`, `checked` | Checkbox state matches |
| `switch` | `selector`, `checked` | Switch state matches |
| `elementEnabled` | `selector`, optional `enabled` | Control enabled/disabled state matches |
| `targetCount` | `count`, optional `type` | Number of matching browser targets |
| `newTarget` | optional target/opener/url/type | A new browser target appeared |
| `urlChanged` | optional `from`, `mode` | URL changed from the prior state |
| `fieldChanged` | `selector`, optional `from`, `to` | Field value changed |

### Evaluation Order

1. `failIf` conditions checked first: any match = `failed`
2. `expectAll` conditions: all must match
3. `expectAny` conditions: any match = `success`

### Dangerous Steps

Mark steps with `dangerous: true` when the action is irreversible (e.g., "Place Order", "Delete Account"). Dangerous steps:
- Get `unsafe_to_retry` instead of `ambiguous` when conditions don't clearly pass or fail
- Are never auto-retried, even with `retry` set
- Have `retrySafe: false` in the result

## Widget Actions

### Custom Combobox

```typescript
{
  action: 'chooseOption',
  trigger: '#country-select',  // or selector for the trigger
  value: 'United States',
  match: 'contains',  // 'exact' | 'contains' | 'startsWith'
}
```

### File Upload

```typescript
{
  action: 'upload',
  selector: '#file-input',
  files: ['/path/to/document.pdf'],
}
```

## Page Review

Extract structured business state in a single step:

```typescript
const result = await page.batch([
  { action: 'review' },
]);

// result.steps[0].result contains:
// { url, title, headings, forms, alerts, tables, keyValues, statusLabels }
```

## Retry

Any step can include `retry` and `retryDelay` to handle flaky async content. Retries respect the
dispatch boundary: pre-dispatch failures may retry the action, while dispatched or uncertain
effects are observed and their conditions re-evaluated instead of blindly re-dispatching input.
Use `effect: 'observe' | 'idempotent' | 'at_most_once'` and `dangerous: true` to make the policy
explicit:

```typescript
const result = await page.batch([
  { action: 'goto', url: 'https://example.com' },
  { action: 'click', selector: '#load-more', retry: 3, retryDelay: 1000 },
  { action: 'assertVisible', selector: '.results', retry: 5, retryDelay: 500 },
]);
```

With `onFail: 'stop'` (the default), a failed assertion halts the batch immediately. This is useful for validation after form submissions or navigations.

## Recording

Capture a screenshot after each action step by passing `record` in `BatchOptions`:

```typescript
const result = await page.batch([
  { action: 'goto', url: 'https://example.com/login' },
  { action: 'fill', selector: '#email', value: 'user@example.com' },
  { action: 'submit', selector: 'form' },
], {
  record: {
    outputDir: './artifacts/replay',
    format: 'webp',
    quality: 40,
    highlights: true,  // inject visual overlays showing each action
  },
});

// Path to the recording.json manifest
console.log(result.recordingManifest);
```

Sensitive field values (passwords, OTPs, card numbers) are automatically redacted in both the manifest and the screenshot overlays.

**Session-level recording:** Use `bp connect --record` to enable recording for all `bp exec` calls in the session. Frames from multiple exec calls accumulate in the same `recording.json` manifest. See the [Action Recording Guide](./action-recording.md) for full details.

## Real-World Examples

### E-commerce Checkout

```typescript
const result = await page.batch([
  // Add to cart
  { action: 'click', selector: ['#add-to-cart', '.add-cart-btn'] },
  { action: 'wait', waitFor: 'networkIdle' },

  // Go to cart
  { action: 'click', selector: ['#cart-icon', '.cart-link'] },
  { action: 'wait', waitFor: 'navigation' },

  // Proceed to checkout
  { action: 'click', selector: ['#checkout', '.checkout-btn'] },
  { action: 'wait', waitFor: 'navigation' },

  // Fill shipping info
  { action: 'fill', selector: '#name', value: 'John Doe' },
  { action: 'fill', selector: '#address', value: '123 Main St' },
  { action: 'fill', selector: '#city', value: 'New York' },
  { action: 'select', selector: '#state', value: 'NY' },
  { action: 'fill', selector: '#zip', value: '10001' },

  // Continue
  { action: 'submit', selector: '#shipping-form' },
  { action: 'snapshot' },
]);
```

### Search and Extract

```typescript
const result = await page.batch([
  { action: 'goto', url: 'https://search.example.com' },
  { action: 'fill', selector: '#search', value: 'browser automation' },
  { action: 'submit', selector: '#search-form' },
  { action: 'wait', waitFor: 'networkIdle' },
  { action: 'snapshot' },
]);

const snapshot = result.steps[4].result as PageSnapshot;
// Process search results from snapshot
```

### Multi-Page Navigation

```typescript
const result = await page.batch([
  { action: 'goto', url: 'https://example.com/page1' },
  { action: 'snapshot' },
  { action: 'click', selector: '#next' },
  { action: 'wait', waitFor: 'navigation' },
  { action: 'snapshot' },
  { action: 'click', selector: '#next' },
  { action: 'wait', waitFor: 'navigation' },
  { action: 'snapshot' },
]);

const snapshots = result.steps
  .filter(s => s.action === 'snapshot')
  .map(s => s.result as PageSnapshot);
```
