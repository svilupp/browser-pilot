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
await page.fill('#email', 'user@example.com', { blur: true }); // Trigger blur after fill
await page.fill('#notes', 'draft', { verify: false }); // Skip read-back verification
```

**Parameters:**
- `selector: string | string[]` - Target input
- `value: string` - Text to fill
- `options.blur?: boolean` - Trigger blur after fill (default: false)
- `options.verify?: boolean` - Read value back and retry if needed (default: true)
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
await page.submit('#form', { waitForNavigation: 'auto' }); // Detect navigation briefly, then continue
await page.submit('#form', { waitForNavigation: false });  // Return immediately
await page.submit('#form', { waitForNavigation: true });   // Always wait for full navigation
```

**Parameters:**
- `selector: string | string[]` - Form or submit button
- `options.method?: 'enter' | 'click' | 'enter+click'` (default: 'enter+click')
- `options.waitForNavigation?: boolean | 'auto'` (default: 'auto')
- `options.timeout?: number`
- `options.optional?: boolean`

### press(key, options?)

Press a keyboard key, optionally with modifier keys held down.

```typescript
await page.press('Enter');
await page.press('Escape');
await page.press('Tab');
await page.press('ArrowDown');
await page.press('Backspace');

// With modifiers
await page.press('a', { modifiers: ['Control'] });      // Ctrl+A (select all)
await page.press('z', { modifiers: ['Meta', 'Shift'] }); // Cmd+Shift+Z (redo on macOS)
```

**Parameters:**
- `key: string` - Key to press
- `options.modifiers?: Array<'Control' | 'Shift' | 'Alt' | 'Meta'>` - Modifier keys to hold

**Supported keys:** Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, and single characters.

### shortcut(combo)

Execute a keyboard shortcut from a combo string.

```typescript
await page.shortcut('Control+a');       // Select all
await page.shortcut('Meta+Shift+z');    // Redo (macOS)
await page.shortcut('Control+Shift+k'); // Delete line
```

**Parameters:**
- `combo: string` - Shortcut combo in `Modifier+Key` format (e.g. `"Control+a"`, `"Meta+Shift+z"`). Valid modifiers: `Control`, `Shift`, `Alt`, `Meta`.

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

### snapshot(options?)

Get an accessibility tree snapshot of the page.

```typescript
const snapshot = await page.snapshot();

console.log(snapshot.url);
console.log(snapshot.title);
console.log(snapshot.text);
console.log(snapshot.accessibilityTree);
console.log(snapshot.interactiveElements);

// Opt-in: enrich each interactive element with real DOM attributes
const enriched = await page.snapshot({ attributes: true });
console.log(enriched.interactiveElements[0]?.attributes); // { id, 'data-testid', class, name, type, ... }
```

**Options:**
- `attributes?: boolean` - Populate `InteractiveElement.attributes` with real DOM attributes (`id`, `data-testid`/`data-test`/`data-qa`, stable `class`es, `name`, `type`) via a single batched `DOM.getDocument` pass (default: false).

**Returns:** `PageSnapshot`

See [Snapshots Guide](../guides/snapshots.md) for details.

### text(selector?)

Get text content from the page or a specific element.

```typescript
const allText = await page.text();
const mainText = await page.text('.main-content');
```

### review()

Extract structured business state from the current page.

```typescript
const review = await page.review();

console.log(review.headings);      // Page headings
console.log(review.forms);         // Form field values and states
console.log(review.alerts);        // Alert/notification text
console.log(review.tables);        // Structured table data
console.log(review.keyValues);     // Key-value pairs found
console.log(review.statusLabels);  // Status text elements
```

**Returns:** `ReviewResult`

### captureState()

Capture a lightweight page state for delta comparison.

```typescript
const before = await page.captureState();
await page.click('#save');
const delta = await page.delta(before);

if (delta.hasChanges) {
  console.log(delta.changes); // URL, heading, field, button, alert changes
}
```

**Returns:** `PageState`

### delta(before?)

Compute what changed between two page states.

