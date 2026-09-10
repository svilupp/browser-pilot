import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createTransport } from '../../src/cdp/transport.ts';

const RealWebSocket = globalThis.WebSocket;

type Listener = (event?: { data?: string }) => void;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static autoOpen = true;
  static lastInstance: MockWebSocket;
  closeCalls = 0;
  readyState = MockWebSocket.CONNECTING;
  private listeners = new Map<string, Set<Listener>>();

  constructor(_url: string) {
    MockWebSocket.lastInstance = this;
    if (!MockWebSocket.autoOpen) return;
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.emit('open');
    });
  }

  addEventListener(type: string, handler: Listener) {
    let handlers = this.listeners.get(type);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(type, handlers);
    }
    handlers.add(handler);
  }

  removeEventListener(type: string, handler: Listener) {
    this.listeners.get(type)?.delete(handler);
  }

  send(_message: string) {}

  close() {
    this.closeCalls++;
    this.readyState = MockWebSocket.CLOSING;
    // Intentionally never emits "close" to exercise the fallback path.
  }

  emit(type: string, event?: { data?: string }) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }
}

describe('CDP transport', () => {
  beforeEach(() => {
    MockWebSocket.autoOpen = true;
    (
      globalThis as typeof globalThis & {
        WebSocket: typeof WebSocket;
      }
    ).WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    (
      globalThis as typeof globalThis & {
        WebSocket: typeof WebSocket;
      }
    ).WebSocket = RealWebSocket;
  });

  test('connection timeout closes the pending socket and rejects late opens', async () => {
    MockWebSocket.autoOpen = false;
    await expect(createTransport('ws://example.test', { timeout: 5 })).rejects.toThrow(
      'connection timeout'
    );
    expect(MockWebSocket.lastInstance.closeCalls).toBe(1);
    MockWebSocket.lastInstance.readyState = MockWebSocket.OPEN;
    MockWebSocket.lastInstance.emit('open');
    expect(MockWebSocket.lastInstance.closeCalls).toBe(2);
  });

  test('a socket closing during the handshake rejects promptly', async () => {
    MockWebSocket.autoOpen = false;
    const connecting = createTransport('ws://example.test');
    MockWebSocket.lastInstance.emit('close');
    await expect(connecting).rejects.toThrow('closed before connection opened');
  });

  test('close resolves quickly when the runtime never emits a close event', async () => {
    const transport = await createTransport('ws://example.test');

    const start = Date.now();
    await transport.close();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
  });
});
