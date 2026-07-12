/**
 * Unit tests for CDP client
 */

import { describe, expect, mock, test } from 'bun:test';
import { createCDPClientFromTransport } from '../../src/cdp/client.ts';
import { CDPError } from '../../src/cdp/protocol.ts';

describe('CDPError', () => {
  test('should create error with code and message', () => {
    const error = new CDPError({ code: -32000, message: 'Test error' });

    expect(error.name).toBe('CDPError');
    expect(error.message).toBe('Test error');
    expect(error.code).toBe(-32000);
  });

  test('should include data if provided', () => {
    const error = new CDPError({
      code: -32000,
      message: 'Test error',
      data: 'Additional info',
    });

    expect(error.data).toBe('Additional info');
  });
});

describe('CDP Protocol Types', () => {
  test('should define correct message structure', () => {
    // Request format
    const request = {
      id: 1,
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
    };

    expect(request.id).toBe(1);
    expect(request.method).toBe('Page.navigate');
    expect(request.params.url).toBe('https://example.com');

    // Response format
    const response = {
      id: 1,
      result: { frameId: 'abc123' },
    };

    expect(response.id).toBe(1);
    expect(response.result.frameId).toBe('abc123');

    // Event format
    const event = {
      method: 'Page.loadEventFired',
      params: { timestamp: 123456 },
    };

    expect(event.method).toBe('Page.loadEventFired');
    expect(event.params.timestamp).toBe(123456);
  });
});

describe('Mock CDP Client', () => {
  // Create a simple mock CDP client for testing
  function createMockCDPClient() {
    const responses = new Map<string, unknown>();
    const eventHandlers = new Map<string, Set<(params: unknown) => void>>();

    return {
      sent: [] as Array<{ method: string; params?: unknown }>,

      async send(method: string, params?: unknown) {
        this.sent.push({ method, params });

        if (responses.has(method)) {
          return responses.get(method);
        }

        return {};
      },

      on(event: string, handler: (params: unknown) => void) {
        if (!eventHandlers.has(event)) {
          eventHandlers.set(event, new Set());
        }
        eventHandlers.get(event)!.add(handler);
      },

      off(event: string, handler: (params: unknown) => void) {
        eventHandlers.get(event)?.delete(handler);
      },

      emit(event: string, params: unknown) {
        eventHandlers.get(event)?.forEach((h) => {
          h(params);
        });
      },

      mockResponse(method: string, response: unknown) {
        responses.set(method, response);
      },
    };
  }

  test('should track sent commands', async () => {
    const client = createMockCDPClient();

    await client.send('Page.navigate', { url: 'https://example.com' });
    await client.send('Page.enable');

    expect(client.sent).toHaveLength(2);
    expect(client.sent[0]).toEqual({
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
    });
    expect(client.sent[1]).toEqual({
      method: 'Page.enable',
      params: undefined,
    });
  });

  test('should return mocked responses', async () => {
    const client = createMockCDPClient();

    client.mockResponse('Page.navigate', { frameId: 'abc123' });

    const result = await client.send('Page.navigate', { url: 'https://example.com' });

    expect(result).toEqual({ frameId: 'abc123' });
  });

  test('should handle event subscriptions', () => {
    const client = createMockCDPClient();
    const handler = mock(() => {});

    client.on('Page.loadEventFired', handler);
    client.emit('Page.loadEventFired', { timestamp: 123 });

    expect(handler).toHaveBeenCalledWith({ timestamp: 123 });
  });

  test('should unsubscribe from events', () => {
    const client = createMockCDPClient();
    const handler = mock(() => {});

    client.on('Page.loadEventFired', handler);
    client.off('Page.loadEventFired', handler);
    client.emit('Page.loadEventFired', { timestamp: 123 });

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('CDPClient per-call timeout override', () => {
  // A transport that captures outgoing frames and lets the test decide when (or
  // whether) to reply, so we can observe timeout behavior deterministically.
  function createFakeTransport() {
    let onMsg: ((m: string) => void) | undefined;
    return {
      sent: [] as Array<{ id: number; method: string; sessionId?: string }>,
      send(message: string) {
        this.sent.push(JSON.parse(message));
      },
      async close() {},
      onMessage(handler: (m: string) => void) {
        onMsg = handler;
      },
      onClose() {},
      onError() {},
      reply(id: number, result: unknown) {
        onMsg?.(JSON.stringify({ id, result }));
      },
    };
  }

  test('per-call timeout fires faster than the client-wide default', async () => {
    const transport = createFakeTransport();
    const client = createCDPClientFromTransport(transport, { timeout: 30000 });

    const start = Date.now();
    let message = '';
    try {
      // No reply is ever sent, so this can only resolve by timing out.
      await client.send('Page.navigate', { url: 'about:blank' }, undefined, { timeout: 40 });
      throw new Error('expected timeout');
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    const elapsed = Date.now() - start;

    expect(message).toContain('timed out after 40ms');
    // Must reflect the per-call override, not the 30s client-wide default.
    expect(elapsed).toBeLessThan(1000);
  });

  test('falls back to the client-wide timeout when no per-call option is given', async () => {
    const transport = createFakeTransport();
    const client = createCDPClientFromTransport(transport, { timeout: 25 });

    let message = '';
    try {
      await client.send('Page.navigate', { url: 'about:blank' });
      throw new Error('expected timeout');
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }

    expect(message).toContain('timed out after 25ms');
  });

  test('per-call timeout does not fire when a response arrives in time', async () => {
    const transport = createFakeTransport();
    const client = createCDPClientFromTransport(transport, { timeout: 30000 });

    const p = client.send<{ ok: boolean }>('Runtime.evaluate', {}, undefined, { timeout: 500 });
    // Reply to the just-sent message id before the short timeout elapses.
    const sent = transport.sent.at(-1);
    if (!sent) throw new Error('no frame sent');
    transport.reply(sent.id, { ok: true });

    expect(await p).toEqual({ ok: true });
  });
});