```typescript
const before = await page.captureState();
// ... do something ...
const delta = await page.delta(before);
console.log(delta.changes);
console.log(delta.hasChanges);
```

**Parameters:**
- `before?: PageState` - Previous state to compare against. If omitted, returns current state.

**Returns:** `DeltaResult | PageState`

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

## Resolution & Diagnostics

### resolveAll(intent, options?)

Score every plausible target for an intent and return the ranked candidates. Read-only: it ranks only and executes nothing (no clicks, no navigation).

```typescript
const candidates = await page.resolveAll('create order', { limit: 5 });
console.log(candidates[0]?.ref, candidates[0]?.score, candidates[0]?.strategy);
```

**Parameters:**
- `intent: string` - Natural-language description of the target.
- `options?: { snapshot?, action?, limit?, includeHidden?, strategies?, minConfidence? }` - When `snapshot` is omitted, an attribute-enriched snapshot is taken automatically.

**Returns:** `RankedCandidate[]`

### diagnose(selectorOrIntent, options?)

Explain why a selector or intent does/doesn't resolve to an element.

```typescript
const result = await page.diagnose('#submit-btn');
if (result.matched) {
  console.log(result.visibility, result.interactivity, result.attributes);
} else {
  console.log(result.candidates); // ranked fuzzy suggestions
}
```

**Parameters:**
- `selectorOrIntent: string` - A CSS selector, `ref:` selector, or fuzzy intent.
- `options?: DiagnoseOptions` - `{ maxCandidates?, includeHidden? }`.

**Returns:** `DiagnoseResult` (`DiagnoseExactResult | DiagnoseFuzzyResult`)

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
- `record?: RecordOptions` - Capture a replay manifest plus per-step screenshots

```typescript
const result = await page.batch(steps, {
  record: {
    outputDir: './artifacts/replay',
    format: 'webp',
    quality: 40,
  },
});

console.log(result.recordingManifest);
console.log(result.steps[0]?.screenshotPath);
```

Recording notes:
- Sensitive fields are redacted based on field metadata (`password`, `hidden`, `one-time-code`, `cc-*`)
- Replays still write `recording.json` when execution stops on a failed step

#### Outcome Conditions

Steps can include conditions to verify the action's effect:

```typescript
const result = await page.batch([
  {
    action: 'submit',
    selector: 'form',
    expectAny: [{ kind: 'urlMatches', pattern: '*/success*' }],
    failIf: [{ kind: 'textAppears', text: 'Error' }],
    dangerous: true,
  },
]);

console.log(result.steps[0]?.outcomeStatus);  // 'success' | 'failed' | 'ambiguous' | 'unsafe_to_retry'
console.log(result.steps[0]?.retrySafe);       // false (dangerous step)
```

See [Batch Actions Guide](../guides/batch-actions.md) for details.

## Emulation

### emulate(device)

Emulate a device (viewport, user agent, touch).

```typescript
import { devices } from 'browser-pilot';

await page.emulate(devices['iPhone 14']);
```

**Available devices:** `iPhone 14`, `iPhone 14 Pro Max`, `Pixel 7`, `iPad Pro 11`, `Desktop Chrome`, `Desktop Firefox`

### setViewport(options)

Set viewport dimensions.

```typescript
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2, isMobile: true });
await page.clearViewport(); // Reset
```

### setUserAgent(userAgent)

Set user agent string.

```typescript
await page.setUserAgent('Custom UA');
await page.setUserAgent({ userAgent: '...', platform: 'Win32' });
```

### setGeolocation(options)

Override geolocation.

```typescript
await page.setGeolocation({ latitude: 37.7749, longitude: -122.4194, accuracy: 10 });
await page.clearGeolocation();
```

### setTimezone(timezoneId)

Set timezone.

```typescript
await page.setTimezone('America/New_York');
```

### setLocale(locale)

Set locale.

```typescript
await page.setLocale('fr-FR');
```

### getEmulationState()

Get current emulation state.

```typescript
const state = page.getEmulationState();
// { viewport, userAgent, geolocation, timezone, locale }
```

## Request Interception

