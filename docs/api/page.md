# Page API Reference

The `Page` class provides the main interface for browser automation.

## Getting a Page

```typescript
import { connect } from 'browser-pilot';

const browser = await connect({ provider: 'generic' });
const page = await browser.page();        // Get or create default page
const page2 = await browser.page('tab2'); // Named page
const page3 = await browser.newPage();    // Always creates new
```

## Navigation

### goto(url, options?)

Navigate to a URL.

```typescript
await page.goto('https://example.com');
await page.goto('https://example.com', { timeout: 60000 });
```

**Parameters:**
- `url: string` - URL to navigate to
- `options.timeout?: number` - Timeout in ms (default: 30000)

### url()

Get the current URL.

```typescript
const currentUrl = await page.url();
```

### title()

Get the page title.

```typescript
const title = await page.title();
```

### reload(options?)

Reload the current page.

```typescript
await page.reload();
await page.reload({ timeout: 60000 });
```

### goBack(options?)

Navigate back in history.

```typescript
await page.goBack();
```

### goForward(options?)

Navigate forward in history.

```typescript
await page.goForward();
```

## Actions

All action methods accept `string | string[]` for the selector parameter. When given an array, selectors are tried in order until one succeeds.

### click(selector, options?)

Click an element.

```typescript
await page.click('#button');
await page.click(['#primary', '#fallback']);
await page.click('#optional', { optional: true });
```

**Parameters:**
- `selector: string | string[]` - Target element(s)
- `options.timeout?: number` - Timeout in ms (default: 30000)
- `options.optional?: boolean` - Return false instead of throwing (default: false)

**Returns:** `Promise<boolean>` - true if clicked, false if optional and not found

### fill(selector, value, options?)

Fill an input field. Clears existing content by default.

```typescript
await page.fill('#email', 'user@example.com');
await page.fill('#search', 'query', { clear: false }); // Append
```

**Parameters:**
- `selector: string | string[]` - Target input
- `value: string` - Text to fill
- `options.clear?: boolean` - Clear first (default: true)
- `options.timeout?: number`
- `options.optional?: boolean`

### type(selector, text, options?)

Type text character by character. Useful for autocomplete fields.

```typescript
await page.type('#search', 'hello');
await page.type('#search', 'hello', { delay: 100 }); // 100ms between keys
```

**Parameters:**
- `selector: string | string[]` - Target input
- `text: string` - Text to type
- `options.delay?: number` - Delay between keystrokes in ms (default: 50)
- `options.timeout?: number`
- `options.optional?: boolean`

### select(selector, value, options?)

Select option(s) from a native `<select>` element.

```typescript
// Single selection
await page.select('#country', 'US');

// Multiple selection
await page.select('#tags', ['javascript', 'typescript']);
```

**Parameters:**
- `selector: string | string[]` - Target select element
- `value: string | string[]` - Value(s) to select
- `options.timeout?: number`
- `options.optional?: boolean`

### select(config, options?)

Handle custom (non-native) dropdowns.

```typescript
await page.select({
  trigger: '.dropdown-button',
  option: '.dropdown-item',
  value: 'United States',
  match: 'text',
});
```

**Config:**
- `trigger: string | string[]` - Element to click to open dropdown
- `option: string | string[]` - Selector for options
- `value: string` - Value to select
- `match?: 'text' | 'value' | 'contains'` - How to match (default: 'text')

### check(selector, options?)

Check a checkbox or radio button.

```typescript
await page.check('#agree-to-terms');
await page.check(['#remember-me', '[name=remember]']);
```

### uncheck(selector, options?)

Uncheck a checkbox.

```typescript
await page.uncheck('#newsletter');
```

### submit(selector, options?)

Submit a form. Tries Enter key first, then click.

```typescript
await page.submit('#login-form');
await page.submit('#form', { method: 'enter' });  // Enter only
await page.submit('#form', { method: 'click' });  // Click only
await page.submit('#form', { waitForNavigation: false }); // Don't wait
```

**Parameters:**
- `selector: string | string[]` - Form or submit button
- `options.method?: 'enter' | 'click' | 'enter+click'` (default: 'enter+click')
- `options.waitForNavigation?: boolean` (default: true)
- `options.timeout?: number`
- `options.optional?: boolean`

### press(key)

Press a keyboard key.

```typescript
await page.press('Enter');
await page.press('Escape');
await page.press('Tab');
await page.press('ArrowDown');
await page.press('Backspace');
```

**Supported keys:** Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, and single characters.

### focus(selector, options?)

Focus an element.

```typescript
await page.focus('#input');
```

### hover(selector, options?)

Hover over an element.

```typescript
await page.hover('.menu-item');
```

### scroll(selector, options?)

Scroll an element into view or scroll to coordinates.

```typescript
// Scroll element into view
await page.scroll('#footer');

// Scroll to coordinates
await page.scroll('body', { x: 0, y: 1000 });
```

## Waiting

### waitFor(selector, options?)

