import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Page } from '../../src/browser/page';
import type { CDPClient } from '../../src/cdp/client';

/**
 * Tests for Epic 6: Iframe Context Safety
 * - brokenFrame is set when frame context acquisition times out
 * - evaluateInFrame() throws explicitly in broken frame context
 * - switchToMain() clears brokenFrame
 * - Successful switchToFrame() does not set brokenFrame
 */

// Track CDP event handlers so we can simulate events
let eventHandlers: Map<string, Array<(params: Record<string, unknown>) => void>>;
let cdpCalls: Array<{ method: string; params?: Record<string, unknown> }>;

function createMockCDPClient() {
  eventHandlers = new Map();
  cdpCalls = [];

  const client: CDPClient = {
    send: mock((method: string, params?: Record<string, unknown>) => {
      cdpCalls.push({ method, params });

      // Init-phase enables
      if (
        method === 'Page.enable' ||
        method === 'DOM.enable' ||
        method === 'Runtime.enable' ||
        method === 'Network.enable'
      ) {
        return Promise.resolve({});
      }
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        return Promise.resolve({ identifier: '1' });
      }
      if (method === 'Page.stopLoading') {
        return Promise.resolve({});
      }

      // DOM operations
      if (method === 'DOM.getDocument') {
        return Promise.resolve({ root: { nodeId: 1 } });
      }
      if (method === 'DOM.querySelector') {
        // Return a valid nodeId for any iframe selector query
        return Promise.resolve({ nodeId: 10 });
      }
      if (method === 'DOM.describeNode') {
        // Return iframe content document with a frameId
        return Promise.resolve({
          node: {
            contentDocument: { nodeId: 20, backendNodeId: 200 },
            frameId: 'frame-123',
            backendNodeId: 100,
          },
        });
      }
      if (method === 'DOM.resolveNode') {
        return Promise.resolve({ object: { objectId: 'obj-1' } });
      }

      // Runtime operations
      if (method === 'Runtime.evaluate') {
        const expr = params?.['expression'] as string | undefined;

        // isElementVisible check — return true so findElement succeeds
        if (expr?.includes('deepQuery') && expr?.includes('getBoundingClientRect')) {
          return Promise.resolve({ result: { value: true } });
        }
        // isElementAttached check
        if (expr?.includes('deepQuery') && expr?.includes('!== null')) {
          return Promise.resolve({ result: { value: true } });
        }
        // isPageStatic check — return false (dynamic) to skip fast-fail path
        if (expr?.includes('MutationObserver')) {
          return Promise.resolve({ result: { value: false } });
        }
        // Storage clearing in reset()
        if (expr?.includes('localStorage') || expr?.includes('sessionStorage')) {
          return Promise.resolve({ result: { value: undefined } });
        }

        // Default
        return Promise.resolve({ result: { value: null } });
      }

      if (method === 'Runtime.callFunctionOn') {
        // Actionability checks
        return Promise.resolve({ result: { value: { actionable: true } } });
      }

      return Promise.resolve({});
    }) as CDPClient['send'],

    on: mock((event: string, handler: (params: Record<string, unknown>) => void) => {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, []);
      }
      eventHandlers.get(event)!.push(handler);
    }),

    off: mock(() => {}),
    onAny: mock(() => {}),
    close: mock(() => Promise.resolve()),
    attachToTarget: mock(() => Promise.resolve('session-id')),
    sessionId: 'test-session',
    isConnected: true,
  };

  return client;
}

/** Simulate a Runtime.executionContextCreated event */
function emitExecutionContextCreated(frameId: string, contextId: number) {
  const handlers = eventHandlers.get('Runtime.executionContextCreated') ?? [];
  for (const handler of handlers) {
    handler({
      context: {
        id: contextId,
        auxData: { frameId, isDefault: true },
      },
    });
  }
}

describe('iframe context safety', () => {
  beforeEach(() => {
    cdpCalls = [];
  });

  it('sets brokenFrame when frame context acquisition times out', async () => {
    const cdp = createMockCDPClient();
    const page = new Page(cdp, 'target-1');
    await page.init();

    // switchToFrame finds the iframe and gets contentDocument,
    // but no execution context event arrives, so waitForFrameContext times out.
    const result = await page.switchToFrame('iframe#my-frame', { timeout: 300 });

    // switchToFrame returns true (DOM access works), but frame is marked broken
    expect(result).toBe(true);
    expect(page.getCurrentFrame()).toBe('iframe#my-frame');
  });

  it('evaluateInFrame throws explicitly when in broken frame context', async () => {
    const cdp = createMockCDPClient();
    const page = new Page(cdp, 'target-1');
    await page.init();

    // Switch to frame with no execution context available (broken)
    await page.switchToFrame('iframe#cross-origin', { timeout: 300 });

    // page.text() without a selector delegates to evaluateInFrame internally.
    // It should throw with a clear error message about cross-origin/sandboxed iframe.
    await expect(page.text()).rejects.toThrow('cross-origin or sandboxed iframe');
  });

  it('switchToMain clears brokenFrame', async () => {
    const cdp = createMockCDPClient();
    const page = new Page(cdp, 'target-1');
    await page.init();

    // Enter broken frame context
    await page.switchToFrame('iframe#broken', { timeout: 300 });
    expect(page.getCurrentFrame()).toBe('iframe#broken');

    // Switch back to main
    await page.switchToMain();

    // Frame should be cleared
    expect(page.getCurrentFrame()).toBeNull();

    // text() should work again (back in main context, no broken frame guard)
    const result = await page.text();
    expect(result).toBe(''); // mock returns { result: { value: null } }, text() coerces to ''
  });

  it('successful switchToFrame does not set brokenFrame when context is available', async () => {
    const cdp = createMockCDPClient();
    const page = new Page(cdp, 'target-1');
    await page.init();

    // Pre-populate the execution context before switching.
    // Simulate the browser sending execution context for the frame.
    emitExecutionContextCreated('frame-123', 42);

    // Now switch to frame -- context is already available
    const result = await page.switchToFrame('iframe#same-origin', { timeout: 2000 });

    expect(result).toBe(true);
    expect(page.getCurrentFrame()).toBe('iframe#same-origin');

    // text() should work without throwing (no broken frame)
    const evalResult = await page.text();
    expect(evalResult).toBe(''); // mock returns null, text() coerces to ''

    // Verify Runtime.evaluate was called with contextId for the frame
    const evalCalls = cdpCalls.filter(
      (c) =>
        c.method === 'Runtime.evaluate' &&
        (c.params?.['expression'] as string) === 'document.body.innerText'
    );
    expect(evalCalls.length).toBe(1);
    expect(evalCalls[0]?.params?.['contextId']).toBe(42);
  });

  it('reset() clears brokenFrame', async () => {
    const cdp = createMockCDPClient();
    const page = new Page(cdp, 'target-1');
    await page.init();

    // Enter broken frame context
    await page.switchToFrame('iframe#stale', { timeout: 300 });
    expect(page.getCurrentFrame()).toBe('iframe#stale');

    // Reset clears all frame state
    await page.reset();

    expect(page.getCurrentFrame()).toBeNull();

    // text() should work again after reset
    const result = await page.text();
    expect(result).toBe(''); // mock returns null, text() coerces to ''
  });
});
