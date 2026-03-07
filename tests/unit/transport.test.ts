import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createTransport } from '../../src/cdp/transport.ts';

const RealWebSocket = globalThis.WebSocket;

type Listener = (event?: { data?: string }) => void;

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  private listeners = new Map<string, Set<Listener>>();

  constructor(_url: string) {
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
    this.readyState = MockWebSocket.CLOSING;
    // Intentionally never emits "close" to exercise the fallback path.
  }

  private emit(type: string, event?: { data?: string }) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event);
    }
  }
}

describe('CDP transport', () => {
  beforeEach(() => {
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

  test('close resolves quickly when the runtime never emits a close event', async () => {
    const transport = await createTransport('ws://example.test');

    const start = Date.now();
    await transport.close();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
  });
});