### intercept(pattern, handler)

Low-level request interception with full control.

```typescript
const unsubscribe = await page.intercept('*api*', async (request, actions) => {
  if (request.url.includes('blocked')) {
    await actions.fail({ reason: 'BlockedByClient' });
  } else if (request.url.includes('mock')) {
    await actions.fulfill({ status: 200, body: '{"ok":true}' });
  } else {
    await actions.continue({ headers: { ...request.headers, 'X-Custom': 'value' } });
  }
});

unsubscribe(); // Remove handler
```

### route(pattern, response)

Simple request mocking.

```typescript
await page.route('**/api/users', { status: 200, body: { users: [] } });
await page.route('**/api/error', { status: 500, body: 'Error' });
```

### blockResources(types)

Block resource types.

```typescript
await page.blockResources(['Image', 'Font', 'Stylesheet']);
```

**Resource types:** `Document`, `Stylesheet`, `Image`, `Media`, `Font`, `Script`, `XHR`, `Fetch`, `WebSocket`, `Other`

### disableInterception()

Disable all request interception.

```typescript
await page.disableInterception();
```

## Cookies & Storage

### cookies(urls?)

Get cookies.

```typescript
const cookies = await page.cookies();
const cookies = await page.cookies(['https://example.com']);
```

### setCookie(cookie) / setCookies(cookies)

Set cookie(s).

```typescript
await page.setCookie({ name: 'session', value: 'abc', domain: '.example.com' });
await page.setCookies([
  { name: 'a', value: '1', domain: '.example.com' },
  { name: 'b', value: '2', domain: '.example.com' },
]);
```

**Options:** `name`, `value`, `domain`, `path`, `expires`, `httpOnly`, `secure`, `sameSite`

### deleteCookie(options) / deleteCookies(options[])

Delete cookie(s).

```typescript
await page.deleteCookie({ name: 'session', domain: '.example.com' });
```

### clearCookies(options?)

Clear all cookies or by domain.

```typescript
await page.clearCookies();
await page.clearCookies({ domain: 'example.com' });
```

### localStorage / sessionStorage

```typescript
await page.setLocalStorage('key', 'value');
const value = await page.getLocalStorage('key');
await page.removeLocalStorage('key');
await page.clearLocalStorage();

// Same API for sessionStorage
await page.setSessionStorage('key', 'value');
await page.getSessionStorage('key');
await page.removeSessionStorage('key');
await page.clearSessionStorage();
```

## Console & Dialogs

### onConsole(handler)

Subscribe to console messages.

```typescript
const unsubscribe = await page.onConsole((msg) => {
  console.log(`[${msg.type}] ${msg.text}`);
  // msg.args, msg.stackTrace, msg.timestamp
});

unsubscribe();
```

### onError(handler)

Subscribe to page errors.

```typescript
const unsubscribe = await page.onError((err) => {
  console.error(`${err.message} at ${err.url}:${err.lineNumber}`);
});
```

### onDialog(handler)

Handle JavaScript dialogs (alert, confirm, prompt, beforeunload).

```typescript
await page.onDialog(async (dialog) => {
  console.log(`${dialog.type}: ${dialog.message}`);
  if (dialog.type === 'confirm') {
    await dialog.accept();
  } else if (dialog.type === 'prompt') {
    await dialog.accept('my answer');
  } else {
    await dialog.dismiss();
  }
});

await page.onDialog(null); // Remove handler
```

### collectConsole(action) / collectErrors(action)

Collect messages during an action.

```typescript
const { result, messages } = await page.collectConsole(async () => {
  return await page.click('#button');
});

const { result, errors } = await page.collectErrors(async () => {
  return await page.evaluate('throw new Error("test")');
});
```

## Types

