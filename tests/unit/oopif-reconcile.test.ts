import { describe, expect, it, mock } from 'bun:test';
import { Page } from '../../src/browser/page.ts';
import type { CDPClient } from '../../src/cdp/client.ts';

/**
 * Unit coverage for {@link Page}'s daemon-gap reconciliation
 * (`reconcileExistingOopifTargets`, fix #4): on a shared/long-lived CDP
 * connection, `Target.setAutoAttach` does NOT re-emit `Target.attachedToTarget`
 * for targets that were ALREADY attached before this page armed auto-attach.
 * `reconcileExistingOopifTargets` enumerates `Target.getTargets()` and
 * registers any already-attached iframe targets that belong to THIS page's own
 * frame tree via the same `handleTargetAttached` path a live attach event uses.
 *
 * Drives a mock CDP client with pre-attached iframe targets (both a foreign
 * one belonging to another page's frame tree, and one belonging to this
 * page's own frame tree) and asserts:
 *  - the OWN-tree iframe is registered in `oopifFrames` via `handleTargetAttached`
 *    (Page.enable/DOM.enable/Runtime.enable are called on its session).
 *  - the foreign iframe (not in this page's frame tree) is excluded.
 */

interface MockOptions {
  /** iframe target ids reported by `Target.getTargets`, keyed by attached flag. */
  targets: Array<{ targetId: string; attached: boolean }>;
  /** frame ids that belong to THIS page's own frame tree (`Page.getFrameTree`). */
  ownFrameIds: string[];
}

function createMockCDPClient(opts: MockOptions): {
  client: CDPClient;
  enabledSessions: Set<string>;
  attachedTargetIds: string[];
} {
  const enabledSessions = new Set<string>();
  const attachedTargetIds: string[] = [];

  const client: CDPClient = {
    send: mock((method: string, _params?: Record<string, unknown>, sessionId?: string | null) => {
      if (
        method === 'Page.enable' ||
        method === 'DOM.enable' ||
        method === 'Runtime.enable' ||
        method === 'Network.enable' ||
        method === 'Page.stopLoading' ||
        method === 'Page.setLifecycleEventsEnabled'
      ) {
        if (sessionId) enabledSessions.add(sessionId);
        return Promise.resolve({});
      }
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        return Promise.resolve({ identifier: '1' });
      }
      if (method === 'DOM.getDocument') {
        return Promise.resolve({ root: { nodeId: 1 } });
      }
      if (method === 'Runtime.evaluate') {
        return Promise.resolve({ result: { value: null } });
      }
      if (method === 'Target.getTargets') {
        return Promise.resolve({
          targetInfos: opts.targets.map((t) => ({
            targetId: t.targetId,
            type: 'iframe',
            url: `https://child.example/${t.targetId}`,
            attached: t.attached,
          })),
        });
      }
      if (method === 'Page.getFrameTree') {
        return Promise.resolve({
          frameTree: {
            frame: { id: 'top-frame' },
            childFrames: opts.ownFrameIds.map((id) => ({ frame: { id } })),
          },
        });
      }
      return Promise.resolve({});
    }) as CDPClient['send'],
    on: mock(() => {}),
    off: mock(() => {}),
    onSessionEvent: mock(() => () => {}),
    onAny: mock(() => {}),
    offAny: mock(() => {}),
    onTargetAttached: mock(() => () => {}),
    close: mock(() => Promise.resolve()),
    attachToTarget: mock((targetId: string) => {
      attachedTargetIds.push(targetId);
      return Promise.resolve(`session-for-${targetId}`);
    }),
    setAutoAttach: mock(() => Promise.resolve()),
    runIfWaitingForDebugger: mock(() => Promise.resolve()),
    sessions: new Set<string>(),
    hasSession: mock(() => true),
    sessionId: 'test-session',
    setSessionId: mock(() => {}),
    isConnected: true,
  };
  return { client, enabledSessions, attachedTargetIds };
}

