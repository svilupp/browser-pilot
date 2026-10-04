// Explicit opt-in. Test fixtures only; this runner never enters the payment journey.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeTransportFactory } from '../dist/adapters/node/index.mjs';
import { connect, getBuildProvenance } from '../dist/index.mjs';

const directory =
  process.env.BP_CONFORMANCE_OUTPUT ?? join(tmpdir(), `bp-conformance-${Date.now()}`);
await mkdir(directory, { recursive: true });
const report = {
  build: getBuildProvenance(),
  fixture: 'cloudflare-conformance-v1',
  runtime: process.version,
  scenarios: [],
};
const origin = process.env.CF_TEST_ORIGIN;
const cross = process.env.CF_TEST_CROSS_ORIGIN;
const credentials =
  (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) ||
  (process.env.CF_ACCOUNT_ID && process.env.CF_API_KEY);
if (process.env.BP_LIVE_CLOUDFLARE !== '1' || !credentials || !origin || !cross) {
  report.scenarios.push({
    status: 'blocked',
    scenario: 'live functional fixtures',
    reason:
      'Requires BP_LIVE_CLOUDFLARE=1, provider credentials, CF_TEST_ORIGIN, and CF_TEST_CROSS_ORIGIN',
  });
} else {
  assert.notEqual(
    new URL(origin).origin,
    new URL(cross).origin,
    'cross-origin fixture needs two origins'
  );
  const nativeFetch = globalThis.fetch;
  const nativeTransport = await createNodeTransportFactory();
  let unresolvedAllocation = false;
  for (const engine of ['chromium', 'kitesurf']) {
    for (let iteration = 1; iteration <= 3; iteration++) {
      if (unresolvedAllocation) {
        report.scenarios.push({
          provider: 'cloudflare',
          engine,
          iteration,
          status: 'blocked',
          reason:
            'Previous allocation or cleanup remains unresolved; no fresh allocation attempted',
        });
        continue;
      }
      let allocations = 0;
      let handshakes = 0;
      let browser;
      const started = Date.now();
      const evidence = {
        provider: 'cloudflare',
        engine,
        iteration,
        scenario: 'navigation/form/SPA/cross-origin/screenshot',
        status: 'fail',
      };
      globalThis.fetch = (url, options) => {
        if (options?.method === 'POST' && String(url).includes('/browser-run/devtools/browser'))
          allocations++;
        return nativeFetch(url, options);
      };
      try {
        evidence.stage = 'connect';
        browser = await connect({
          provider: `cloudflare:${engine}`,
          // Bound idle allocation lifetime if the runner loses its connection.
          ...(engine === 'chromium' ? { cloudflare: { keepAliveMs: 60000 } } : {}),
          timeout: 30000,
          transportFactory: async (url, options) => {
            handshakes++;
            return nativeTransport(url, options);
          },
        });
        const page = await browser.page();
        await page.setViewport({ width: 1280, height: 720 });
        const fixture = new URL('/cloudflare-conformance.html', origin);
        fixture.searchParams.set('childOrigin', new URL(cross).origin);
        evidence.stage = 'navigation';
        await page.goto(fixture.href, { timeout: 30000 });
        assert.equal(await page.text('#identity'), 'Parent fixture v1');
        evidence.stage = 'parent input and click';
        await page.fill('#value', 'parent-only', { timeout: 5000 });
        await page.click('#click', { timeout: 5000 });
        assert.equal(await page.text('#count'), '1');
        evidence.stage = 'SPA transition';
        await page.click('#route', { timeout: 5000 });
        await page.waitFor('#spa-ready', { timeout: 5000 });
        assert.equal(await page.text('#spa-ready'), 'Next content v1');
        evidence.stage = 'cross-origin child';
        await page.switchToFrame('#child', { timeout: 10000 });
        assert.equal(await page.text('#identity'), 'Child fixture v1');
        await page.fill('#value', 'child-only', { timeout: 5000 });
        await page.switchToMain();
        assert.equal(await page.evaluate('document.querySelector("#value").value'), 'parent-only');
        assert.equal(await page.text('#child-result'), 'child-only');
        evidence.stage = 'screenshot';
        const png = Buffer.from(await page.screenshot({ format: 'png' }), 'base64');
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        const screenshot = `${engine}-${iteration}.png`;
        await writeFile(join(directory, screenshot), png);
        evidence.screenshot = screenshot;
        evidence.inputEvents = await page.evaluate('window.events');
        page.capabilities.record(
          'fixture-parent-child-input',
          {
            state: 'verified',
            probeVersion: 'cloudflare-conformance-v1',
            observedAt: new Date().toISOString(),
            evidence:
              'Parent and exact child values verified, parent remained untouched, PNG signature verified',
          },
          page.documentGeneration
        );
        evidence.capabilities = page.capabilities.report(page.documentGeneration);
        evidence.visibility = await page.evaluate('document.visibilityState');
        evidence.revision = browser.metadata.revision;
        evidence.generation = browser.metadata.browserGeneration;
        evidence.targetId = page.targetId;
        evidence.status = 'pass';
      } catch (error) {
        // Avoid arbitrary provider error text or credential-bearing endpoints in reports.
        if (error.capability === 'allocation_unknown') unresolvedAllocation = true;
        if (
          allocations > 0 &&
          !browser &&
          ['deadline', 'cancelled'].includes(error.capability) &&
          error.providerCleanup?.status !== 'released'
        )
          unresolvedAllocation = true;
        if (error.providerCleanup) {
          if (error.providerCleanup.status === 'cleanup_pending') unresolvedAllocation = true;
          evidence.cleanup = {
            status: error.providerCleanup.status,
            sessionId: error.providerCleanup.sessionId,
            providerStatus: error.providerCleanup.providerStatus,
          };
        }
        evidence.failure = {
          name: error.name,
          code: error.code ?? error.capability ?? 'assertion_or_protocol',
        };
      } finally {
        if (browser) {
          try {
            evidence.cleanup = await browser.close();
          } catch (error) {
            evidence.cleanup = {
              status: 'cleanup_pending',
              sessionId: browser.metadata.sessionId,
              failure: { name: error.name, code: error.code ?? error.capability ?? 'cleanup' },
            };
          }
          if (!['released', 'already_released', 'terminated'].includes(evidence.cleanup?.status)) {
            unresolvedAllocation = true;
            evidence.status = 'fail';
          }
        }
        globalThis.fetch = nativeFetch;
        evidence.allocations = allocations;
        evidence.handshakes = handshakes;
        evidence.elapsedMs = Date.now() - started;
        report.scenarios.push(evidence);
      }
    }
  }
}
await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    report: join(directory, 'report.json'),
    outcomes: report.scenarios.map(({ engine, iteration, status }) => ({
      engine,
      iteration,
      status,
    })),
  })
);
process.exitCode = report.scenarios.every((result) => result.status === 'pass') ? 0 : 1;
