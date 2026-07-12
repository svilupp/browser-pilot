import { describe, expect, it, mock } from 'bun:test';
import { Page } from '../../src/browser/page.ts';
import type { CDPClient } from '../../src/cdp/client.ts';

/**
 * Unit coverage for Page lifecycle + OOPIF attach-fan-out safety, driven by a
 * mock CDP client whose `onAny` firehose can be replayed by the test:
 *
 * - BUG A: a discarded Page must unsubscribe its connection-global `onAny`
 *   handler (via `dispose()` / `close()`) so it stops reacting to target
 *   lifecycle events on a long-lived connection.
 * - BUG B: `onAny` is connection-global; a Page must only run domain-enables /
 *   registry writes / nested auto-attach for children of ITS OWN sessions
 *   (pinned session or a known child session), never another page's iframes.
 * - BUG C: when the active OOPIF child session detaches, the page must fall all
 *   the way back to the top-level document (clear rootNodeId + frame state), not
 *   just clear `currentFrameSession`.
 */

type AnyHandler = (method: string, params: Record<string, unknown>, sessionId?: string) => void;

interface MockClient {
  client: CDPClient;
  anyHandlers: AnyHandler[];
  offAnyCalls: AnyHandler[];
  sends: Array<{ method: string; sessionId?: string | null }>;
  autoAttachSessions: Array<string | null | undefined>;
  unpaused: string[];
  liveSessions: Set<string>;
}

function createMockCDPClient(pinnedSessionId = 'page-A-session'): MockClient {
  const anyHandlers: AnyHandler[] = [];
  const offAnyCalls: AnyHandler[] = [];
  const sends: Array<{ method: string; sessionId?: string | null }> = [];
  const autoAttachSessions: Array<string | null | undefined> = [];
  const unpaused: string[] = [];
  const liveSessions = new Set<string>();

  const client: CDPClient = {
    send: mock((method: string, _params?: Record<string, unknown>, sessionId?: string | null) => {
      sends.push({ method, sessionId });
      if (method === 'DOM.getDocument') return Promise.resolve({ root: { nodeId: 1 } });
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: null } });
      if (method === 'Page.addScriptToEvaluateOnNewDocument')
        return Promise.resolve({ identifier: '1' });
      return Promise.resolve({});
    }) as CDPClient['send'],
    on: mock(() => {}),
    off: mock(() => {}),
    onSessionEvent: mock(() => () => {}),
    onAny: mock((handler: AnyHandler) => {
      anyHandlers.push(handler);
    }),
    offAny: mock((handler: AnyHandler) => {
      offAnyCalls.push(handler);
      const idx = anyHandlers.indexOf(handler);
      if (idx >= 0) anyHandlers.splice(idx, 1);
    }),
    onTargetAttached: mock(() => () => {}),
    close: mock(() => Promise.resolve()),
    attachToTarget: mock(() => Promise.resolve('session-id')),
    setAutoAttach: mock((opts?: { sessionId?: string | null }) => {
      autoAttachSessions.push(opts?.sessionId);
      return Promise.resolve();
    }),
    runIfWaitingForDebugger: mock((sessionId: string) => {
      unpaused.push(sessionId);
      return Promise.resolve();
    }),
    sessions: liveSessions,
    hasSession: mock((sid: string) => liveSessions.has(sid)),
    sessionId: pinnedSessionId,
    setSessionId: mock(() => {}),
    isConnected: true,
  };

  return { client, anyHandlers, offAnyCalls, sends, autoAttachSessions, unpaused, liveSessions };
}

function emitAttach(
  handlers: AnyHandler[],
  opts: {
    childSessionId: string;
    parentSessionId?: string;
    targetId: string;
    type?: string;
    waitingForDebugger?: boolean;
  }
): void {
  const params = {
    sessionId: opts.childSessionId,
    targetInfo: {
      type: opts.type ?? 'iframe',
      url: 'http://child.example',
      targetId: opts.targetId,
    },
    waitingForDebugger: opts.waitingForDebugger ?? true,
  };
  for (const h of [...handlers]) h('Target.attachedToTarget', params, opts.parentSessionId);
}

function emitDetach(handlers: AnyHandler[], childSessionId: string): void {
  for (const h of [...handlers]) h('Target.detachedFromTarget', { sessionId: childSessionId });
}

function oopifFrames(page: Page): Map<string, { sessionId: string }> {
  return (page as unknown as { oopifFrames: Map<string, { sessionId: string }> }).oopifFrames;
}
function currentFrameSession(page: Page): string | null {
  return (page as unknown as { currentFrameSession: string | null }).currentFrameSession;
}
function rootNodeId(page: Page): number | null {
  return (page as unknown as { rootNodeId: number | null }).rootNodeId;
}

// Flush the microtasks queued by the async handleTargetAttached fired from onAny.
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('Page.dispose / close (BUG A: listener leak)', () => {
  it('unsubscribes the connection-global onAny handler on dispose()', async () => {
    const mockClient = createMockCDPClient();
    const page = new Page(mockClient.client, 'target-A');
    await page.init();
    expect(mockClient.anyHandlers.length).toBe(1);

    page.dispose();

    expect(mockClient.offAnyCalls.length).toBe(1);
    expect(mockClient.anyHandlers.length).toBe(0);
  });

  it('close() disposes and is idempotent', async () => {
    const mockClient = createMockCDPClient();
    const page = new Page(mockClient.client, 'target-A');
    await page.init();

    await page.close();
    await page.close();
    page.dispose();

    // offAny called exactly once despite multiple close/dispose calls.
    expect(mockClient.offAnyCalls.length).toBe(1);
  });

  it('a disposed page ignores later attach events (no registry writes)', async () => {
    const mockClient = createMockCDPClient();
    const page = new Page(mockClient.client, 'target-A');
    await page.init();
    page.dispose();

    // Re-attach the (now-removed) handler manually to simulate a stale delivery.
    mockClient.anyHandlers.push(mockClient.offAnyCalls[0]!);
    emitAttach(mockClient.anyHandlers, {
      childSessionId: 'child-1',
      parentSessionId: 'page-A-session',
      targetId: 'frame-1',
    });
    await flush();

    expect(oopifFrames(page).size).toBe(0);
  });
});

