/**
 * Unit tests for redactCdpMessage: cookie-value redaction for CDP debug logs.
 */
import { describe, expect, test } from 'bun:test';
import { redactCdpMessage } from '../../src/cdp/client.ts';

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe('redactCdpMessage', () => {
  test('redacts Storage.getCookies response result via pending-map method lookup', () => {
    const msg = {
      id: 7,
      result: {
        cookies: [
          { name: 'session', value: 'super-secret-token', domain: 'example.com' },
          { name: 'other', value: 'another-secret', domain: 'example.com' },
        ],
      },
    };

    const pending = new Map([[7, { method: 'Storage.getCookies' }]]);
    const redacted = redactCdpMessage(msg, (id: number) => pending.get(id)?.method);

    const result = asRecord(redacted['result']);
    const cookies = result['cookies'] as Record<string, unknown>[];
    expect(cookies[0]?.['value']).toBe('[REDACTED]');
    expect(cookies[1]?.['value']).toBe('[REDACTED]');
    expect(cookies[0]?.['name']).toBe('session');
    // original untouched
    expect(msg.result.cookies[0]?.value).toBe('super-secret-token');
  });

  test('redacts Set-Cookie header values in extra-info style events', () => {
    const msg = {
      method: 'Network.responseReceivedExtraInfo',
      params: {
        headers: {
          'Set-Cookie': 'session=super-secret; Path=/',
          'Content-Type': 'text/html',
        },
      },
    };

    const redacted = redactCdpMessage(msg);
    const params = asRecord(redacted['params']);
    const headers = asRecord(params['headers']);
    expect(headers['Set-Cookie']).toBe('[REDACTED]');
    expect(headers['Content-Type']).toBe('text/html');
    // original untouched
    expect(msg.params.headers['Set-Cookie']).toBe('session=super-secret; Path=/');
  });

  test('redacts outgoing Storage.setCookies params', () => {
    const msg = {
      id: 3,
      method: 'Storage.setCookies',
      params: {
        cookies: [{ name: 'a', value: 'secret-value-1', domain: 'example.com' }],
      },
    };

    const redacted = redactCdpMessage(msg);
    const params = asRecord(redacted['params']);
    const cookies = params['cookies'] as Record<string, unknown>[];
    expect(cookies[0]?.['value']).toBe('[REDACTED]');
    expect(msg.params.cookies[0]?.value).toBe('secret-value-1');
  });

  test('redacts outgoing Network.setCookie (flat) params', () => {
    const msg = {
      id: 4,
      method: 'Network.setCookie',
      params: { name: 'a', value: 'secret-value-2', url: 'https://example.com' },
    };

    const redacted = redactCdpMessage(msg);
    const params = asRecord(redacted['params']);
    expect(params['value']).toBe('[REDACTED]');
    expect(params['name']).toBe('a');
    expect(msg.params.value).toBe('secret-value-2');
  });

  test('non-cookie traffic passes through unchanged', () => {
    const msg = {
      id: 10,
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
    };

    const redacted = redactCdpMessage(msg);
    expect(redacted).toEqual(msg);
  });

  test('does not mutate the original message object', () => {
    const msg = {
      id: 8,
      result: { cookies: [{ name: 'a', value: 'secret' }] },
    };
    const pending = new Map([[8, { method: 'Network.getCookies' }]]);
    const before = JSON.parse(JSON.stringify(msg));

    redactCdpMessage(msg, (id: number) => pending.get(id)?.method);

    expect(msg).toEqual(before);
  });
});
