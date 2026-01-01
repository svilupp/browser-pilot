/**
 * Unit tests for Console & Dialog Handling
 */

import { describe, expect, test } from 'bun:test';
import type {
  ConsoleMessage,
  ConsoleMessageType,
  Dialog,
  PageError,
} from '../../src/browser/types.ts';
import type { CDPClient } from '../../src/cdp/client.ts';

// Create a mock CDP client for testing
type CDPCall = { method: string; params?: Record<string, unknown> };
type EventHandler = (params: Record<string, unknown>) => void | Promise<void>;

function createMockCDPClient() {
  const responses = new Map<string, unknown>();
  const eventHandlers = new Map<string, Set<EventHandler>>();

  return {
    sent: [] as CDPCall[],

    async send(method: string, params?: Record<string, unknown>) {
      this.sent.push({ method, params });

      if (responses.has(method)) {
        return responses.get(method);
      }

      return {};
    },

    on(event: string, handler: EventHandler) {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, new Set());
      }
      eventHandlers.get(event)!.add(handler);
    },

    off(event: string, handler: EventHandler) {
      eventHandlers.get(event)?.delete(handler);
    },

    emit(event: string, params: Record<string, unknown>) {
      const handlers = eventHandlers.get(event);
      if (handlers) {
        for (const h of handlers) {
          h(params);
        }
      }
    },

    async emitAsync(event: string, params: Record<string, unknown>) {
      const handlers = eventHandlers.get(event);
      if (handlers) {
        for (const h of handlers) {
          await h(params);
        }
      }
    },

    mockResponse(method: string, response: unknown) {
      responses.set(method, response);
    },

    findCall(method: string): CDPCall | undefined {
      return this.sent.find((c) => c.method === method);
    },

    findAllCalls(method: string): CDPCall[] {
      return this.sent.filter((c) => c.method === method);
    },

    clear() {
      this.sent = [];
    },
  };
}

// Create test page helper
async function createTestPage(cdp: ReturnType<typeof createMockCDPClient>) {
  const { Page } = await import('../../src/browser/page.ts');
  const page = new Page(cdp as unknown as CDPClient);
  await page.init(); // Initialize event listeners including dialog handler
  return page;
}

describe('Console Message Handling', () => {
  describe('page.onConsole()', () => {
    test('should receive console.log messages', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);
      const messages: ConsoleMessage[] = [];

      await page.onConsole((msg) => messages.push(msg));

      // Simulate console message
      cdp.emit('Runtime.consoleAPICalled', {
        type: 'log',
        args: [{ value: 'Hello' }, { value: 'World' }],
        timestamp: 1234567890,
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe('log');
      expect(messages[0]!.text).toBe('Hello World');
      expect(messages[0]!.args).toEqual(['Hello', 'World']);
    });

    test('should handle different console types', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);
      const messages: ConsoleMessage[] = [];

      await page.onConsole((msg) => messages.push(msg));

      // Log different types
      const types: ConsoleMessageType[] = ['log', 'debug', 'info', 'error', 'warning'];
      for (const type of types) {
        cdp.emit('Runtime.consoleAPICalled', {
          type,
          args: [{ value: `${type} message` }],
          timestamp: Date.now(),
        });
      }

      expect(messages).toHaveLength(5);
      expect(messages.map((m) => m.type)).toEqual(types);
    });

    test('should format object descriptions', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);
      const messages: ConsoleMessage[] = [];

      await page.onConsole((msg) => messages.push(msg));

      cdp.emit('Runtime.consoleAPICalled', {
        type: 'log',
        args: [{ description: 'Object { foo: "bar" }' }, { description: 'Array(3)' }],
        timestamp: Date.now(),
      });

      expect(messages[0]!.text).toBe('Object { foo: "bar" } Array(3)');
    });

    test('should include stack trace when available', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);
      const messages: ConsoleMessage[] = [];

      await page.onConsole((msg) => messages.push(msg));

      cdp.emit('Runtime.consoleAPICalled', {
        type: 'error',
        args: [{ value: 'Error message' }],
        timestamp: Date.now(),
        stackTrace: {
          callFrames: [
            { url: 'https://example.com/script.js', lineNumber: 10 },
            { url: 'https://example.com/app.js', lineNumber: 25 },
          ],
        },
      });

      expect(messages[0]!.stackTrace).toEqual([
        'https://example.com/script.js:10',
        'https://example.com/app.js:25',
      ]);
    });

    test('should return unsubscribe function', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);
      const messages: ConsoleMessage[] = [];

      const unsubscribe = await page.onConsole((msg) => messages.push(msg));

      // First message should be captured
      cdp.emit('Runtime.consoleAPICalled', {
        type: 'log',
        args: [{ value: 'First' }],
        timestamp: Date.now(),
      });

      unsubscribe();

      // Second message should NOT be captured
      cdp.emit('Runtime.consoleAPICalled', {
        type: 'log',
        args: [{ value: 'Second' }],
        timestamp: Date.now(),
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]!.text).toBe('First');
    });
  });

  describe('page.collectConsole()', () => {
    test('should collect console messages during action', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);

      const { result, messages } = await page.collectConsole(async () => {
        // Emit some console messages during the action
        cdp.emit('Runtime.consoleAPICalled', {
          type: 'log',
          args: [{ value: 'During action' }],
          timestamp: Date.now(),
        });
        return 'action result';
      });

      expect(result).toBe('action result');
      expect(messages).toHaveLength(1);
      expect(messages[0]!.text).toBe('During action');
    });

    test('should stop collecting after action completes', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);

      const { messages } = await page.collectConsole(async () => {
        cdp.emit('Runtime.consoleAPICalled', {
          type: 'log',
          args: [{ value: 'Inside' }],
          timestamp: Date.now(),
        });
        return null;
      });

      // Message after collection should not be included
      cdp.emit('Runtime.consoleAPICalled', {
        type: 'log',
        args: [{ value: 'Outside' }],
        timestamp: Date.now(),
      });

      expect(messages).toHaveLength(1);
      expect(messages[0]!.text).toBe('Inside');
    });
  });
});

