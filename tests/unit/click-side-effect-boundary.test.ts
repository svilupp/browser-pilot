import { describe, expect, test } from 'bun:test';
import { shouldRetry } from '../../src/actions/conditions.ts';
import { BatchExecutor } from '../../src/actions/executor.ts';
import { validateSteps } from '../../src/actions/validate.ts';
import { ActionDispatch } from '../../src/browser/action-dispatch.ts';
import type { Page } from '../../src/browser/page.ts';
import { Page as RealPage } from '../../src/browser/page.ts';
import type { ActionReceipt } from '../../src/browser/types.ts';
import type { CDPClient } from '../../src/cdp/client.ts';

function receipt(
  dispatchState: ActionReceipt['dispatchState'],
  inputEventsSent: string[] = []
): ActionReceipt {
  return {
    dispatchState,
    retrySafe: dispatchState === 'not_dispatched',
    inputEventsSent,
  };
}

function createExecutorPage(options: {
  click?: (page: ReturnType<typeof createExecutorPage>) => Promise<void>;
  text?: string;
}) {
  const calls: string[] = [];
  let lastReceipt: ActionReceipt | undefined;
  let text = options.text ?? 'pending';

  const page = {
    calls,
    targetId: 'test-target',
    cdpClient: {},
    getLastActionReceipt() {
      return lastReceipt;
    },
    resetLastActionReceipt() {
      lastReceipt = undefined;
    },
    resetLastActionPosition() {},
    getLastMatchedSelector() {
      return '#action';
    },
    getLastActionCoordinates() {
      return null;
    },
    getLastActionBoundingBox() {
      return null;
    },
    getLastActionTargetMetadata() {
      return null;
    },
    async click() {
      calls.push('click');
      if (options.click) {
        await options.click(page);
        return true;
      }
      lastReceipt = receipt('dispatched', ['mousePressed', 'mouseReleased']);
      return true;
    },
    async text() {
      calls.push('text');
      return text;
    },
    async url() {
      calls.push('url');
      return 'https://example.test/action';
    },
    setText(value: string) {
      text = value;
    },
  };

  return page;
}

describe('ActionDispatch', () => {
  test('marks a failed mousePressed as uncertain and non-retryable', async () => {
    const dispatch = new ActionDispatch();

    await dispatch.send(async () => undefined, 'mouseMoved', { effectful: false });
    await expect(
      dispatch.send(async () => {
        throw new Error('context lost');
      }, 'mousePressed')
    ).rejects.toThrow('context lost');

    expect(dispatch.toReceipt()).toEqual({
      dispatchState: 'uncertain',
      retrySafe: false,
      inputEventsSent: ['mouseMoved', 'mousePressed'],
    });
    expect(dispatch.canRetryAction).toBe(false);
  });

  test('does not permit JS fallback after mouseReleased may have been sent', async () => {
    const dispatch = new ActionDispatch();
    await dispatch.send(async () => undefined, 'mousePressed');
    await expect(
      dispatch.send(async () => {
        throw new Error('navigation destroyed context');
      }, 'mouseReleased')
    ).rejects.toThrow('navigation destroyed context');

    expect(dispatch.canRetryAction).toBe(false);
    expect(dispatch.toReceipt().inputEventsSent).toEqual(['mousePressed', 'mouseReleased']);
  });
});

function createClickPage(
  failAt?: 'mousePressed' | 'mouseReleased',
  visibilityState: 'visible' | 'hidden' = 'visible'
) {
  const inputEvents: string[] = [];
  const calls: string[] = [];
  let resolveNodeCalls = 0;
  const cdp = {
    async send(method: string, params?: Record<string, unknown>) {
      calls.push(
        method === 'Runtime.evaluate' && params?.['expression'] === '0'
          ? 'Runtime.evaluate:0'
          : method
      );
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 10 };
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 20 } };
      if (method === 'DOM.scrollIntoViewIfNeeded') return {};
      if (method === 'DOM.resolveNode') {
        resolveNodeCalls += 1;
        return { object: { objectId: 'object-1' } };
      }
      if (method === 'DOM.getContentQuads') {
        return { quads: [[10, 10, 110, 10, 110, 50, 10, 50]] };
      }
      if (method === 'Runtime.evaluate') {
        if (params?.['expression'] === 'document.visibilityState') {
          return { result: { value: visibilityState } };
        }
        return { result: { value: true } };
      }
      if (method === 'Runtime.callFunctionOn') {
        const declaration = String(params?.['functionDeclaration'] ?? '');
        if (declaration.includes('instanceof HTMLInputElement')) {
          return { result: { value: null } };
        }
        if (declaration.includes('return !!this.checked')) {
          return { result: { value: true } };
        }
        return { result: { value: { actionable: true } } };
      }
      if (method === 'Input.dispatchMouseEvent') {
        const eventName = params?.['type'] as string;
        inputEvents.push(eventName);
        if (eventName === failAt) throw new Error(`injected failure at ${eventName}`);
        return {};
      }
      return {};
    },
  };

  return {
    page: new RealPage(cdp as unknown as CDPClient, 'target'),
    calls,
    inputEvents,
    get resolveNodeCalls() {
      return resolveNodeCalls;
    },
  };
}

