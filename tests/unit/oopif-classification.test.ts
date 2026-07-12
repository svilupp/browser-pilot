import { describe, expect, it, mock } from 'bun:test';
import { Page } from '../../src/browser/page.ts';
import type { CDPClient } from '../../src/cdp/client.ts';

/**
 * Regression coverage for the cross-origin (OOPIF) `switchToFrame`
 * classification RACE (the "silent mis-resolution" bug).
 *
 * Root cause: same-origin vs cross-origin was decided by whether
 * `DOM.describeNode(iframe).contentDocument` was null. On a GENUINE OOPIF,
 * `describeNode` transiently returns a NON-NULL contentDocument during the brief
 * window before the cross-origin document commits to its own renderer. Keying
 * off contentDocument took the same-origin branch, failed to acquire an
 * execution context, set `brokenFrame`, and returned `true` with
 * `currentFrameSession` LEFT NULL — so every C1 guard went inert and a
 * subsequent action silently hit the PARENT look-alike.
 *
 * The fix classifies by the AUTHORITATIVE signal: a cross-origin CHILD SESSION
 * attached for the iframe's frameId (`oopifFrames` + `client.hasSession`), NOT
 * `contentDocument`. These tests pin that behaviour deterministically (no Chrome,
 * so the bun-runner CDP-disconnect that blocks a real-browser assertion here is
 * avoided).
 */

interface Seed {
  /** Live child session id to register for the frame (undefined = none). */
  childSessionId?: string;
  /** frameId reported by DOM.describeNode (defaults to 'frame-123'). */
  frameId?: string;
  /**
   * When true, DOM.describeNode reports a NON-NULL contentDocument — i.e. the
   * transient race state where a genuine OOPIF still looks same-origin.
   */
  contentDocumentPresent?: boolean;
}

function createMockCDPClient(seed: Seed) {
  const eventHandlers = new Map<string, Array<(p: Record<string, unknown>) => void>>();
  const frameId = seed.frameId ?? 'frame-123';
  const liveSessions = new Set<string>();
  if (seed.childSessionId) liveSessions.add(seed.childSessionId);

  const client: CDPClient = {
    send: mock((method: string, params?: Record<string, unknown>) => {
      if (
        method === 'Page.enable' ||
        method === 'DOM.enable' ||
        method === 'Runtime.enable' ||
        method === 'Network.enable' ||
        method === 'Page.stopLoading'
      ) {
        return Promise.resolve({});
      }
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        return Promise.resolve({ identifier: '1' });
      }
      if (method === 'DOM.getDocument') {
        return Promise.resolve({ root: { nodeId: 1 } });
      }
      if (method === 'DOM.querySelector') {
        return Promise.resolve({ nodeId: 10 });
      }
      if (method === 'DOM.describeNode') {
        return Promise.resolve({
          node: {
            contentDocument: seed.contentDocumentPresent
              ? { nodeId: 20, backendNodeId: 200 }
              : undefined,
            frameId,
            backendNodeId: 100,
          },
        });
      }
      if (method === 'DOM.resolveNode') {
        return Promise.resolve({ object: { objectId: 'obj-1' } });
      }
      if (method === 'Runtime.evaluate') {
        const expr = params?.['expression'] as string | undefined;
        // findElement visibility probe.
        if (expr?.includes('deepQuery') && expr?.includes('getBoundingClientRect')) {
          return Promise.resolve({ result: { value: true } });
        }
        if (expr?.includes('deepQuery') && expr?.includes('!== null')) {
          return Promise.resolve({ result: { value: true } });
        }
        if (expr?.includes('MutationObserver')) {
          return Promise.resolve({ result: { value: false } });
        }
        return Promise.resolve({ result: { value: null } });
      }
      if (method === 'Runtime.callFunctionOn') {
        return Promise.resolve({ result: { value: { actionable: true } } });
      }
      return Promise.resolve({});
    }) as CDPClient['send'],
    on: mock((event: string, handler: (p: Record<string, unknown>) => void) => {
      if (!eventHandlers.has(event)) eventHandlers.set(event, []);
      eventHandlers.get(event)!.push(handler);
    }),
    off: mock(() => {}),
    onSessionEvent: mock(() => () => {}),
    onAny: mock(() => {}),
    offAny: mock(() => {}),
    onTargetAttached: mock(() => () => {}),
    close: mock(() => Promise.resolve()),
    attachToTarget: mock(() => Promise.resolve('session-id')),
    setAutoAttach: mock(() => Promise.resolve()),
    runIfWaitingForDebugger: mock(() => Promise.resolve()),
    sessions: liveSessions,
    hasSession: mock((sid: string) => liveSessions.has(sid)),
    sessionId: 'test-session',
    setSessionId: mock(() => {}),
    isConnected: true,
  };
  return { client, frameId };
}