describe('Error Handling', () => {
  describe('page.onError()', () => {
    test('should receive JavaScript exceptions', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);
      const errors: PageError[] = [];

      await page.onError((err) => errors.push(err));

      cdp.emit('Runtime.exceptionThrown', {
        timestamp: Date.now(),
        exceptionDetails: {
          text: 'Uncaught Error',
          exception: { description: 'Error: Something went wrong' },
          url: 'https://example.com/script.js',
          lineNumber: 42,
          columnNumber: 10,
        },
      });

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe('Error: Something went wrong');
      expect(errors[0]!.url).toBe('https://example.com/script.js');
      expect(errors[0]!.lineNumber).toBe(42);
    });

    test('should use text if exception description not available', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);
      const errors: PageError[] = [];

      await page.onError((err) => errors.push(err));

      cdp.emit('Runtime.exceptionThrown', {
        timestamp: Date.now(),
        exceptionDetails: {
          text: 'Syntax Error: Unexpected token',
        },
      });

      expect(errors[0]!.message).toBe('Syntax Error: Unexpected token');
    });

    test('should include stack trace', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);
      const errors: PageError[] = [];

      await page.onError((err) => errors.push(err));

      cdp.emit('Runtime.exceptionThrown', {
        timestamp: Date.now(),
        exceptionDetails: {
          exception: { description: 'Error' },
          stackTrace: {
            callFrames: [
              { url: 'https://example.com/a.js', lineNumber: 1 },
              { url: 'https://example.com/b.js', lineNumber: 2 },
            ],
          },
        },
      });

      expect(errors[0]!.stackTrace).toEqual([
        'https://example.com/a.js:1',
        'https://example.com/b.js:2',
      ]);
    });

    test('should return unsubscribe function', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);
      const errors: PageError[] = [];

      const unsubscribe = await page.onError((err) => errors.push(err));

      cdp.emit('Runtime.exceptionThrown', {
        timestamp: Date.now(),
        exceptionDetails: { exception: { description: 'First' } },
      });

      unsubscribe();

      cdp.emit('Runtime.exceptionThrown', {
        timestamp: Date.now(),
        exceptionDetails: { exception: { description: 'Second' } },
      });

      expect(errors).toHaveLength(1);
    });
  });

  describe('page.collectErrors()', () => {
    test('should collect errors during action', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);

      const { result, errors } = await page.collectErrors(async () => {
        cdp.emit('Runtime.exceptionThrown', {
          timestamp: Date.now(),
          exceptionDetails: { exception: { description: 'Error during action' } },
        });
        return 42;
      });

      expect(result).toBe(42);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe('Error during action');
    });
  });
});