describe('Page click dispatch boundary', () => {
  test('does not issue JS fallback after mousePressed failure', async () => {
    const fixture = createClickPage('mousePressed');

    await expect(fixture.page.click('#button')).rejects.toThrow('injected failure');

    expect(fixture.inputEvents).toEqual(['mouseMoved', 'mousePressed']);
    expect(fixture.page.getLastActionReceipt()).toEqual({
      dispatchState: 'uncertain',
      retrySafe: false,
      inputEventsSent: ['mouseMoved', 'mousePressed'],
    });
  });

  test('does not issue JS fallback after mouseReleased failure', async () => {
    const fixture = createClickPage('mouseReleased');

    await expect(fixture.page.click('#button')).rejects.toThrow('injected failure');

    expect(fixture.inputEvents).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(fixture.page.getLastActionReceipt()?.dispatchState).toBe('uncertain');
    expect(fixture.page.getLastActionReceipt()?.retrySafe).toBe(false);
  });

  test('does not run the old trailing Runtime.evaluate round-trip', async () => {
    const fixture = createClickPage();

    await fixture.page.click('#button');

    expect(fixture.page.getLastActionReceipt()?.dispatchState).toBe('dispatched');
    expect(fixture.calls).not.toContain('Runtime.evaluate:0');
  });

  test('uses DOM click for a hidden document before any mouse input', async () => {
    const fixture = createClickPage(undefined, 'hidden');

    await fixture.page.click('#button');

    expect(fixture.inputEvents).toEqual([]);
    expect(fixture.calls).toContain('Runtime.callFunctionOn');
    expect(fixture.page.getLastActionReceipt()).toEqual({
      dispatchState: 'dispatched',
      retrySafe: false,
      inputEventsSent: ['javascriptClick'],
    });
  });

  test('still retries a stale node before any effectful input event', async () => {
    const fixture = createClickPage();
    const originalSend = fixture.page.cdpClient.send.bind(fixture.page.cdpClient);
    let firstResolve = true;
    fixture.page.cdpClient.send = async (method, params, sessionId, options) => {
      if (method === 'DOM.resolveNode' && firstResolve) {
        firstResolve = false;
        fixture.calls.push('DOM.resolveNode:stale');
        throw new Error('Could not find object with given id');
      }
      return originalSend(method, params, sessionId, options);
    };

    await fixture.page.click('#button');

    expect(fixture.inputEvents).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(fixture.calls).toContain('DOM.resolveNode:stale');
    expect(fixture.resolveNodeCalls).toBeGreaterThan(0);
  });
});

describe('centralized retry policy', () => {
  test('validates the explicit effect policy', () => {
    expect(
      validateSteps([{ action: 'click', selector: '#action', effect: 'at_most_once' }]).valid
    ).toBe(true);
    expect(validateSteps([{ action: 'click', selector: '#action', effect: 'unsafe' }]).valid).toBe(
      false
    );
  });

  test('stops dangerous and non-dangerous actions after dispatch', () => {
    expect(
      shouldRetry({
        effect: 'at_most_once',
        dangerous: true,
        dispatchState: 'dispatched',
        retrySafe: false,
        attempt: 0,
        maxAttempts: 3,
      })
    ).toEqual({ retry: false, reason: 'retry_unsafe' });

    expect(
      shouldRetry({
        effect: 'at_most_once',
        dangerous: false,
        dispatchState: 'uncertain',
        retrySafe: true,
        attempt: 0,
        maxAttempts: 3,
      })
    ).toEqual({ retry: false, reason: 'dispatch_already_attempted' });
  });

  test('allows only an explicit pre-dispatch retry', () => {
    expect(
      shouldRetry({
        effect: 'at_most_once',
        dangerous: true,
        dispatchState: 'not_dispatched',
        retrySafe: true,
        attempt: 0,
        maxAttempts: 2,
      })
    ).toEqual({ retry: true, reason: 'retry_allowed_pre_dispatch' });

    expect(
      shouldRetry({
        effect: 'at_most_once',
        dangerous: false,
        attempt: 0,
        maxAttempts: 2,
      })
    ).toEqual({ retry: false, reason: 'missing_retry_metadata' });
  });
});