describe('Page OOPIF attach fan-out (BUG B: cross-page isolation)', () => {
  it('registers a child whose parent is this page pinned session', async () => {
    const mockClient = createMockCDPClient('page-A-session');
    const page = new Page(mockClient.client, 'target-A');
    await page.init();

    emitAttach(mockClient.anyHandlers, {
      childSessionId: 'child-A1',
      parentSessionId: 'page-A-session',
      targetId: 'frame-A1',
    });
    await flush();

    expect(oopifFrames(page).get('frame-A1')?.sessionId).toBe('child-A1');
  });

  it('ignores a child belonging to ANOTHER page but still unpauses it', async () => {
    const mockClient = createMockCDPClient('page-A-session');
    const page = new Page(mockClient.client, 'target-A');
    await page.init();

    const sendsBefore = mockClient.sends.length;
    emitAttach(mockClient.anyHandlers, {
      childSessionId: 'child-B1',
      parentSessionId: 'page-B-session', // foreign parent
      targetId: 'frame-B1',
    });
    await flush();

    // No registry pollution and no domain-enable command storm for foreign frame.
    expect(oopifFrames(page).has('frame-B1')).toBe(false);
    const enablesForChild = mockClient.sends
      .slice(sendsBefore)
      .filter((s) => s.sessionId === 'child-B1');
    expect(enablesForChild.length).toBe(0);
    // But the waiting foreign target is still released so nothing stalls.
    expect(mockClient.unpaused).toContain('child-B1');
  });

  it('registers a nested child whose parent is a KNOWN child session', async () => {
    const mockClient = createMockCDPClient('page-A-session');
    const page = new Page(mockClient.client, 'target-A');
    await page.init();

    // First level: direct child of the page.
    emitAttach(mockClient.anyHandlers, {
      childSessionId: 'child-A1',
      parentSessionId: 'page-A-session',
      targetId: 'frame-A1',
    });
    await flush();
    // Nested: grandchild attaches under child-A1.
    emitAttach(mockClient.anyHandlers, {
      childSessionId: 'grandchild-A2',
      parentSessionId: 'child-A1',
      targetId: 'frame-A2',
    });
    await flush();

    expect(oopifFrames(page).get('frame-A2')?.sessionId).toBe('grandchild-A2');
  });

  it('arms auto-attach on the page pinned session explicitly (BUG D)', async () => {
    const mockClient = createMockCDPClient('page-A-session');
    const page = new Page(mockClient.client, 'target-A');
    await page.init();

    // init armed auto-attach with the explicit pinned id, never undefined.
    expect(mockClient.autoAttachSessions).toContain('page-A-session');
    expect(mockClient.autoAttachSessions).not.toContain(undefined);
  });
});

describe('Page foreground behavior', () => {
  it('does not activate the tab during init', async () => {
    const mockClient = createMockCDPClient();
    const page = new Page(mockClient.client, 'target-A');
    await page.init();

    expect(mockClient.sends.some((s) => s.method === 'Page.bringToFront')).toBe(false);
  });
});

describe('Page OOPIF detach (BUG C: stale frame state)', () => {
  it('full reset when the ACTIVE frame session detaches', async () => {
    const mockClient = createMockCDPClient('page-A-session');
    const page = new Page(mockClient.client, 'target-A');
    await page.init();

    emitAttach(mockClient.anyHandlers, {
      childSessionId: 'child-A1',
      parentSessionId: 'page-A-session',
      targetId: 'frame-A1',
    });
    await flush();

    // Simulate the active frame being the OOPIF, with a cached rootNodeId.
    (page as unknown as { currentFrameSession: string | null }).currentFrameSession = 'child-A1';
    (page as unknown as { rootNodeId: number | null }).rootNodeId = 42;

    emitDetach(mockClient.anyHandlers, 'child-A1');

    // Full fall-back to top-level: not just currentFrameSession cleared.
    expect(currentFrameSession(page)).toBe(null);
    expect(rootNodeId(page)).toBe(null);
    expect(oopifFrames(page).has('frame-A1')).toBe(false);
  });

  it('non-active frame detach drops only its registry entry', async () => {
    const mockClient = createMockCDPClient('page-A-session');
    const page = new Page(mockClient.client, 'target-A');
    await page.init();

    emitAttach(mockClient.anyHandlers, {
      childSessionId: 'child-A1',
      parentSessionId: 'page-A-session',
      targetId: 'frame-A1',
    });
    await flush();

    (page as unknown as { currentFrameSession: string | null }).currentFrameSession = 'child-A1';
    (page as unknown as { rootNodeId: number | null }).rootNodeId = 42;

    // A DIFFERENT (non-active) session detaches.
    emitDetach(mockClient.anyHandlers, 'some-other-session');

    // Active state untouched.
    expect(currentFrameSession(page)).toBe('child-A1');
    expect(rootNodeId(page)).toBe(42);
    expect(oopifFrames(page).has('frame-A1')).toBe(true);
  });
});