describe('Dialog Handling', () => {
  describe('page.onDialog()', () => {
    test('should receive alert dialogs', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);
      let receivedDialog: Dialog | null = null;

      await page.onDialog(async (dialog) => {
        receivedDialog = dialog;
        await dialog.accept();
      });

      await cdp.emitAsync('Page.javascriptDialogOpening', {
        type: 'alert',
        message: 'Hello!',
      });

      expect(receivedDialog).not.toBeNull();
      expect(receivedDialog!.type).toBe('alert');
      expect(receivedDialog!.message).toBe('Hello!');

      // Should have called accept
      const handleCall = cdp.findCall('Page.handleJavaScriptDialog');
      expect(handleCall).toBeDefined();
      expect(handleCall?.params).toMatchObject({ accept: true });
    });

    test('should receive confirm dialogs', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);
      let dialogType = '';

      await page.onDialog(async (dialog) => {
        dialogType = dialog.type;
        await dialog.dismiss();
      });

      await cdp.emitAsync('Page.javascriptDialogOpening', {
        type: 'confirm',
        message: 'Are you sure?',
      });

      expect(dialogType).toBe('confirm');

      const handleCall = cdp.findCall('Page.handleJavaScriptDialog');
      expect(handleCall?.params).toMatchObject({ accept: false });
    });

    test('should receive prompt dialogs with default value', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);
      let receivedDialog: Dialog | null = null;

      await page.onDialog(async (dialog) => {
        receivedDialog = dialog;
        await dialog.accept('My answer');
      });

      await cdp.emitAsync('Page.javascriptDialogOpening', {
        type: 'prompt',
        message: 'Enter your name:',
        defaultPrompt: 'Anonymous',
      });

      expect(receivedDialog!.type).toBe('prompt');
      expect(receivedDialog!.defaultValue).toBe('Anonymous');

      const handleCall = cdp.findCall('Page.handleJavaScriptDialog');
      expect(handleCall?.params).toMatchObject({
        accept: true,
        promptText: 'My answer',
      });
    });

    test('should auto-dismiss when no handler set', async () => {
      const cdp = createMockCDPClient();
      await createTestPage(cdp); // init() sets up dialog listener

      // No dialog handler set - should auto-dismiss by default
      // (dialog listener is now set up in init(), not enableConsole())

      await cdp.emitAsync('Page.javascriptDialogOpening', {
        type: 'alert',
        message: 'Auto-dismiss test',
      });

      const handleCall = cdp.findCall('Page.handleJavaScriptDialog');
      expect(handleCall?.params).toMatchObject({ accept: false });
    });

    test('should auto-dismiss on handler error', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);

      await page.onDialog(async () => {
        throw new Error('Handler error');
      });

      await cdp.emitAsync('Page.javascriptDialogOpening', {
        type: 'alert',
        message: 'Error test',
      });

      // Should still dismiss the dialog
      const handleCall = cdp.findCall('Page.handleJavaScriptDialog');
      expect(handleCall?.params).toMatchObject({ accept: false });
    });

    test('should allow setting handler to null', async () => {
      const cdp = createMockCDPClient();
      const page = await createTestPage(cdp);
      let handlerCalled = false;

      await page.onDialog(async () => {
        handlerCalled = true;
      });

      // Set handler to null
      await page.onDialog(null);

      await cdp.emitAsync('Page.javascriptDialogOpening', {
        type: 'alert',
        message: 'Test',
      });

      expect(handlerCalled).toBe(false);
    });
  });
});

describe('Multiple handlers', () => {
  test('should support multiple console handlers', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);
    const messages1: string[] = [];
    const messages2: string[] = [];

    await page.onConsole((msg) => messages1.push(msg.text));
    await page.onConsole((msg) => messages2.push(msg.text));

    cdp.emit('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ value: 'Test' }],
      timestamp: Date.now(),
    });

    expect(messages1).toEqual(['Test']);
    expect(messages2).toEqual(['Test']);
  });

  test('should support multiple error handlers', async () => {
    const cdp = createMockCDPClient();
    const page = await createTestPage(cdp);
    const errors1: string[] = [];
    const errors2: string[] = [];

    await page.onError((err) => errors1.push(err.message));
    await page.onError((err) => errors2.push(err.message));

    cdp.emit('Runtime.exceptionThrown', {
      timestamp: Date.now(),
      exceptionDetails: { exception: { description: 'Test error' } },
    });

    expect(errors1).toEqual(['Test error']);
    expect(errors2).toEqual(['Test error']);
  });
});