Wait for an element to reach a state.

```typescript
await page.waitFor('.loaded');  // Default: visible
await page.waitFor('.spinner', { state: 'hidden' });
await page.waitFor('.new-item', { state: 'attached' });
await page.waitFor('.removed', { state: 'detached' });
```

**Options:**
- `state?: 'visible' | 'hidden' | 'attached' | 'detached'` (default: 'visible')
- `timeout?: number`
- `optional?: boolean`

### waitForNavigation(options?)

Wait for page navigation to complete.

```typescript
await page.waitForNavigation();
await page.waitForNavigation({ timeout: 60000 });
```

### waitForNetworkIdle(options?)

Wait for network activity to settle.

```typescript
await page.waitForNetworkIdle();
await page.waitForNetworkIdle({ idleTime: 1000 }); // Wait 1s of no requests
```

**Options:**
- `timeout?: number` (default: 30000)
- `idleTime?: number` - Time in ms with no network activity (default: 500)

## Content

### snapshot()

Get an accessibility tree snapshot of the page.

```typescript
const snapshot = await page.snapshot();

console.log(snapshot.url);
console.log(snapshot.title);
console.log(snapshot.text);
console.log(snapshot.accessibilityTree);
console.log(snapshot.interactiveElements);
```

**Returns:** `PageSnapshot`

See [Snapshots Guide](../guides/snapshots.md) for details.

### text(selector?)

Get text content from the page or a specific element.

```typescript
const allText = await page.text();
const mainText = await page.text('.main-content');
```

### screenshot(options?)

Take a screenshot.

```typescript
const base64 = await page.screenshot();
const fullPage = await page.screenshot({ fullPage: true });
const jpeg = await page.screenshot({ format: 'jpeg', quality: 80 });
```

**Options:**
- `format?: 'png' | 'jpeg' | 'webp'` (default: 'png')
- `quality?: number` - 0-100, for jpeg/webp only
- `fullPage?: boolean` - Capture entire page (default: false)

**Returns:** `string` - Base64 encoded image

### evaluate(expression, ...args)

Execute JavaScript in the page context.

```typescript
const title = await page.evaluate(() => document.title);
const count = await page.evaluate(() => document.querySelectorAll('a').length);
const sum = await page.evaluate((a, b) => a + b, 2, 3);
```

**Returns:** The evaluated result (serialized)

## Files

### setInputFiles(selector, files, options?)

Set files on a file input.

```typescript
await page.setInputFiles('#upload', [
  {
    name: 'document.pdf',
    mimeType: 'application/pdf',
    buffer: pdfData, // ArrayBuffer or base64 string
  }
]);
```

**File format:**
- `name: string` - Filename
- `mimeType: string` - MIME type
- `buffer: ArrayBuffer | string` - File content (ArrayBuffer or base64)

### waitForDownload(trigger, options?)

Wait for a download triggered by an action.

```typescript
const download = await page.waitForDownload(
  () => page.click('#download-btn')
);

console.log(download.filename);
const content = await download.content();
```

**Returns:** `Download`
- `filename: string` - Suggested filename
- `content(): Promise<ArrayBuffer>` - File content

## Batch Execution

### batch(steps, options?)

Execute multiple actions in sequence.

```typescript
const result = await page.batch([
  { action: 'goto', url: 'https://example.com' },
  { action: 'fill', selector: '#search', value: 'test' },
  { action: 'submit', selector: 'form' },
  { action: 'snapshot' },
]);

console.log(result.success);
console.log(result.totalDurationMs);
console.log(result.steps);
```

**Options:**
- `timeout?: number` - Default timeout for all steps
- `onFail?: 'stop' | 'continue'` - Behavior on failure (default: 'stop')

See [Batch Actions Guide](../guides/batch-actions.md) for details.

## Types

```typescript
interface ActionOptions {
  timeout?: number;
  optional?: boolean;
}

interface FillOptions extends ActionOptions {
  clear?: boolean;
}

interface TypeOptions extends ActionOptions {
  delay?: number;
}

interface SubmitOptions extends ActionOptions {
  method?: 'enter' | 'click' | 'enter+click';
  waitForNavigation?: boolean;
}

interface WaitForOptions extends ActionOptions {
  state?: 'visible' | 'hidden' | 'attached' | 'detached';
}

interface NetworkIdleOptions extends ActionOptions {
  idleTime?: number;
}

interface PageSnapshot {
  url: string;
  title: string;
  timestamp: string;
  accessibilityTree: SnapshotNode[];
  interactiveElements: InteractiveElement[];
  text: string;
}
```

## Errors

```typescript
import { ElementNotFoundError, TimeoutError, NavigationError } from 'browser-pilot';

try {
  await page.click('#missing');
} catch (e) {
  if (e instanceof ElementNotFoundError) {
    console.log('Element not found:', e.selector);
  } else if (e instanceof TimeoutError) {
    console.log('Timed out');
  }
}
```
