/**
 * Cross-origin (OOPIF) test harness.
 *
 * Unlike the single-origin harness in `harness.ts` (one `Bun.serve`, one
 * `baseUrl`), this starts TWO fixture servers on two different ports = two
 * different origins:
 *
 *   - Origin A ("parent") serves the top-level page.
 *   - Origin B ("child")  serves the in-frame form page.
 *
 * A page loaded from origin A that embeds an `<iframe src="...origin B...">`
 * is a genuine cross-origin iframe. To make Chrome place that frame in its own
 * renderer process (a true out-of-process iframe / OOPIF) we launch Chrome with
 * `--site-per-process`.
 *
 * CRITICAL — use two different SITES, not just two ports. Chrome's site
 * isolation partitions by *site* (registrable domain / eTLD+1), NOT by origin.
 * `localhost:A` and `localhost:B` are the SAME site, so `--site-per-process`
 * keeps them in one renderer → the child is a same-process cross-origin frame,
 * NOT an OOPIF (its `contentDocument` is still reachable via CDP, so the
 * existing engine already handles it and these tests would pass trivially).
 * To force a real OOPIF we serve the two origins on different hostnames whose
 * registrable domains differ: the parent on `127.0.0.1` and the child on
 * `localhost`. These are different sites, so under `--site-per-process` the
 * child becomes a true out-of-process iframe (verified empirically: with the
 * current engine `switchToFrame` throws "Cannot access iframe content").
 *
 * Because ports are assigned dynamically (`port: 0`), the child origin is not
 * known until the child server is listening. Fixtures therefore reference the
 * child origin through a `%%CHILD_ORIGIN%%` placeholder that BOTH servers
 * string-replace with `http://localhost:${portB}` at serve time. This is the
 * templating contract the fixtures rely on:
 *
 *   <iframe src="%%CHILD_ORIGIN%%/cross-origin-child.html">
 *        -> <iframe src="http://localhost:53187/cross-origin-child.html">
 *
 * ── ENVIRONMENT CAVEAT (read before trusting a green/red run) ────────────────
 * `--site-per-process` plus two different sites is what forces the OOPIF. The
 * public-API tests in `cross-origin-iframe.test.ts` assert user-visible
 * behaviour (`switchToFrame` + fill/click/read) rather than the CDP target
 * topology, so they remain correct whether the engine reaches the child via a
 * separate OOPIF session or any other mechanism.
 */

import * as chromeLauncher from 'chrome-launcher';
import { type Browser, connect, getBrowserWebSocketUrl, type Page } from '../../src/index.ts';

const FIXTURE_DIR = './tests/fixtures/pages';
const CHILD_ORIGIN_PLACEHOLDER = '%%CHILD_ORIGIN%%';

// Two DIFFERENT sites (different registrable domains), so `--site-per-process`
// actually produces an OOPIF. `127.0.0.1` and `localhost` are distinct sites;
// two `localhost` ports would be the same site and stay in one process.
const PARENT_HOSTNAME = '127.0.0.1';
const CHILD_HOSTNAME = 'localhost';

/**
 * Base flags mirror `harness.ts`. The distinguishing addition is
 * `--site-per-process`, which asks Chrome to isolate every site into its own
 * renderer so a cross-origin iframe becomes a real OOPIF where the build
 * honours it.
 */
const CROSS_ORIGIN_CHROME_FLAGS = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-translate',
  '--mute-audio',
  '--hide-scrollbars',
  // Force out-of-process iframes for cross-origin content.
  '--site-per-process',
];

interface CreateCrossOriginHarnessOptions {
  chromePath?: string;
  /** Extra Chrome flags appended after the defaults (e.g. to tweak isolation). */
  extraChromeFlags?: string[];
}

export interface CrossOriginHarness {
  browser: Browser;
  chrome: chromeLauncher.LaunchedChrome;
  /** Origin A — serves the top-level parent page. */
  parentOrigin: string;
  /** Origin B — serves the in-frame child form page. */
  childOrigin: string;
  /** Convenience: absolute URL of the primary cross-origin parent fixture. */
  parentUrl: string;
  parentServer: ReturnType<typeof Bun.serve>;
  childServer: ReturnType<typeof Bun.serve>;
}

function resolveChromePath(): string | undefined {
  return process.env['BROWSER_PILOT_CHROME_PATH'] ?? process.env['CHROME_PATH'];
}

