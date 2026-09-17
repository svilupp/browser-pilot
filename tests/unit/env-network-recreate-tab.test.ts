import { afterAll, describe, expect, it, mock } from 'bun:test';
import type { SessionData } from '../../src/cli/session.ts';

// mock.module() leaks process-globally in Bun (see close-command.test.ts), so
// this suite lives in its own file rather than sharing env-network.test.ts.

const actualSessionModule = await import(
  new URL('../../src/cli/session.ts?actual', import.meta.url).href
);
const actualRegistryModule = await import(
  new URL('../../src/daemon/registry.ts?actual', import.meta.url).href
);

let fixtureSession: SessionData;
let referenceCount = 0;
const targetBindingCalls: unknown[] = [];

mock.module('../../src/cli/session.ts', () => ({
  ...actualSessionModule,
  loadSession: (id: string) => {
    if (id !== fixtureSession.id) throw new Error(`Session not found: ${id}`);
    return Promise.resolve(fixtureSession);
  },
  updateSessionTargetBinding: (
    _id: string,
    binding: { targetId: string; currentUrl: string; cdpSessionId?: string }
  ) => {
    targetBindingCalls.push(binding);
    fixtureSession = {
      ...fixtureSession,
      targetId: binding.targetId,
      currentUrl: binding.currentUrl,
      ...(fixtureSession.daemon && binding.cdpSessionId
        ? { daemon: { ...fixtureSession.daemon, cdpSessionId: binding.cdpSessionId } }
        : {}),
    };
    return Promise.resolve(fixtureSession);
  },
}));

mock.module('../../src/daemon/registry.ts', () => ({
  ...actualRegistryModule,
  countSessionReferences: () => Promise.resolve(referenceCount),
}));

const { recreateTab, validateNetworkOptions } = await import('../../src/cli/commands/env.ts');

// Defensive: restore the real modules once this file is done so a future
// test file sorting after this one (alphabetically) can't be silently
// poisoned by the stubbed loadSession/countSessionReferences above.
afterAll(() => {
  mock.module('../../src/cli/session.ts', () => actualSessionModule);
  mock.module('../../src/daemon/registry.ts', () => actualRegistryModule);
});

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: 'recreate-tab-session',
    provider: 'browserbase',
    wsUrl: 'ws://example.invalid',
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    currentUrl: 'https://example.com/',
    targetId: 'old-target',
    transport: { mode: 'daemon', daemonId: 'daemon-1' },
    daemon: { socketPath: '/tmp/x.sock', pid: 1, cdpSessionId: 'old-cdp-session' },
    ...overrides,
  } as SessionData;
}

function makeMockPage(calls: { method: string; params?: unknown }[], sessionId: string) {
  return {
    url: () => Promise.resolve('https://example.com/'),
    cdpClient: {
      sessionId,
      send: mock(async (method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method === 'Target.createTarget') return { targetId: 'new-target' };
        return {};
      }),
    },
  };
}

describe('validateNetworkOptions', () => {
  it('rejects --recreate-tab paired with throttle', () => {
    expect(() => validateNetworkOptions('throttle', { recreateTab: true } as never)).toThrow(
      /--recreate-tab is only valid with "network online"/
    );
  });

  it('rejects --recreate-tab paired with offline', () => {
    expect(() => validateNetworkOptions('offline', { recreateTab: true } as never)).toThrow(
      /--recreate-tab/
    );
  });

  it('allows --recreate-tab with online', () => {
    expect(() => validateNetworkOptions('online', { recreateTab: true } as never)).not.toThrow();
  });

  it('is a no-op when --recreate-tab is not set', () => {
    expect(() => validateNetworkOptions('throttle', {} as never)).not.toThrow();
  });
});

describe('recreateTab', () => {
  it('creates the new target before closing the old one, and re-pins the session', async () => {
    fixtureSession = makeSession();
    referenceCount = 0;
    targetBindingCalls.length = 0;

    const calls: { method: string; params?: unknown }[] = [];
    const page = makeMockPage(calls, 'old-cdp-session');
    const newPage = makeMockPage(calls, 'new-cdp-session');
    const browser = { page: () => Promise.resolve(newPage) };

    const result = await recreateTab(page as never, fixtureSession, browser as never);

    expect(result).toEqual({ oldTargetId: 'old-target', newTargetId: 'new-target' });

    const methods = calls.map((c) => c.method);
    const createIndex = methods.indexOf('Target.createTarget');
    const closeIndex = methods.indexOf('Target.closeTarget');
    expect(createIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeGreaterThan(createIndex);

    const closeCall = calls.find((c) => c.method === 'Target.closeTarget');
    expect(closeCall?.params).toMatchObject({ targetId: 'old-target' });

    expect(targetBindingCalls).toEqual([
      {
        targetId: 'new-target',
        currentUrl: 'https://example.com/',
        cdpSessionId: 'new-cdp-session',
      },
    ]);

    // Stale pinned session had no other referrers, so it must be detached.
    const detachCall = calls.find((c) => c.method === 'daemon.detach');
    expect(detachCall?.params).toEqual({ sessionId: 'old-cdp-session' });
  });

  it('does not detach the stale session when another logical session still references it', async () => {
    fixtureSession = makeSession();
    referenceCount = 1;
    targetBindingCalls.length = 0;

    const calls: { method: string; params?: unknown }[] = [];
    const page = makeMockPage(calls, 'old-cdp-session');
    const newPage = makeMockPage(calls, 'new-cdp-session');
    const browser = { page: () => Promise.resolve(newPage) };

    await recreateTab(page as never, fixtureSession, browser as never);

    const detachCall = calls.find((c) => c.method === 'daemon.detach');
    expect(detachCall).toBeUndefined();
  });
});
