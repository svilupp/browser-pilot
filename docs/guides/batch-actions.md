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
```

### Content Extraction

```typescript
{ action: 'snapshot' }  // Returns accessibility tree
{ action: 'screenshot' }
{ action: 'screenshot', fullPage: true, format: 'jpeg', quality: 80 }
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
}
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
