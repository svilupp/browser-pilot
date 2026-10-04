import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from 'browser-pilot';
import { createNodeTransportFactory } from 'browser-pilot/adapters/node';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const server = new WebSocketServer({ port: 0 });
await new Promise((resolve) => server.once('listening', resolve));
const endpoint = `ws://127.0.0.1:${server.address().port}`;
let handshakes = 0;
server.on('connection', (socket, request) => {
  assert.equal(request.headers.authorization, 'Bearer fixture');
  handshakes++;
  socket.on('message', (raw) => {
    const request = JSON.parse(raw.toString());
    let result = {};
    if (request.method === 'Browser.getVersion')
      result = { product: 'Chrome/fixture', revision: '@fixture' };
    if (request.method === 'Target.getTargets')
      result = {
        targetInfos: [
          { targetId: 'page', type: 'page', title: 'Fixture', url: 'https://fixture.test' },
        ],
      };
    if (request.method === 'Target.attachToTarget') result = { sessionId: 'attached' };
    if (request.method === 'Runtime.evaluate')
      result = {
        result: {
          type: request.params.expression === 'document.title' ? 'string' : 'object',
          value: request.params.expression === 'document.title' ? 'Fixture' : { w: 1280, h: 720 },
        },
      };
    if (request.method === 'Page.captureScreenshot') result = { data: 'iVBORw0KGgo=' };
    socket.send(Buffer.from(JSON.stringify({ id: request.id, result })), { binary: true });
  });
});
let allocations = 0;
let releases = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer fixture');
  if (init.method === 'POST') {
    allocations++;
    return Response.json({
      sessionId: 'allocation',
      webSocketDebuggerUrl:
        'wss://api.cloudflare.com/client/v4/accounts/account/browser-run/devtools/browser/allocation',
    });
  }
  assert.equal(init.method, 'DELETE');
  releases++;
  return Response.json({ status: 'closed' });
};
try {
  for (const [format, library] of [
    ['esm', esm],
    ['cjs', require('browser-pilot')],
  ]) {
    const factory = await createNodeTransportFactory();
    const browser = await library.connect({
      provider: 'cloudflare',
      apiKey: 'fixture',
      cloudflare: { accountId: 'account' },
      transportFactory: (url, options) => {
        assert.equal(
          url,
          'wss://api.cloudflare.com/client/v4/accounts/account/browser-run/devtools/browser/allocation'
        );
        return factory(endpoint, options);
      },
    });
    assert.equal(browser.metadata.detectedEngine, 'chromium');
    const page = await browser.page();
    assert.equal(await page.title(), 'Fixture');
    assert.equal(await page.screenshot(), 'iVBORw0KGgo=');
    assert.equal((await browser.close()).status, 'released');
    console.log(
      JSON.stringify({
        runtime: process.version,
        format,
        status: 'pass',
        browserResponses: 'simulated',
      })
    );
  }
  assert.equal(allocations, 2);
  assert.equal(releases, 2);
  assert.equal(handshakes, 2);
} finally {
  globalThis.fetch = originalFetch;
  for (const socket of server.clients) socket.terminate();
  await new Promise((resolve) => server.close(resolve));
}