```typescript
interface ActionOptions {
  timeout?: number;
  optional?: boolean;
}

interface FillOptions extends ActionOptions {
  blur?: boolean;
  verify?: boolean;
}

interface TypeOptions extends ActionOptions {
  delay?: number;
}

interface SubmitOptions extends ActionOptions {
  method?: 'enter' | 'click' | 'enter+click';
  waitForNavigation?: boolean | 'auto';
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

## Audio I/O

Test voice/audio AI agents by injecting microphone input and capturing audio output. Designed for apps that take several seconds to respond with audio.

### setupAudio()

Set up audio input and output interception. Called automatically by other audio methods if needed.

```typescript
await page.setupAudio();
```

Grants microphone permissions, injects `getUserMedia` override, and sets up audio output capture hooks.

### audioInput

Lazy getter for the `AudioInput` controller. Controls the fake microphone stream.

```typescript
// Play audio into the page's microphone
const audioData = await fs.readFile('question.wav');
await page.audioInput.play(new Uint8Array(audioData), { waitForEnd: true });
```

**Methods:**
- `setup()` - Initialize microphone override (called by `setupAudio()`)
- `play(data, options?)` - Feed audio bytes into the fake microphone
- `stop()` - Stop current playback
- `getState()` - Get current state (`idle`, `playing`, `setup`)
- `teardown()` - Remove all hooks

### audioOutput

Lazy getter for the `AudioOutput` controller. Captures audio coming from the page.

```typescript
// Start/stop manual capture
await page.audioOutput.start();
// ... wait for audio ...
const capture = await page.audioOutput.stop();
console.log(`Captured ${capture.durationMs}ms of audio`);

// Capture until silence (typical for voice agents)
const capture = await page.audioOutput.captureUntilSilence({
  silenceTimeout: 5000,   // Wait 5s of silence (voice agents are slow)
  silenceThreshold: 0.01, // RMS threshold
  maxDuration: 300000,    // Safety cap
});
```

**Methods:**
- `setup()` - Initialize output capture hooks (called by `setupAudio()`)
- `start()` - Begin capturing audio output
- `stop()` - Stop capturing, return `CaptureResult`
- `captureUntilSilence(options)` - Capture until silence detected
- `teardown()` - Remove all hooks

**`CaptureResult`:**
- `left: Float32Array` - Left channel PCM data
- `right: Float32Array` - Right channel PCM data
- `sampleRate: number` - Sample rate (typically 48000)
- `durationMs: number` - Duration in milliseconds
- `chunkCount: number` - Number of chunks received

### audioRoundTrip(options)

Full voice round-trip: play input audio, then capture the response until silence.

```typescript
const audioData = await fs.readFile('question.wav');
const result = await page.audioRoundTrip({
  input: new Uint8Array(audioData),
  silenceTimeout: 5000,   // Voice agents take 2-8s to respond
  timeout: 120000,        // Max total time
  preDelay: 500,          // Wait 500ms before playing
});

console.log(`Latency: ${result.latencyMs}ms`);
console.log(`Response: ${result.audio.durationMs}ms of audio`);
```

**Options:**
- `input: Uint8Array` - Audio bytes to play as microphone input
- `silenceTimeout?: number` - Stop after N ms of silence (default: 3000)
- `silenceThreshold?: number` - RMS threshold for silence (default: 0.01)
- `timeout?: number` - Max total time (default: 120000)
- `preDelay?: number` - Wait before playing input (default: 0)

**Returns:** `RoundTripResult`
- `audio: CaptureResult` - Captured response audio
- `latencyMs: number` - Time from input start to first audio response
- `totalMs: number` - Total round-trip time

### Transcription

Transcribe captured audio via OpenAI Whisper (requires `OPENAI_API_KEY`).

```typescript
import { transcribe } from 'browser-pilot';

const capture = await page.audioOutput.captureUntilSilence({
  silenceTimeout: 5000,
});

const result = await transcribe(capture, { language: 'en' });
console.log(result.text);        // "The answer is forty-two"
console.log(result.apiDurationMs); // ~1200 (Whisper is fast)
```

**Options:**
- `apiKey?: string` - OpenAI API key (defaults to `OPENAI_API_KEY` env var)
- `model?: string` - Whisper model (default: `whisper-1`)
- `language?: string` - Language hint (BCP-47, e.g. `en`)
- `responseFormat?: string` - Response format (default: `text`)

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
