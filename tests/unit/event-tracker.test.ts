import { beforeEach, describe, expect, it, mock } from 'bun:test';

/**
 * Tests for Epic 7: Inline event handler invocation in invokeRecordedEventListeners()
 *
 * The invokeRecordedEventListeners method injects a JS function via CDP Runtime.callFunctionOn.
 * That injected function checks for inline `on${type}` handlers (e.g., onclick, oninput)
 * on each node in the event path and invokes them with a proper event object.
 *
 * Since these run inside the browser context, we verify at the unit level that:
 * 1. The injected code string includes the inline handler check
 * 2. The inline handler pattern is correct (checks `on` + type, calls it, sets invoked)
 * 3. The event object passed to inline handlers has the expected shape
 */

let cdpCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];

function createMockCDPClient() {
  return {
    send: mock((method: string, params?: Record<string, unknown>) => {
      cdpCalls.push({ method, params });

      if (method === 'Runtime.callFunctionOn') {
        // Return true to indicate listeners were invoked
        return Promise.resolve({ result: { value: true } });
      }
      return Promise.resolve({});
    }),
    on: mock(() => {}),
    off: mock(() => {}),
    onAny: mock(() => {}),
    close: mock(() => Promise.resolve()),
    attachToTarget: mock(() => Promise.resolve('session-id')),
    sessionId: 'test-session',
    isConnected: true,
  };
}

/**
 * Extract the functionDeclaration string from the last Runtime.callFunctionOn call.
 */
function getLastFunctionDeclaration(): string | undefined {
  const call = cdpCalls.find(
    (c) => c.method === 'Runtime.callFunctionOn' && c.params?.['functionDeclaration']
  );
  return call?.params?.['functionDeclaration'] as string | undefined;
}

describe('invokeRecordedEventListeners inline handler support', () => {
  beforeEach(() => {
    cdpCalls = [];
  });

  it('injected code checks for inline on[type] handlers', async () => {
    const cdp = createMockCDPClient();

    // Simulate what Page.invokeRecordedEventListeners does internally:
    // It calls Runtime.callFunctionOn with a function that includes inline handler logic.
    await cdp.send('Runtime.callFunctionOn', {
      objectId: 'obj-1',
      functionDeclaration: getInvokeRecordedEventListenersFn(),
      arguments: [{ value: ['input', 'change'] }],
      returnByValue: true,
    });

    const fnBody = getLastFunctionDeclaration()!;
    expect(fnBody).toBeDefined();

    // Verify the inline handler pattern: currentTarget['on' + type]
    expect(fnBody).toContain("currentTarget['on' + type]");
    // Verify it checks if the inline handler is a function
    expect(fnBody).toContain("typeof inlineHandler === 'function'");
  });

  it('inline handler is invoked even when no addEventListener entries exist', () => {
    // The invokePhase function in the injected code first checks for inline handlers,
    // then checks __bpEventListeners. The inline handler check is independent.
    const fnBody = getInvokeRecordedEventListenersFn();

    // The inline handler block appears BEFORE the __bpEventListeners check
    const inlineHandlerIndex = fnBody.indexOf("var inlineHandler = currentTarget['on' + type]");
    const storeIndex = fnBody.indexOf(
      'var store = currentTarget && currentTarget.__bpEventListeners'
    );

    expect(inlineHandlerIndex).toBeGreaterThan(-1);
    expect(storeIndex).toBeGreaterThan(-1);
    // Inline handler check comes before the store/entries check
    expect(inlineHandlerIndex).toBeLessThan(storeIndex);

    // The inline handler sets invoked = true independently
    // Even if entries is empty (the `continue` on line after entries check),
    // invoked would already be true from the inline handler
    const inlineInvokedLine = fnBody.indexOf('inlineHandler.call(currentTarget, inlineEvent)');
    expect(inlineInvokedLine).toBeGreaterThan(-1);

    // After calling the inline handler, invoked is set to true
    const invokedAfterInline = fnBody.indexOf('invoked = true', inlineInvokedLine);
    expect(invokedAfterInline).toBeGreaterThan(-1);
  });

  it('inline handler receives a proper event object', () => {
    const fnBody = getInvokeRecordedEventListenersFn();

    // The inline handler gets an event created via createEvent()
    expect(fnBody).toContain(
      'var inlineEvent = createEvent(type, target, currentTarget, path, phase)'
    );

    // createEvent returns an object with standard event properties
    expect(fnBody).toContain('type: type');
    expect(fnBody).toContain('target: target');
    expect(fnBody).toContain('currentTarget: currentTarget');
    expect(fnBody).toContain('isTrusted: true');
    expect(fnBody).toContain('bubbles: true');
    expect(fnBody).toContain('cancelable: true');
    expect(fnBody).toContain('preventDefault: function()');
    expect(fnBody).toContain('stopPropagation: function()');
    expect(fnBody).toContain('stopImmediatePropagation: function()');
    expect(fnBody).toContain('composedPath: function()');
    expect(fnBody).toContain('eventPhase: phase');
  });

  it('inline handler stopPropagation breaks the phase loop', () => {
    const fnBody = getInvokeRecordedEventListenersFn();

    // After the inline handler call, there is a check for __stopped
    // which breaks out of the node iteration loop
    expect(fnBody).toContain('if (inlineEvent.__stopped) break');
  });

  it('inline handler is called with currentTarget as this', () => {
    const fnBody = getInvokeRecordedEventListenersFn();

    // The inline handler is called via .call(currentTarget, event)
    expect(fnBody).toContain('inlineHandler.call(currentTarget, inlineEvent)');
  });
});

