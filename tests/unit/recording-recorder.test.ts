/**
 * Unit tests for Recorder CDP integration
 *
 * Tests that the Recorder class correctly integrates with the CDP client:
 * - Calls required CDP methods on start()
 * - Receives and parses Runtime.bindingCalled events
 * - Returns proper RecordingOutput on stop()
 */

import { describe, expect, test } from 'bun:test';
import { Recorder } from '../../src/recording/recorder.ts';

/**
 * Create a mock CDP client that tracks sent commands and can emit events.
 * Based on the pattern from tests/unit/cdp-client.test.ts
 */
function createMockCDPClient() {
  const responses = new Map<string, unknown>();
  const eventHandlers = new Map<string, Set<(params: Record<string, unknown>) => void>>();

  return {
    sent: [] as Array<{ method: string; params?: unknown }>,

    async send<T = unknown>(method: string, params?: unknown): Promise<T> {
      this.sent.push({ method, params });

      if (responses.has(method)) {
        return responses.get(method) as T;
      }

      // Default responses for common methods
      if (method === 'Runtime.evaluate') {
        return { result: { value: 'https://example.com/start' } } as T;
      }

      return {} as T;
    },

    on(event: string, handler: (params: Record<string, unknown>) => void) {
      if (!eventHandlers.has(event)) {
        eventHandlers.set(event, new Set());
      }
      eventHandlers.get(event)!.add(handler);
    },

    off(event: string, handler: (params: Record<string, unknown>) => void) {
      eventHandlers.get(event)?.delete(handler);
    },

    emit(event: string, params: Record<string, unknown>) {
      eventHandlers.get(event)?.forEach((h) => {
        h(params);
      });
    },

    mockResponse(method: string, response: unknown) {
      responses.set(method, response);
    },

    getEventHandlerCount(event: string): number {
      return eventHandlers.get(event)?.size ?? 0;
    },
  };
}

