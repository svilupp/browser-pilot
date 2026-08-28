import { describe, expect, test } from 'bun:test';
import { webmcpCall, webmcpStatus } from '../../src/webmcp/client.ts';

function fakePage(results: unknown[]): { evaluate: <T>(expression: string) => Promise<T> } {
  let index = 0;
  return {
    evaluate: async <T>(_expression: string) => results[index++] as T,
  };
}

describe('WebMCP client', () => {
  test('reports page capability status', async () => {
    const page = fakePage([
      {
        status: {
          available: false,
          url: 'http://localhost:3000',
          secureContext: false,
          crossOriginIsolated: false,
          toolsPolicy: null,
          reason: 'secure context required',
        },
        tools: [],
      },
    ]);
    await expect(webmcpStatus(page as never)).resolves.toMatchObject({
      available: false,
      secureContext: false,
    });
  });

  test('refreshes tools and requires mutation acknowledgement', async () => {
    const page = fakePage([
      {
        status: {
          available: true,
          url: 'https://example.com',
          secureContext: true,
          crossOriginIsolated: false,
          toolsPolicy: true,
        },
        tools: [
          { name: 'save', origin: 'https://example.com', annotations: { readOnlyHint: false } },
        ],
      },
    ]);
    await expect(webmcpCall(page as never, 'save', { value: 1 })).rejects.toThrow(
      '--confirm-mutation'
    );
  });

  test('executes a read-only tool after re-listing it', async () => {
    const page = fakePage([
      {
        status: {
          available: true,
          url: 'https://example.com',
          secureContext: true,
          crossOriginIsolated: false,
          toolsPolicy: true,
        },
        tools: [
          { name: 'lookup', origin: 'https://example.com', annotations: { readOnlyHint: true } },
        ],
      },
      {
        rawResult: JSON.stringify('result'),
        tool: {
          name: 'lookup',
          origin: 'https://example.com',
          annotations: { readOnlyHint: true },
        },
      },
    ]);
    await expect(webmcpCall(page as never, 'lookup', { id: 1 })).resolves.toMatchObject({
      result: 'result',
      tool: { name: 'lookup' },
    });
  });

  test('requires an exact origin when names are ambiguous', async () => {
    const page = fakePage([
      {
        status: {
          available: true,
          url: 'https://example.com',
          secureContext: true,
          crossOriginIsolated: false,
          toolsPolicy: true,
        },
        tools: [
          { name: 'lookup', origin: 'https://a.example', annotations: { readOnlyHint: true } },
          { name: 'lookup', origin: 'https://b.example', annotations: { readOnlyHint: true } },
        ],
      },
    ]);
    await expect(
      webmcpCall(page as never, 'lookup', {}, { fromOrigins: ['https://a.example'] })
    ).rejects.toThrow('--origin');
  });

  test('rejects non-object inputs before execution', async () => {
    const page = fakePage([
      {
        status: {
          available: true,
          url: 'https://example.com',
          secureContext: true,
          crossOriginIsolated: false,
          toolsPolicy: true,
        },
        tools: [{ name: 'lookup', annotations: { readOnlyHint: true } }],
      },
    ]);
    await expect(webmcpCall(page as never, 'lookup', 'bad')).rejects.toThrow('JSON object');
  });
});
