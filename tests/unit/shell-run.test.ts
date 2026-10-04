import { expect, test } from 'bun:test';
import { runBp } from '../../src/shell/app.ts';
import type { BrowserPilotShellPorts } from '../../src/shell/types.ts';

function fixture(action = true) {
  let acquisitions = 0;
  const ctx = {
    generation: 'fixture',
    signal: new AbortController().signal,
    clock: { now: Date.now, sleep: async () => {} },
  };
  const ports: BrowserPilotShellPorts = {
    sessionOwner: {
      async open() {
        throw new Error('unexpected allocation');
      },
      async acquire() {
        acquisitions++;
        throw new Error('unexpected acquisition');
      },
      async inspect() {
        throw new Error('unexpected inspection');
      },
      async release() {
        throw new Error('unexpected release');
      },
    },
    clock: ctx.clock,
    createContext: () => ctx,
    capabilities: { read: true, action, evaluate: true, webmcp: false },
  };
  const handle = JSON.stringify({ id: 'fixture', provider: 'generic', generation: 'fixture' });
  return { ports, handle, count: () => acquisitions };
}
const io = { stdin: '', readFile: async () => '' };
const unexpectedConnect = async () => {
  throw new Error('unexpected reconnect');
};

test('shell run denies action capability before acquiring a browser', async () => {
  const { ports, handle, count } = fixture(false);
  const result = await runBp(
    ['run', handle, '[{"action":"click","selector":"#pay"}]'],
    io,
    ports,
    unexpectedConnect
  );
  expect(result.exitCode).toBe(3);
  expect(count()).toBe(0);
});

test('shell run rejects malformed steps and binary output before acquiring a browser', async () => {
  const { ports, handle, count } = fixture();
  for (const input of ['{}', '[{"action":"fill"}]', '[{"action":"screenshot"}]']) {
    const result = await runBp(['run', handle, input], io, ports, unexpectedConnect);
    expect(result.exitCode).toBe(2);
  }
  expect(count()).toBe(0);
});
