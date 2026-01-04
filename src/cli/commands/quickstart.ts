/**
 * Quickstart command - Display comprehensive getting started documentation
 */

const QUICKSTART = `
browser-pilot - CDP-based browser automation for AI agents

Zero production dependencies. Works in Node.js, Bun, and Cloudflare Workers.

RUNNING
  npx browser-pilot ...     # Node.js projects
  bunx browser-pilot ...    # Bun projects (faster)

CONNECTING
  npx browser-pilot connect <wsUrl>     Connect to existing browser
  npx browser-pilot connect --provider browserbase --api-key <key>

BASIC USAGE (Code)
  import { Browser } from 'browser-pilot';

  const browser = await Browser.connect({ wsUrl: '...' });
  const page = await browser.newPage();
  await page.goto('https://example.com');
  await page.click('#button');
  await page.fill('#input', 'text');
  await browser.close();

KEY PATTERNS
  Multi-Selector    await page.click(['#primary', '.fallback', 'button']);
  Smart Waiting     Every action waits for visibility automatically
  Optional Actions  await page.click('#banner', { optional: true });

BATCH EXECUTION
  await page.batch([
    { action: 'goto', url: 'https://example.com' },
    { action: 'fill', selector: '#email', value: 'test@test.com' },
    { action: 'submit', selector: 'form' },
  ]);

SNAPSHOTS (FOR AI AGENTS)
  const snapshot = await page.snapshot();
  // Returns accessibility tree with refs: e1, e2, e3...
  await page.click({ ref: 'e5' });

PROVIDERS
  BrowserBase     Browser.connect({ provider: 'browserbase', apiKey })
  Browserless     Browser.connect({ provider: 'browserless', apiKey })
  Generic         Browser.connect({ wsUrl: 'ws://...' })

COMMON ACTIONS
  page.goto(url)              Navigate to URL
  page.click(selector)        Click element
  page.fill(selector, value)  Fill input field
  page.submit(selector)       Submit form
  page.select(selector, val)  Select dropdown option
  page.screenshot()           Capture screenshot
  page.snapshot()             Get accessibility tree

AGENT INTEGRATION
  - Use snapshot() to get page state as accessibility tree
  - Refs (e1, e2...) identify elements without fragile selectors
  - Multi-selector arrays handle UI variations
  - optional: true prevents failures on transient elements

Ready to automate!
Run: npx browser-pilot connect <wsUrl>
`;

export async function quickstartCommand(): Promise<void> {
  console.log(QUICKSTART);
}