describe('Recorder CDP Integration', () => {
  describe('p1-recorder-cdp-setup: start() calls correct CDP methods', () => {
    test('should call Runtime.enable on start', async () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      await recorder.start();

      const runtimeEnableCall = cdp.sent.find((c) => c.method === 'Runtime.enable');
      expect(runtimeEnableCall).toBeDefined();
    });

    test('should call Page.enable on start', async () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      await recorder.start();

      const pageEnableCall = cdp.sent.find((c) => c.method === 'Page.enable');
      expect(pageEnableCall).toBeDefined();
    });

    test('should call Runtime.addBinding with __recorder name', async () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      await recorder.start();

      const addBindingCall = cdp.sent.find((c) => c.method === 'Runtime.addBinding');
      expect(addBindingCall).toBeDefined();
      expect(addBindingCall?.params).toEqual({ name: recorder.bindingName });
    });

    test('should call Page.addScriptToEvaluateOnNewDocument with recorder script', async () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      await recorder.start();

      const addScriptCall = cdp.sent.find(
        (c) => c.method === 'Page.addScriptToEvaluateOnNewDocument'
      );
      expect(addScriptCall).toBeDefined();
      expect((addScriptCall?.params as { source: string })?.source).toContain(recorder.bindingName);
    });

    test('should call Runtime.evaluate to inject script into current document', async () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      await recorder.start();

      // Find the evaluate call that injects the recorder script
      const evaluateCalls = cdp.sent.filter((c) => c.method === 'Runtime.evaluate');
      const scriptInjectionCall = evaluateCalls.find((c) =>
        (c.params as { expression?: string })?.expression?.includes(recorder.bindingName)
      );
      expect(scriptInjectionCall).toBeDefined();
    });

    test('should call all required CDP methods in correct order', async () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      await recorder.start();

      // Extract methods in order
      const methods = cdp.sent.map((c) => c.method);

      // Verify order: enable domains first, then binding, then scripts
      const runtimeEnableIdx = methods.indexOf('Runtime.enable');
      const pageEnableIdx = methods.indexOf('Page.enable');
      const addBindingIdx = methods.indexOf('Runtime.addBinding');
      const addScriptIdx = methods.indexOf('Page.addScriptToEvaluateOnNewDocument');

      expect(runtimeEnableIdx).toBeLessThan(addBindingIdx);
      expect(pageEnableIdx).toBeLessThan(addScriptIdx);
      expect(addBindingIdx).toBeLessThan(addScriptIdx);
    });

    test('should throw if start() called while already recording', async () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      await recorder.start();

      await expect(recorder.start()).rejects.toThrow('Recording already in progress');
    });
  });

  describe('p1-recorder-event-receive: receives and parses binding events', () => {
    test('should register handler for Runtime.bindingCalled events', async () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      await recorder.start();

      expect(cdp.getEventHandlerCount('Runtime.bindingCalled')).toBe(3);
    });

    test('should add events to getEvents() when binding is called', async () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      await recorder.start();

      // Simulate binding call from browser
      const testEvent = {
        kind: 'click',
        timestamp: Date.now(),
        url: 'https://example.com',
        selectors: [{ selector: '#button', quality: 'id' }],
        element: { tag: 'button', id: 'button' },
      };

      cdp.emit('Runtime.bindingCalled', {
        name: recorder.bindingName,
        payload: JSON.stringify(testEvent),
      });

      const events = recorder.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'click',
        url: 'https://example.com',
      });
    });

    test('should parse multiple events correctly', async () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      await recorder.start();

      // Simulate multiple binding calls
      const clickEvent = {
        kind: 'click',
        timestamp: Date.now(),
        url: 'https://example.com',
        selectors: [{ selector: '#button', quality: 'id' }],
      };

      const inputEvent = {
        kind: 'input',
        timestamp: Date.now() + 100,
        url: 'https://example.com',
        selectors: [{ selector: '#email', quality: 'id' }],
        value: 'test@example.com',
      };

      cdp.emit('Runtime.bindingCalled', {
        name: recorder.bindingName,
        payload: JSON.stringify(clickEvent),
      });

      cdp.emit('Runtime.bindingCalled', {
        name: recorder.bindingName,
        payload: JSON.stringify(inputEvent),
      });

      const events = recorder.getEvents();
      expect(events).toHaveLength(2);
      expect(events[0]?.kind).toBe('click');
      expect(events[1]?.kind).toBe('input');
      expect(events[1]?.value).toBe('test@example.com');
    });

    test('should ignore binding calls with wrong name', async () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      await recorder.start();

      cdp.emit('Runtime.bindingCalled', {
        name: 'other_binding',
        payload: JSON.stringify({ kind: 'click', timestamp: Date.now() }),
      });

      expect(recorder.getEvents()).toHaveLength(0);
    });

    test('should ignore invalid JSON payloads', async () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      await recorder.start();

      cdp.emit('Runtime.bindingCalled', {
        name: recorder.bindingName,
        payload: 'invalid json {{{',
      });

      expect(recorder.getEvents()).toHaveLength(0);
    });

    test('should ignore events after recording is stopped', async () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      await recorder.start();
      await recorder.stop();

      cdp.emit('Runtime.bindingCalled', {
        name: recorder.bindingName,
        payload: JSON.stringify({
          kind: 'click',
          timestamp: Date.now(),
          url: 'https://example.com',
          selectors: [],
        }),
      });

      // Events received after stop should be ignored
      expect(recorder.getEvents()).toHaveLength(0);
    });
  });

  describe('p1-recorder-stop-output: stop() returns RecordingOutput', () => {
    test('should return RecordingOutput with recordedAt timestamp', async () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      await recorder.start();
      const output = await recorder.stop();

      expect(output.recordedAt).toBeDefined();
      // Should be ISO timestamp format
      expect(new Date(output.recordedAt).toISOString()).toBe(output.recordedAt);
    });

    test('should return RecordingOutput with startUrl', async () => {
      const cdp = createMockCDPClient();
      cdp.mockResponse('Runtime.evaluate', {
        result: { value: 'https://example.com/test-page' },
      });
      const recorder = new Recorder(cdp as never);

      await recorder.start();
      const output = await recorder.stop();

      expect(output.startUrl).toBe('https://example.com/test-page');
    });

    test('should return RecordingOutput with duration', async () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      await recorder.start();
      // Add small delay to ensure measurable duration
      // Use 100ms delay but check >= 50 to account for CI timer imprecision
      await new Promise((resolve) => setTimeout(resolve, 100));
      const output = await recorder.stop();

      expect(output.duration).toBeGreaterThanOrEqual(50);
      expect(typeof output.duration).toBe('number');
    });

    test('should return RecordingOutput with aggregated steps', async () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      await recorder.start();

      // Add test events - URL matches the mock's default startUrl
      cdp.emit('Runtime.bindingCalled', {
        name: recorder.bindingName,
        payload: JSON.stringify({
          kind: 'click',
          timestamp: Date.now(),
          url: 'https://example.com/start',
          selectors: [{ selector: '[data-testid="submit"]', quality: 'stable-attr' }],
        }),
      });

      const output = await recorder.stop();

      expect(output.steps).toBeDefined();
      expect(Array.isArray(output.steps)).toBe(true);
      expect(output.steps).toHaveLength(1);
      expect(output.steps[0]).toMatchObject({
        action: 'click',
        selector: '[data-testid="submit"]',
      });
    });

    test('should clean up event handler on stop', async () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      await recorder.start();
      expect(cdp.getEventHandlerCount('Runtime.bindingCalled')).toBe(3);

      await recorder.stop();
      expect(cdp.getEventHandlerCount('Runtime.bindingCalled')).toBe(0);
    });

    test('should throw if stop() called without start()', async () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      await expect(recorder.stop()).rejects.toThrow('No recording in progress');
    });
  });

  describe('isRecording property', () => {
    test('should return false before start', () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      expect(recorder.isRecording).toBe(false);
    });

    test('should return true after start', async () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      await recorder.start();

      expect(recorder.isRecording).toBe(true);
    });

    test('should return false after stop', async () => {
      const cdp = createMockCDPClient();
      const recorder = new Recorder(cdp as never);

      await recorder.start();
      await recorder.stop();

      expect(recorder.isRecording).toBe(false);
    });
  });
});

