import { describe, expect, it, mock } from 'bun:test';
import { Page } from '../../src/browser/page.ts';
import type { CDPClient } from '../../src/cdp/client.ts';

/**
 * Unit coverage for the cross-origin (OOPIF) safety guards on `Page`, driven by
 * a mock CDP client (no Chrome). Complements the real-browser assertions in
 * tests/integration/cross-origin-iframe.test.ts.
 *
 * - C1: element-acting/-reading methods that are NOT routed into an OOPIF child
 *   session must hard-fail with a clear, actionable error while a cross-origin
 *   frame is active — never silently resolve against the parent session.
 * - M3: a nested `switchToFrame` from inside an OOPIF that cannot resolve/enter a
 *   child frame must FAIL CLEANLY (throw when not optional; return false when
 *   optional) and must NOT silently retarget/lose the active frame session.
 */

interface MockOptions {
  /** Make Runtime.evaluate `document.querySelector(...)` return a live objectId. */
  frameElementObjectId?: string;
  /** frameId that DOM.describeNode({objectId}) should report for that element. */
  frameElementFrameId?: string;
}

function createMockCDPClient(opts: MockOptions = {}): CDPClient {
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
      // The nested-descent path (fix #2/#3 rewrite) resolves the target
      // <iframe> element via `findElementInSession` (DOM.querySelector +
      // DOM.resolveNode), not a bare `Runtime.evaluate("document.querySelector")`
      // expression. Stub a fixed nodeId/objectId pair when the test wants the
      // element to "exist".
      if (method === 'DOM.querySelector') {
        return Promise.resolve({ nodeId: opts.frameElementObjectId ? 99 : 0 });
      }
      if (method === 'DOM.resolveNode') {
        const nodeId = params?.['nodeId'] as number | undefined;
        if (nodeId === 99 && opts.frameElementObjectId) {
          return Promise.resolve({ object: { objectId: opts.frameElementObjectId } });
        }
        return Promise.resolve({ object: {} });
      }
      if (method === 'Runtime.evaluate') {
        return Promise.resolve({ result: { value: null } });
      }
      if (method === 'Runtime.callFunctionOn') {
        // No shadow-DOM candidates in this mock.
        return Promise.resolve({ result: {} });
      }
      if (method === 'DOM.describeNode') {
        return Promise.resolve({ node: { frameId: opts.frameElementFrameId } });
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
    attachToTarget: mock(() => Promise.resolve('session-id')),
    setAutoAttach: mock(() => Promise.resolve()),
    runIfWaitingForDebugger: mock(() => Promise.resolve()),
    sessions: new Set<string>(),
    // No child sessions are live, so any OOPIF attach-wait times out.
    hasSession: mock(() => false),
    sessionId: 'test-session',
    setSessionId: mock(() => {}),
    isConnected: true,
  };
  return client;
}

/** Force the page into "inside an OOPIF child session" state. */
function enterOopif(page: Page, sessionId = 'child-oopif-session'): void {
  (page as unknown as { currentFrameSession: string | null }).currentFrameSession = sessionId;
}
function currentFrameSession(page: Page): string | null {
  return (page as unknown as { currentFrameSession: string | null }).currentFrameSession;
}

const GUARD_MSG = /not yet supported inside a cross-origin iframe/;

describe('OOPIF action guards (C1)', () => {
  it('hover/select/check/uncheck/submit/scroll/setInputFiles throw a clear error inside an OOPIF', async () => {
    const page = new Page(createMockCDPClient(), 'target-1');
    await page.init();
    enterOopif(page);

    await expect(page.hover('#x')).rejects.toThrow(GUARD_MSG);
    await expect(page.select('#x', 'v')).rejects.toThrow(GUARD_MSG);
    await expect(page.check('#x')).rejects.toThrow(GUARD_MSG);
    await expect(page.uncheck('#x')).rejects.toThrow(GUARD_MSG);
    await expect(page.submit('#x')).rejects.toThrow(GUARD_MSG);
    await expect(page.scroll('#x')).rejects.toThrow(GUARD_MSG);
    await expect(page.setInputFiles('#x', [])).rejects.toThrow(GUARD_MSG);
  });

  it('snapshot/elementState/forms throw a clear error inside an OOPIF', async () => {
    const page = new Page(createMockCDPClient(), 'target-1');
    await page.init();
    enterOopif(page);

    await expect(page.snapshot()).rejects.toThrow(GUARD_MSG);
    await expect(page.elementState('#x')).rejects.toThrow(GUARD_MSG);
    await expect(page.forms()).rejects.toThrow(GUARD_MSG);
  });

  it('the guard error names the method and points at switchToMain()', async () => {
    const page = new Page(createMockCDPClient(), 'target-1');
    await page.init();
    enterOopif(page);
    await expect(page.hover('#x')).rejects.toThrow(/hover is not yet supported/);
    await expect(page.hover('#x')).rejects.toThrow(/switchToMain\(\) first/);
  });
});

describe('OOPIF nested switchToFrame (M3)', () => {
  it('throws (not silent false) and preserves the frame session when no child frame resolves', async () => {
    // DOM.querySelector reports no match (nodeId 0) → findElementInSession →
    // null → ElementNotFoundError. Short timeout: findElementInSession polls
    // like any other element finder, so give it a bounded window instead of
    // waiting out the full default timeout for an element that never exists.
    const page = new Page(createMockCDPClient(), 'target-1');
    await page.init();
    enterOopif(page, 'parent-oopif');

    await expect(page.switchToFrame('iframe#nested', { timeout: 200 })).rejects.toThrow();
    // The active frame session must NOT be silently dropped or retargeted.
    expect(currentFrameSession(page)).toBe('parent-oopif');
  });

  it('returns false (not a throw) when optional, still preserving the frame session', async () => {
    const page = new Page(createMockCDPClient(), 'target-1');
    await page.init();
    enterOopif(page, 'parent-oopif');

    const result = await page.switchToFrame('iframe#nested', { optional: true, timeout: 200 });
    expect(result).toBe(false);
    expect(currentFrameSession(page)).toBe('parent-oopif');
  });

  it('throws when a child frameId resolves but no child session ever attaches (the M3 bug path)', async () => {
    // The nested <iframe> resolves a frameId, but no matching child session is
    // live (hasSession=false, empty registry), so enterOopifFrame returns false.
    // Pre-fix this returned false silently; it must now throw. NOTE: honours the
    // OOPIF attach floor, so this waits ~5s for the child session before failing.
    const page = new Page(
      createMockCDPClient({ frameElementObjectId: 'obj-frame', frameElementFrameId: 'nested-fid' }),
      'target-1'
    );
    await page.init();
    enterOopif(page, 'parent-oopif');

    await expect(page.switchToFrame('iframe#nested', { timeout: 1 })).rejects.toThrow(
      /nested|did not attach|not yet supported/i
    );
    expect(currentFrameSession(page)).toBe('parent-oopif');
  }, 15000);
});
