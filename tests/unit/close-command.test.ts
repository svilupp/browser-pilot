import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const deleteCalls: string[] = [];

let sessionToLoad: {
  id: string;
  provider: string;
  wsUrl: string;
  createdAt: string;
  lastActivity: string;
  currentUrl: string;
  providerSessionId?: string;
};

const actualSessionModule = await import(
  new URL('../../src/cli/session.ts?actual', import.meta.url).href
);

mock.module('../../src/cli/session.ts', () => ({
  ...actualSessionModule,
  loadSession: (id: string) => {
    if (id !== sessionToLoad.id) throw new Error(`Session not found: ${id}`);
    return Promise.resolve(sessionToLoad);
  },
  getDefaultSession: () => Promise.resolve(sessionToLoad),
  deleteSession: (id: string) => {
    deleteCalls.push(id);
    return Promise.resolve();
  },
}));

// These fixture sessions never set `transport`, so closeCommand's daemon
// branches (countSessionReferences/readDaemonDescriptor/daemonControlMatches/
// stopDaemon/removeDaemonDescriptor) are unreachable and don't need mocking.
// mock.module() leaks process-globally in Bun, so avoid it here entirely
// rather than risk breaking daemon.test.ts when both files run together.

const { closeCommand } = await import('../../src/cli/commands/close.ts');

async function captureJsonOutput(fn: () => Promise<void>): Promise<Record<string, unknown>> {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    return true;
  }) as typeof process.stdout.write;

  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }

  return JSON.parse(out) as Record<string, unknown>;
}

describe('bp close --force', () => {
  const STUCK_SESSION_ID = `bp-close-stuck-${Date.now()}`;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    deleteCalls.length = 0;
    originalApiKey = process.env['BROWSERBASE_API_KEY'];
    delete process.env['BROWSERBASE_API_KEY'];
    sessionToLoad = {
      id: STUCK_SESSION_ID,
      provider: 'browserbase',
      wsUrl: 'wss://fixture.invalid/session',
      createdAt: new Date(0).toISOString(),
      lastActivity: new Date(0).toISOString(),
      currentUrl: 'about:blank',
    };
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env['BROWSERBASE_API_KEY'];
    else process.env['BROWSERBASE_API_KEY'] = originalApiKey;
  });

  test('without --force, a keyless browserbase session throws and keeps the local record', async () => {
    await expect(closeCommand([STUCK_SESSION_ID], { format: 'json' })).rejects.toThrow(
      /BROWSERBASE_API_KEY/
    );
    expect(deleteCalls).toEqual([]);
  });

  test('--force deletes the local record without provider release and warns', async () => {
    const payload = await captureJsonOutput(() =>
      closeCommand([STUCK_SESSION_ID, '--force'], { format: 'json' })
    );

    expect(deleteCalls).toEqual([STUCK_SESSION_ID]);
    expect(payload['success']).toBe(true);
    expect(payload['warning']).toBe(
      'Browserbase session was not released; only the local record was removed (--force).'
    );
    expect(payload['message']).toContain('--force');
  });
});
