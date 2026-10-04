import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from 'chrome-launcher';
import { createNodeTransportFactory } from '../../src/adapters/node/transport.ts';
import { connect, getBrowserWebSocketUrl } from '../../src/index.ts';

const requests = [];
const server = createServer((request, response) => {
  requests.push(request.url);
  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><form action="/submitted" method="get">
    <input id="query" name="query"><button>Search</button></form>
    <textarea id="notes"></textarea><script>
    window.keys=[];
    document.addEventListener('keydown',e=>keys.push({key:e.key,control:e.ctrlKey,meta:e.metaKey,alt:e.altKey,shift:e.shiftKey,trusted:e.isTrusted}));
    </script>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'bp-keyboard-native-'));
let chrome;
let browser;
let page;
try {
  chrome = await launch({
    userDataDir: profile,
    chromeFlags: ['--headless=new', '--no-first-run', '--no-default-browser-check'],
    logLevel: 'silent',
  });
  browser = await connect({
    provider: 'generic',
    wsUrl: await getBrowserWebSocketUrl(`http://127.0.0.1:${chrome.port}`),
    transportFactory: await createNodeTransportFactory(),
  });
  page = await browser.newPage();
  await page.goto(baseUrl);
  await page.fill('#query', 'Ada Lovelace');
  await page.press('Enter');
  const deadline = Date.now() + 5000;
  while (!requests.includes('/submitted?query=Ada+Lovelace') && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    requests.includes('/submitted?query=Ada+Lovelace'),
    'Enter must perform native GET form submission'
  );
  await page.waitFor('#notes');
  await page.fill('#notes', 'first');
  await page.press('Enter');
  assert.equal(await page.evaluate('document.querySelector("#notes").value'), 'first\n');
  await page.press('Enter', { modifiers: ['Shift'] });
  assert.equal(await page.evaluate('document.querySelector("#notes").value'), 'first\n\n');
  for (const modifier of ['Control', 'Meta', 'Alt']) {
    await page.press('Enter', { modifiers: [modifier] });
    assert.equal(
      await page.evaluate('document.querySelector("#notes").value'),
      'first\n\n',
      `${modifier}+Enter must preserve command-key text suppression`
    );
  }
  const keys = await page.evaluate('keys.filter(e=>e.key==="Enter")');
  assert.deepEqual(
    keys.map((event) => [event.shift, event.control, event.meta, event.alt, event.trusted]),
    [
      [false, false, false, false, true],
      [true, false, false, false, true],
      [false, true, false, false, true],
      [false, false, true, false, true],
      [false, false, false, true, true],
    ]
  );
  console.log(
    'Native Enter form submission, textarea newline, Shift+Enter and command modifiers passed'
  );
} finally {
  if (page && browser) {
    const targetId = page.targetId;
    await page.close();
    await browser.cdpClient.send('Target.closeTarget', { targetId }, null);
    assert.equal(
      (await browser.listTargets()).some((target) => target.targetId === targetId),
      false
    );
  }
  await browser?.close();
  await Promise.resolve(chrome?.kill());
  await rm(profile, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
}