describe('recording lifecycle regressions', () => {
  test('drains ordered asynchronous captures and retains failed actions', async () => {
    const cdp = createMockCDPClient();
    cdp.mockResponse('Page.addScriptToEvaluateOnNewDocument', { identifier: 'owned-script' });
    const order: number[] = [];
    const recorder = new Recorder(cdp as never, {
      onEvent: async (_event, context) => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(context.sequence);
        if (context.sequence === 2) throw new Error('image failed');
      },
    });
    await recorder.start();
    for (let i = 0; i < 2; i++)
      cdp.emit('Runtime.bindingCalled', {
        name: recorder.bindingName,
        payload: JSON.stringify({
          kind: 'click',
          timestamp: Date.now() + i,
          url: 'https://example.com/',
          selectors: [{ quality: 'id', selector: `#button${i}` }],
        }),
      });
    const output = await recorder.stop();
    expect(order).toEqual([1, 2]);
    expect(output.steps.filter((step) => step.action === 'click')).toHaveLength(2);
    expect(output.capture).toMatchObject({
      completed: 1,
      failed: 1,
      pending: 0,
      drainTimedOut: false,
    });
    expect(
      cdp.sent.filter((c) => c.method === 'Page.removeScriptToEvaluateOnNewDocument')
    ).toHaveLength(2);
    expect(cdp.sent.some((c) => c.method === 'Network.disable')).toBe(false);
  });
  test('deadline cancels pending capture and marks incomplete without dropping the action', async () => {
    const cdp = createMockCDPClient();
    let signal: AbortSignal | undefined;
    const recorder = new Recorder(cdp as never, {
      drainTimeoutMs: 10,
      onEvent: async (_event, context) => {
        signal = context.signal;
        await new Promise<void>(() => {});
      },
    });
    await recorder.start();
    cdp.emit('Runtime.bindingCalled', {
      name: recorder.bindingName,
      payload: JSON.stringify({
        kind: 'click',
        timestamp: Date.now(),
        url: 'https://example.com/',
        selectors: [{ quality: 'id', selector: '#button' }],
      }),
    });
    const output = await recorder.stop();
    expect(output.steps.filter((step) => step.action === 'click')).toHaveLength(1);
    expect(output.capture).toMatchObject({ drainTimedOut: true, pending: 1 });
    expect(signal?.aborted).toBe(true);
  });
  test('restart clears previous HTTP and DOM data and uses a distinct owned binding', async () => {
    const cdp = createMockCDPClient();
    const one = new Recorder(cdp as never, { listen: true });
    await one.start();
    cdp.emit('Network.requestWillBeSent', {
      requestId: 'old',
      request: { url: 'https://example.com/old', method: 'GET' },
    });
    await one.stop();
    await one.start();
    const second = await one.stop();
    expect(second.network?.requests).toHaveLength(0);
    expect(second.steps).toHaveLength(0);
    const other = new Recorder(cdp as never);
    expect(other.bindingName).not.toBe(one.bindingName);
  });
  test('metadata excludes URL secrets, field values, console args and websocket content', async () => {
    const cdp = createMockCDPClient();
    cdp.mockResponse('Runtime.evaluate', {
      result: {
        value:
          'https://user:SECRET_CREDENTIAL@example.com/start?token=SECRET_START#SECRET_FRAGMENT',
      },
    });
    const recorder = new Recorder(cdp as never, { listen: true, privacy: 'metadata' });
    await recorder.start();
    cdp.emit('Runtime.bindingCalled', {
      name: recorder.bindingName,
      payload: JSON.stringify({
        kind: 'input',
        timestamp: Date.now(),
        url: 'https://example.com/?token=SECRET_URL',
        value: 'SECRET_FIELD',
        selectors: [{ quality: 'id', selector: '#quantity' }],
      }),
    });
    cdp.emit('Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ type: 'string', value: 'SECRET_CONSOLE' }],
    });
    cdp.emit('Network.webSocketCreated', {
      requestId: 'ws',
      url: 'wss://example.com/?auth=SECRET_WS_URL',
    });
    cdp.emit('Network.webSocketFrameReceived', {
      requestId: 'ws',
      response: { opcode: 1, payloadData: 'SECRET_WS_FRAME' },
    });
    cdp.emit('Network.requestWillBeSent', {
      requestId: 'request',
      request: {
        url: 'https://example.com/?token=SECRET_HTTP',
        method: 'POST',
        headers: { Authorization: 'SECRET_HEADER' },
        postData: 'SECRET_BODY',
      },
    });
    expect(JSON.stringify(await recorder.stop())).not.toContain('SECRET_');
  });
  test('current-document mode owns no future injection and capture is byte bounded', async () => {
    const cdp = createMockCDPClient();
    const recorder = new Recorder(cdp as never, { navigation: 'current-document', maxBytes: 200 });
    await recorder.start();
    expect(cdp.sent.some((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument')).toBe(false);
    cdp.emit('Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ type: 'string', value: 'x'.repeat(500) }],
    });
    expect(recorder.limitReached).toBe(true);
    expect(recorder.byteCount).toBeLessThanOrEqual(200);
    await recorder.stop();
  });
});
