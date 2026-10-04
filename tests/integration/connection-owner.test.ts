import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createNodeTransportFactory } from '../../src/adapters/node/transport.ts';
import { Browser } from '../../src/browser/browser.ts';
import { ConnectionSessionOwner } from '../../src/core/sessions/owner.ts';
import { createTestHarness, destroyHarness, type TestHarness } from '../utils/harness.ts';

let harness: TestHarness;
let browser: Browser;
beforeAll(async () => {
  harness = await createTestHarness();
  browser = await Browser.connect({
    provider: 'generic',
    wsUrl: harness.browser.wsUrl,
    transportFactory: await createNodeTransportFactory(),
  });
});
afterAll(async () => {
  await browser?.disconnect();
  if (harness) await destroyHarness(harness);
});

test('workers created after a borrowed command finishes continue running', async () => {
  const owner = new ConnectionSessionOwner({ connect: async () => browser });
  const ctx = {
    generation: 'test',
    signal: new AbortController().signal,
    clock: { now: Date.now, sleep: (ms: number) => Bun.sleep(ms) },
  };
  const handle = await owner.open({ provider: 'generic', wsUrl: browser.wsUrl }, ctx);
  const observer = await harness.browser.page();
  for (let i = 0; i < 2; i++) {
    const lease = await owner.acquire(handle, ctx);
    try {
      const page = await lease.browser.page(undefined, { targetId: observer.targetId });
      await page.evaluate(`
        window.workerDone = false;
        setTimeout(() => {
          const url = URL.createObjectURL(new Blob(['postMessage(42)'], {type: 'text/javascript'}));
          const worker = new Worker(url);
          worker.onmessage = event => {
            window.workerDone = event.data === 42;
            worker.terminate();
            URL.revokeObjectURL(url);
          };
        }, 100);
        true
      `);
    } finally {
      await lease.detach();
    }
    const deadline = Date.now() + 3000;
    let done = false;
    while (!done && Date.now() < deadline) {
      done = await observer.evaluate<boolean>('window.workerDone === true');
      if (!done) await Bun.sleep(20);
    }
    expect(done).toBe(true);
  }
});

test('fresh default, filtered and enriched snapshots replace imported ref meanings', async () => {
  const page = await browser.newPage(`${harness.baseUrl}/index.html`);
  try {
    for (const options of [{}, { roles: ['button'] }, { attributes: true }]) {
      await page.evaluate(`
        document.body.innerHTML = '<button onclick="window.clicks++">Continue</button>';
        window.clicks = 0;
        true
      `);
      const old = await page.snapshot();
      page.importRefMap(page.exportRefMap(), page.exportRefSemantics());
      expect(old.interactiveElements.find((e) => e.name === 'Continue')).toBeDefined();
      await page.evaluate('document.querySelector("button").textContent = "Pay"');
      const fresh = await page.snapshot(options);
      const ref = fresh.interactiveElements.find((e) => e.name === 'Pay')?.ref;
      expect(ref).toBeDefined();
      await page.click(`ref:${ref}`);
      expect(await page.evaluate<number>('window.clicks')).toBe(1);
    }
  } finally {
    await browser.cdpClient.send('Target.closeTarget', { targetId: page.targetId }, null);
  }
});

test('a tab closing during a borrowed command does not turn detachment into a failure', async () => {
  const target = await browser.newPage('about:blank');
  const owner = new ConnectionSessionOwner({ connect: async () => browser });
  const ctx = {
    generation: 'closed-target',
    signal: new AbortController().signal,
    clock: { now: Date.now, sleep: (ms: number) => Bun.sleep(ms) },
  };
  const handle = await owner.open({ provider: 'generic', wsUrl: browser.wsUrl }, ctx);
  const lease = await owner.acquire(handle, ctx);
  try {
    await lease.browser.page(undefined, { targetId: target.targetId });
    await browser.cdpClient.send('Target.closeTarget', { targetId: target.targetId }, null);
  } finally {
    await lease.detach();
  }
  expect(browser.isConnected).toBe(true);
});