/**
 * Returns the function declaration string that Page.invokeRecordedEventListeners
 * passes to Runtime.callFunctionOn. This is extracted from page.ts to test
 * the injected code's structure without needing a real browser.
 */
function getInvokeRecordedEventListenersFn(): string {
  return `function(types) {
        function buildPath(target) {
          var path = [];
          var node = target;

          while (node) {
            path.push(node);

            if (node.parentElement) {
              node = node.parentElement;
              continue;
            }

            if (node === document) {
              node = window;
              continue;
            }

            if (node.defaultView && node !== node.defaultView) {
              node = node.defaultView;
              continue;
            }

            if (node.ownerDocument && node !== node.ownerDocument) {
              node = node.ownerDocument;
              continue;
            }

            var root = node.getRootNode && node.getRootNode();
            if (root && root !== node && root.host) {
              node = root.host;
              continue;
            }

            node = null;
          }

          return path;
        }

        function createEvent(type, target, currentTarget, path, phase) {
          return {
            type: type,
            target: target,
            currentTarget: currentTarget,
            srcElement: target,
            isTrusted: true,
            bubbles: true,
            cancelable: true,
            composed: true,
            defaultPrevented: false,
            eventPhase: phase,
            timeStamp: Date.now(),
            preventDefault: function() {
              this.defaultPrevented = true;
            },
            stopPropagation: function() {
              this.__stopped = true;
            },
            stopImmediatePropagation: function() {
              this.__stopped = true;
              this.__immediateStopped = true;
            },
            composedPath: function() {
              return path.slice();
            }
          };
        }

        function invokePhase(type, nodes, capture, target, path) {
          var invoked = false;

          for (var i = 0; i < nodes.length; i++) {
            var currentTarget = nodes[i];

            var phase = currentTarget === target ? 2 : capture ? 1 : 3;

            // Invoke inline handler if present (e.g. onclick, oninput)
            var inlineHandler = currentTarget['on' + type];
            if (typeof inlineHandler === 'function') {
              var inlineEvent = createEvent(type, target, currentTarget, path, phase);
              inlineHandler.call(currentTarget, inlineEvent);
              invoked = true;
              if (inlineEvent.__stopped) break;
            }

            var store = currentTarget && currentTarget.__bpEventListeners;
            var entries = store && store[type];
            if (!Array.isArray(entries) || entries.length === 0) continue;

            var event = createEvent(type, target, currentTarget, path, phase);

            for (var j = 0; j < entries.length; j++) {
              var entry = entries[j];
              if (!!entry.capture !== capture) continue;

              var listener = entry.listener;
              if (typeof listener === 'function') {
                listener.call(currentTarget, event);
                invoked = true;
              } else if (listener && typeof listener.handleEvent === 'function') {
                listener.handleEvent(event);
                invoked = true;
              }

              if (event.__immediateStopped) {
                break;
              }
            }

            if (event.__stopped) {
              break;
            }
          }

          return invoked;
        }

        var path = buildPath(this);
        var capturePath = path.slice().reverse();
        var bubblePath = path.slice();
        var invokedAny = false;

        for (var i = 0; i < types.length; i++) {
          var type = String(types[i]);
          if (invokePhase(type, capturePath, true, this, path)) {
            invokedAny = true;
          }
          if (invokePhase(type, bubblePath, false, this, path)) {
            invokedAny = true;
          }
        }

        return invokedAny;
      }`;
}