/** Read the private `oopifFrames` registry for assertions. */
function oopifFrameIds(page: Page): string[] {
  const frames = (
    page as unknown as { oopifFrames: Map<string, { sessionId: string; targetId: string }> }
  ).oopifFrames;
  return [...frames.keys()];
}

describe('OOPIF daemon-gap reconciliation (fix #4)', () => {
  it('registers an already-attached iframe target that belongs to this page\u2019s own frame tree', async () => {
    const { client, enabledSessions } = createMockCDPClient({
      targets: [{ targetId: 'own-iframe', attached: true }],
      ownFrameIds: ['own-iframe'],
    });

    const page = new Page(client, 'target-1');
    await page.init();

    expect(oopifFrameIds(page)).toContain('own-iframe');
    // handleTargetAttached enables Page/DOM/Runtime on the resolved session.
    expect(enabledSessions.has('session-for-own-iframe')).toBe(true);
  });

  it('excludes an already-attached iframe target that belongs to ANOTHER page\u2019s frame tree', async () => {
    const { client } = createMockCDPClient({
      targets: [{ targetId: 'foreign-iframe', attached: true }],
      // This page's own frame tree does NOT include foreign-iframe.
      ownFrameIds: [],
    });

    const page = new Page(client, 'target-1');
    await page.init();

    expect(oopifFrameIds(page)).not.toContain('foreign-iframe');
  });

  it('resolves the session for an already-attached target via attachToTarget (re-attach is a no-op)', async () => {
    const { client, attachedTargetIds } = createMockCDPClient({
      targets: [{ targetId: 'own-iframe', attached: true }],
      ownFrameIds: ['own-iframe'],
    });

    const page = new Page(client, 'target-1');
    await page.init();

    expect(attachedTargetIds).toContain('own-iframe');
  });

  it('attaches (not just resolves) a NOT-yet-attached own-tree iframe target', async () => {
    const { client, enabledSessions } = createMockCDPClient({
      targets: [{ targetId: 'own-iframe-unattached', attached: false }],
      ownFrameIds: ['own-iframe-unattached'],
    });

    const page = new Page(client, 'target-1');
    await page.init();

    expect(oopifFrameIds(page)).toContain('own-iframe-unattached');
    expect(enabledSessions.has('session-for-own-iframe-unattached')).toBe(true);
  });

  it('does not double-register the executionContextCreated session listener when a target is later re-seen via a live attach event', async () => {
    const { client } = createMockCDPClient({
      targets: [{ targetId: 'own-iframe', attached: true }],
      ownFrameIds: ['own-iframe'],
    });
    const onSessionEventCalls: string[] = [];
    (client.onSessionEvent as ReturnType<typeof mock>).mockImplementation(
      (sessionId: string, event: string) => {
        onSessionEventCalls.push(`${sessionId}:${event}`);
        return () => {};
      }
    );

    const page = new Page(client, 'target-1');
    await page.init();
    const countAfterReconcile = onSessionEventCalls.length;
    expect(countAfterReconcile).toBeGreaterThan(0);

    // Simulate the SAME session being reported again via the live-attach path
    // (handleTargetAttached is private; invoke it the same way the `onAny`
    // firehose handler does).
    await (
      page as unknown as {
        handleTargetAttached: (info: {
          sessionId: string;
          targetInfo: { type: string; url: string; targetId: string };
          waitingForDebugger: boolean;
          parentSessionId?: string;
        }) => Promise<void>;
      }
    ).handleTargetAttached({
      sessionId: 'session-for-own-iframe',
      targetInfo: {
        type: 'iframe',
        url: 'https://child.example/own-iframe',
        targetId: 'own-iframe',
      },
      waitingForDebugger: false,
      parentSessionId: 'test-session',
    });

    // No additional onSessionEvent registrations for the same session — the
    // guard in `handleTargetAttached` must have skipped it.
    expect(onSessionEventCalls.length).toBe(countAfterReconcile);
  });
});