describe('BatchExecutor dispatch-aware retries', () => {
  test('does not redispatch after a mechanical error with uncertain receipt', async () => {
    let clicks = 0;
    const page = createExecutorPage({
      click: async (currentPage) => {
        clicks += 1;
        const target = currentPage as typeof currentPage & {
          getLastActionReceipt(): ActionReceipt | undefined;
        };
        // The mock's receipt is intentionally updated through the private-ish
        // test seam used by the page contract below.
        Object.defineProperty(target, 'getLastActionReceipt', {
          value: () => receipt('uncertain', ['mousePressed']),
        });
        throw new Error('execution context destroyed after dispatch');
      },
    });

    const result = await new BatchExecutor(page as unknown as Page).execute([
      { action: 'click', selector: '#action', retry: 2 },
    ]);

    expect(clicks).toBe(1);
    expect(result.success).toBe(false);
    expect(result.steps[0]?.attempts).toBe(1);
    expect(result.steps[0]?.receipt?.dispatchState).toBe('uncertain');
    expect(result.steps[0]?.retryDecisionReason).toBe('retry_unsafe');
  });

  test('retries delayed postconditions as observation only', async () => {
    let clicks = 0;
    let reads = 0;
    const page = createExecutorPage({
      text: 'pending',
      click: async (currentPage) => {
        clicks += 1;
        Object.defineProperty(currentPage, 'getLastActionReceipt', {
          value: () => receipt('dispatched', ['mousePressed', 'mouseReleased']),
        });
      },
    });
    page.text = async () => {
      reads += 1;
      return reads < 2 ? 'pending' : 'complete';
    };

    const result = await new BatchExecutor(page as unknown as Page).execute([
      {
        action: 'click',
        selector: '#action',
        retry: 2,
        retryDelay: 1,
        expectAny: [{ kind: 'textAppears', text: 'complete', mode: 'exact' }],
      },
    ]);

    expect(clicks).toBe(1);
    expect(result.success).toBe(true);
    expect(result.steps[0]?.attempts).toBe(1);
  });

  test('retries after a proven pre-dispatch failure and keeps the original baseline', async () => {
    let clicks = 0;
    let textReads = 0;
    const page = createExecutorPage({
      text: 'pending',
      click: async (currentPage) => {
        clicks += 1;
        Object.defineProperty(currentPage, 'getLastActionReceipt', {
          value: () =>
            clicks === 1
              ? receipt('not_dispatched')
              : receipt('dispatched', ['mousePressed', 'mouseReleased']),
        });
        if (clicks === 1) throw new Error('stale before dispatch');
      },
    });
    const originalText = page.text;
    page.text = async () => {
      textReads += 1;
      return originalText();
    };

    const result = await new BatchExecutor(page as unknown as Page).execute([
      {
        action: 'click',
        selector: '#action',
        retry: 1,
        retryDelay: 0,
        expectAny: [{ kind: 'textAppears', text: 'done' }, { kind: 'stateSignatureChanges' }],
      },
    ]);

    expect(clicks).toBe(2);
    expect(result.success).toBe(false);
    expect(result.steps[0]?.attempts).toBe(2);
    // One initial baseline capture plus two condition reads on the final
    // attempt. A recaptured baseline would add another pre-action text read.
    expect(textReads).toBe(3);
  });

  test('rescues a post-dispatch transport error through the postcondition', async () => {
    let clicks = 0;
    const page = createExecutorPage({
      text: 'done',
      click: async (currentPage) => {
        clicks += 1;
        Object.defineProperty(currentPage, 'getLastActionReceipt', {
          value: () => receipt('uncertain', ['mousePressed']),
        });
        throw new Error('navigation destroyed execution context');
      },
    });

    const result = await new BatchExecutor(page as unknown as Page).execute([
      {
        action: 'click',
        selector: '#action',
        retry: 2,
        expectAny: [{ kind: 'textAppears', text: 'done' }],
      },
    ]);

    expect(clicks).toBe(1);
    expect(result.success).toBe(true);
    expect(result.steps[0]?.attempts).toBe(1);
    expect(result.steps[0]?.receipt?.retrySafe).toBe(false);
    expect(result.steps[0]?.outcomeStatus).toBe('success');
  });
});
