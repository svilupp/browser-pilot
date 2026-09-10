// Consumer regression checks run from inside the extracted npm package.
import assert from 'node:assert/strict';
import { InProcessSessionOwner, nodeClock } from 'browser-pilot/adapters/node';
import { BrowserUseProvider } from 'browser-pilot/core';
import { registerBrowserPilotCommands } from 'browser-pilot/just-bash';

// Resolve the optional peer from the development checkout, not production deps.
const { Bash } = await import(process.argv[2]);
const handle = JSON.stringify({ id: 'test', generation: 'test', provider: 'generic' });
const syntheticKey = 'packed-synthetic-private-key';
const originalFetch = globalThis.fetch;
function shell({
  maxOutputBytes = 4096,
  text = 'x'.repeat(100),
  sessionOwner,
  artifacts,
  controller = new AbortController(),
} = {}) {
  return new Bash({
    defenseInDepth: false,
    customCommands: registerBrowserPilotCommands({
      clock: nodeClock,
      createContext: () => ({ signal: controller.signal, generation: 'test', clock: nodeClock }),
      capabilities: { read: true, action: true, evaluate: true, webmcp: true },
      limits: { maxOutputBytes },
      sessionOwner: sessionOwner ?? { resolve: async () => ({ wsUrl: 'ws://fixture.invalid' }) },
      artifacts,
      connect: async () => ({
        page: async () => ({ text: async () => text, screenshot: async () => 'AQID' }),
        disconnect: async () => {},
      }),
    }),
  });
}

try {
  for (const maxOutputBytes of [32, 64]) {
    const bash = shell({ maxOutputBytes });
    const result = await bash.exec(`set -o pipefail; bp text '${handle}' | jq .`);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), { error: 'output_limit' });
    assert.ok(Buffer.byteLength(result.stderr) <= maxOutputBytes);
  }
  const text = 'Hello 🌍 世界'.repeat(100);
  const complete = await shell({ text }).exec(
    `bp text '${handle}' | jq . > /page.json && cat /page.json`
  );
  assert.equal(complete.exitCode, 0);
  assert.equal(JSON.parse(complete.stdout).text, text);

  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const bash = shell({
      controller,
      artifacts: {
        put: async () => {
          if (cancelled) controller.abort();
          return {
            status: 'write_pending_after_deadline',
            ref: 'memory://shot.png',
            path: 'shot.png',
            error: 'pending write',
          };
        },
      },
    });
    const result = await bash.exec(
      `bp screenshot '${handle}' --out shot.png && echo SHOULD_NOT_RUN`
    );
    assert.equal(result.exitCode, cancelled ? 130 : 124);
    assert.equal(JSON.parse(result.stdout).status, 'write_pending_after_deadline');
    assert.ok(!result.stdout.includes('SHOULD_NOT_RUN'));
  }

  const secrets = { get: () => syntheticKey };
  const browserless = await shell({ sessionOwner: new InProcessSessionOwner({ secrets }) }).exec(
    'bp session open --provider browserless && echo SHOULD_NOT_RUN'
  );
  assert.equal(browserless.exitCode, 3);
  assert.equal(JSON.parse(browserless.stderr).capability, 'session-reconnect');
  assert.equal(browserless.stdout, '');

  let creates = 0;
  globalThis.fetch = async (url, init) => {
    const session = {
      id: 'bb-session',
      projectId: syntheticKey,
      connectUrl: 'wss://fixture.invalid',
    };
    if (url.endsWith('/v1/sessions')) {
      creates++;
      assert.equal(JSON.parse(init.body).keepAlive, true);
      return Response.json({ ...session, status: 'RUNNING' });
    }
    return Response.json({ ...session, status: 'COMPLETED' });
  };
  const bbOwner = new InProcessSessionOwner({ secrets });
  const bbShell = shell({ sessionOwner: bbOwner });
  assert.equal(
    (await bbShell.exec('bp session open --provider browserbase > /bb.json')).exitCode,
    0
  );
  for (let i = 0; i < 2; i++) {
    assert.equal((await bbShell.exec('bp text --handle-file /bb.json')).exitCode, 0);
  }
  assert.equal(creates, 1);
  assert.equal((await bbShell.exec('bp session close --handle-file /bb.json')).exitCode, 0);
  assert.equal(bbOwner.size, 0);

  globalThis.fetch = async () =>
    Response.json({ token: syntheticKey, authorization: syntheticKey }, { status: 403 });
  const rejected = await shell({ sessionOwner: new InProcessSessionOwner({ secrets }) }).exec(
    'bp session open --provider browser-use'
  );
  assert.equal(rejected.exitCode, 1);
  assert.ok(rejected.stderr.includes('HTTP 403'));
  assert.ok(!rejected.stderr.includes(syntheticKey));
  await assert.rejects(
    new BrowserUseProvider({ apiKey: syntheticKey }).resumeSession('test'),
    (error) => error.message.includes('HTTP 403') && !error.message.includes(syntheticKey)
  );

  for (const failure of ['http', 'network']) {
    let stopCalls = 0;
    const session = { id: 'session', status: 'active', cdpUrl: 'wss://fixture.invalid' };
    globalThis.fetch = async (_url, init) => {
      if (init?.method === 'POST') return Response.json(session);
      if (++stopCalls === 1) {
        if (failure === 'network') throw new Error(syntheticKey);
        return Response.json({ token: syntheticKey }, { status: 500 });
      }
      return Response.json({ ...session, status: 'stopped' });
    };
    const owner = new InProcessSessionOwner({ secrets });
    const bash = shell({ sessionOwner: owner });
    assert.equal(
      (await bash.exec('bp session open --provider browser-use > /session.json')).exitCode,
      0
    );
    const pending = await bash.exec(
      'bp session close --handle-file /session.json && echo SHOULD_NOT_RUN'
    );
    assert.equal(pending.exitCode, 1);
    assert.equal(JSON.parse(pending.stdout).status, 'cleanup_pending');
    assert.ok(!pending.stdout.includes(syntheticKey));
    assert.equal(owner.size, 1);
    const retry = await bash.exec('bp session close --handle-file /session.json');
    assert.equal(retry.exitCode, 0);
    assert.equal(JSON.parse(retry.stdout).status, 'released');
    assert.equal(owner.size, 0);
    assert.equal(stopCalls, 2);
  }
} finally {
  globalThis.fetch = originalFetch;
}
console.log(
  'package command smoke passed: intact pipes, pending receipts, provider lifecycle, credential-safe errors, and retryable cleanup'
);