function getContentType(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  if (path.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (path.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

/**
 * Build a fixture server. `getChildOrigin` is a lazy getter so the child origin
 * can be resolved AFTER `Bun.serve` returns a port — both servers template the
 * same `%%CHILD_ORIGIN%%` placeholder to the child (origin B) URL.
 */
function makeFixtureServer(
  hostname: string,
  getChildOrigin: () => string
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname,
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      let pathname = url.pathname;

      if (pathname.endsWith('/')) pathname += 'index.html';
      if (pathname === '/') pathname = '/cross-origin-parent.html';

      const file = Bun.file(`${FIXTURE_DIR}${pathname}`);
      if (!(await file.exists())) {
        return new Response('Not Found', { status: 404 });
      }

      // HTML fixtures may carry the %%CHILD_ORIGIN%% placeholder; template it.
      if (pathname.endsWith('.html')) {
        const raw = await file.text();
        const templated = raw.replaceAll(CHILD_ORIGIN_PLACEHOLDER, getChildOrigin());
        return new Response(templated, {
          headers: { 'Content-Type': getContentType(pathname) },
        });
      }

      return new Response(file, { headers: { 'Content-Type': getContentType(pathname) } });
    },
  });
}

/**
 * Start two origins, launch Chrome with site isolation, and connect
 * browser-pilot. Mirrors `createTestHarness` from `harness.ts`.
 */
export async function createCrossOriginHarness(
  options: CreateCrossOriginHarnessOptions = {}
): Promise<CrossOriginHarness> {
  // Shared, lazily-populated child origin captured by both server closures.
  let childOrigin = '';
  const getChildOrigin = () => childOrigin;

  // 1. Child server (origin B, on `localhost`) first, so we can resolve its origin.
  const childServer = makeFixtureServer(CHILD_HOSTNAME, getChildOrigin);
  childOrigin = `http://${CHILD_HOSTNAME}:${childServer.port}`;

  // 2. Parent server (origin A, on `127.0.0.1` — a DIFFERENT site). Its fetch
  //    closure reads `childOrigin` lazily, already populated by request time.
  const parentServer = makeFixtureServer(PARENT_HOSTNAME, getChildOrigin);
  const parentOrigin = `http://${PARENT_HOSTNAME}:${parentServer.port}`;
  const parentUrl = `${parentOrigin}/cross-origin-parent.html`;

  console.log(`  Cross-origin fixture servers: parent=${parentOrigin} child=${childOrigin}`);

  // 3. Launch Chrome with site isolation forced on.
  const chrome = await chromeLauncher.launch({
    chromePath: options.chromePath ?? resolveChromePath(),
    chromeFlags: [...CROSS_ORIGIN_CHROME_FLAGS, ...(options.extraChromeFlags ?? [])],
    userDataDir: false,
  });
  console.log(`  Chrome launched on port ${chrome.port} (--site-per-process)`);

  // 4. Connect browser-pilot.
  const wsUrl = await getBrowserWebSocketUrl(`localhost:${chrome.port}`);
  const browser = await connect({ provider: 'generic', wsUrl, debug: false });
  console.log('  Browser connected');

  return {
    browser,
    chrome,
    parentOrigin,
    childOrigin,
    parentUrl,
    parentServer,
    childServer,
  };
}

export async function destroyCrossOriginHarness(h: CrossOriginHarness): Promise<void> {
  console.log('  Tearing down cross-origin harness...');
  try {
    await h.browser.close();
  } catch {
    // Ignore close errors
  }
  await h.chrome.kill();
  h.parentServer.stop();
  h.childServer.stop();
}

/**
 * Test context for cross-origin integration tests — mirrors `TestContext`
 * in `../integration/setup.ts` but backed by the two-origin harness.
 *
 * Usage:
 *   const ctx = new CrossOriginTestContext();
 *   beforeAll(() => ctx.setup());
 *   afterAll(() => ctx.teardown());
 *   afterEach(() => ctx.resetPage());
 *   test('...', async () => {
 *     const { page, parentUrl, childOrigin } = ctx.get();
 *   });
 */
export class CrossOriginTestContext {
  private harness: CrossOriginHarness | null = null;
  private page: Page | null = null;

  async setup(): Promise<CrossOriginHarness> {
    console.log('\n  Setting up cross-origin integration harness...');
    this.harness = await createCrossOriginHarness();
    this.page = await this.harness.browser.page();
    return this.harness;
  }

  async teardown(): Promise<void> {
    if (this.harness) {
      await destroyCrossOriginHarness(this.harness);
      this.harness = null;
    }
    this.page = null;
  }

  get(): { page: Page; parentOrigin: string; childOrigin: string; parentUrl: string } {
    if (!this.page || !this.harness) {
      throw new Error('Cross-origin harness not initialized. Call setup() in beforeAll.');
    }
    return {
      page: this.page,
      parentOrigin: this.harness.parentOrigin,
      childOrigin: this.harness.childOrigin,
      parentUrl: this.harness.parentUrl,
    };
  }

  async resetPage(): Promise<void> {
    if (this.page) {
      await this.page.reset();
    }
  }
}
