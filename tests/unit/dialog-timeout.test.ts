import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Page } from '../../src/browser/page.ts';

/**
 * Tests for Epic 12: Dialog handler timeout and auto-dismiss
 *
 * The Page class listens for 'Page.javascriptDialogOpening' CDP events.
 * When a dialog appears:
 * - If a handler is set, it races the handler against a 5s timeout
 * - If the handler times out, the dialog is auto-dismissed
 * - If the handler throws, the dialog is auto-dismissed
 * - If no handler is set, the dialog is auto-dismissed immediately
 */

let cdpCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
let eventHandlers: Map<string, Array<(params: Record<string, unknown>) => void>>;

function createMockCDPClient() {
  eventHandlers = new Map();
  cdpCalls = [];

  return {
    send: mock((method: string, params?: Record<string, unknown>) => {
      cdpCalls.push({ method, params });

      if (method === 'DOM.getDocument') {
        return Promise.resolve({ root: { nodeId: 1 } });
      }
      if (
        method === 'Page.enable' ||
        method === 'DOM.enable' ||
        method === 'Runtime.enable' ||
        method === 'Network.enable'
      ) {
        return Promise.resolve({});
      }
      if (method === 'Runtime.evaluate') {
        return Promise.resolve({ result: { value: null } });
      }
      if (method === 'Page.addScriptToEvaluateOnNewDocument') {
        return Promise.resolve({ identifier: 'script-1' });
      }
      if (method === 'Page.handleJavaScriptDialog') {
        return Promise.resolve({});
      }
      return Promise.resolve({});
    }),
    on: mock((event: string, handler: (params: Record<string, unknown>) => void) => {
      let handlers = eventHandlers.get(event);
      if (!handlers) {
        handlers = [];
        eventHandlers.set(event, handlers);
      }
      handlers.push(handler);
    }),
    off: mock(() => {}),
    onAny: mock(() => {}),
    close: mock(() => Promise.resolve()),
    attachToTarget: mock(() => Promise.resolve('session-id')),
    sessionId: 'test-session',
    isConnected: true,
  };
}

function triggerDialog(type: string = 'alert', message: string = 'Test dialog') {
  const handlers = eventHandlers.get('Page.javascriptDialogOpening');
  if (!handlers || handlers.length === 0) {
    throw new Error('No dialog handler registered — did you call page.init()?');
  }
  for (const handler of handlers) {
    handler({ type, message });
  }
}

function getDialogDismissCalls() {
  return cdpCalls.filter(
    (c) => c.method === 'Page.handleJavaScriptDialog' && c.params?.['accept'] === false
  );
}

function getDialogAcceptCalls() {
  return cdpCalls.filter(
    (c) => c.method === 'Page.handleJavaScriptDialog' && c.params?.['accept'] === true
  );
}

async function createInitializedPage() {
  const cdp = createMockCDPClient();
  const page = new Page(cdp as never, 'target-1');
  await page.init();
  return { cdp, page };
}

describe('dialog handler timeout', () => {
  beforeEach(() => {
    cdpCalls = [];
  });

  it('dialog handler that takes too long is timed out and dialog is auto-dismissed', async () => {
    const { page } = await createInitializedPage();

    // Set a handler that never resolves (simulates a hung handler)
    await page.onDialog(
      () =>
        new Promise(() => {
          // intentionally never resolves
        })
    );

    // Clear calls from init/onDialog setup
    cdpCalls = [];

    // Trigger a dialog event
    triggerDialog('alert', 'Slow handler test');

    // The dialog handler races against a 5s timeout.
    // Wait slightly longer than 5s to let the timeout fire.
    await new Promise((resolve) => setTimeout(resolve, 5500));

    // The dialog should have been auto-dismissed after the timeout
    const dismissCalls = getDialogDismissCalls();
    expect(dismissCalls.length).toBeGreaterThanOrEqual(1);
  }, 10000);

  it('dialog handler error triggers dismiss', async () => {
    const { page } = await createInitializedPage();

    // Set a handler that throws
    await page.onDialog(async () => {
      throw new Error('Handler crashed');
    });

    // Clear calls from setup
    cdpCalls = [];

    // Trigger a dialog event
    triggerDialog('confirm', 'Error handler test');

    // Give time for the async error handling to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The dialog should have been dismissed after the error
    const dismissCalls = getDialogDismissCalls();
    expect(dismissCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('dialog without handler is auto-dismissed immediately', async () => {
    // Create page WITHOUT setting a dialog handler
    await createInitializedPage();

    // Clear calls from init
    cdpCalls = [];

    // Trigger a dialog event — no handler is set
    triggerDialog('alert', 'No handler test');

    // Give time for the async dismiss to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The dialog should have been auto-dismissed
    const dismissCalls = getDialogDismissCalls();
    expect(dismissCalls.length).toBe(1);
  });

  it('dialog handler that completes in time is not dismissed by timeout', async () => {
    const { page } = await createInitializedPage();
    const handlerCalled = mock(() => {});

    // Set a handler that accepts the dialog quickly
    await page.onDialog(async (dialog) => {
      handlerCalled();
      await dialog.accept('ok');
    });

    // Clear calls from setup
    cdpCalls = [];

    // Trigger a dialog event
    triggerDialog('prompt', 'Quick handler test');

    // Give time for the handler to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Handler should have been called
    expect(handlerCalled).toHaveBeenCalledTimes(1);

    // The handler accepted the dialog, so we should see an accept call
    const acceptCalls = getDialogAcceptCalls();
    expect(acceptCalls.length).toBe(1);

    // No dismiss call should have occurred since the handler completed successfully
    const dismissCalls = getDialogDismissCalls();
    expect(dismissCalls.length).toBe(0);
  });
});
