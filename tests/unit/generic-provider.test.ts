import { describe, expect, test } from 'bun:test';
import { getBrowserWebSocketUrl } from '../../src/providers/generic.ts';

describe('getBrowserWebSocketUrl', () => {
  test('retries transient DevTools endpoint failures', async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;

    // @ts-expect-error minimal mock for fetch
    globalThis.fetch = async () => {
      callCount++;
      if (callCount < 3) {
        return new Response('Chrome still starting', { status: 500 });
      }

      return new Response(
        JSON.stringify({
          webSocketDebuggerUrl: 'ws://localhost:9222/devtools/browser/test',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    };

    try {
      await expect(getBrowserWebSocketUrl('localhost:9222')).resolves.toBe(
        'ws://localhost:9222/devtools/browser/test'
      );
      expect(callCount).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('throws after exhausting retries', async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;

    // @ts-expect-error minimal mock for fetch
    globalThis.fetch = async () => {
      callCount++;
      return new Response('Chrome error', { status: 500 });
    };

    try {
      await expect(getBrowserWebSocketUrl('localhost:9222')).rejects.toThrow(
        'Failed to get browser info: 500'
      );
      expect(callCount).toBe(10);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