/** Register a live OOPIF child session for a frameId (as handleTargetAttached would). */
function seedOopifSession(page: Page, frameId: string, sessionId: string): void {
  (
    page as unknown as {
      oopifFrames: Map<string, { sessionId: string; targetId: string; url: string }>;
    }
  ).oopifFrames.set(frameId, { sessionId, targetId: frameId, url: 'http://child.example' });
}
function currentFrameSession(page: Page): string | null {
  return (page as unknown as { currentFrameSession: string | null }).currentFrameSession;
}

describe('OOPIF switchToFrame classification (silent mis-resolution race)', () => {
  it('takes the OOPIF path AUTHORITATIVELY when a child session is attached, even though describeNode.contentDocument was transiently NON-NULL', async () => {
    // The exact race state: a genuine OOPIF whose child session HAS attached, but
    // describeNode still transiently reports a non-null contentDocument.
    const { client, frameId } = createMockCDPClient({
      childSessionId: 'child-xo',
      contentDocumentPresent: true,
    });
    const page = new Page(client, 'target-1');
    await page.init();
    seedOopifSession(page, frameId, 'child-xo');

    const switched = await page.switchToFrame('[data-testid="x-frame"]', { timeout: 300 });

    // Pre-fix: this returned true with currentFrameSession === null (brokenFrame),
    // so guards went inert and actions hit the parent. It must now be the OOPIF.
    expect(switched).toBe(true);
    expect(currentFrameSession(page)).toBe('child-xo');
    // Guards are now armed: an unsupported in-frame action must hard-fail.
    await expect(page.hover('#x')).rejects.toThrow(
      /not yet supported inside a cross-origin iframe/
    );
  });

  it('a cross-origin switchToFrame (null contentDocument + attached session) resolves with currentFrameSession set, never null', async () => {
    const { client, frameId } = createMockCDPClient({
      childSessionId: 'child-xo-2',
      contentDocumentPresent: false,
    });
    const page = new Page(client, 'target-1');
    await page.init();
    seedOopifSession(page, frameId, 'child-xo-2');

    const switched = await page.switchToFrame('[data-testid="x-frame"]', { timeout: 300 });

    expect(switched).toBe(true);
    // The invariant the whole feature rests on: a cross-origin switchToFrame must
    // NEVER succeed with a null frame session.
    expect(currentFrameSession(page)).not.toBe(null);
    expect(currentFrameSession(page)).toBe('child-xo-2');
  });

  it('same-origin frame (contentDocument present, no child session, no context) preserves brokenFrame — currentFrameSession stays null', async () => {
    // No child session anywhere: this is a genuine same-origin frame that simply
    // lacks a JS execution context (e.g. sandboxed). Behaviour must be unchanged:
    // returns true, marks the frame, and leaves currentFrameSession null.
    const { client } = createMockCDPClient({ contentDocumentPresent: true });
    const page = new Page(client, 'target-1');
    await page.init();

    const switched = await page.switchToFrame('iframe#same-origin', { timeout: 200 });

    expect(switched).toBe(true);
    expect(page.getCurrentFrame()).toBe('iframe#same-origin');
    expect(currentFrameSession(page)).toBe(null);
  });
});
