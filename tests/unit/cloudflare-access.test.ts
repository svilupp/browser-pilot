/**
 * Unit tests for the Cloudflare Access service-token -> JWT cookie helper
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mintCfAccessJwt } from '../../src/auth/cloudflare-access.ts';

describe('mintCfAccessJwt', () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl: string;
  let capturedInit: RequestInit;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(setCookieHeaders: string[], status = 302) {
    // @ts-expect-error minimal mock
    globalThis.fetch = async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init ?? {};
      const headers = new Headers();
      for (const cookie of setCookieHeaders) {
        headers.append('set-cookie', cookie);
      }
      return new Response(null, { status, headers });
    };
  }

  test('sends CF-Access-Client-Id/Secret headers to the target URL', async () => {
    mockFetch(['CF_Authorization=eyabc123; Path=/; Secure']);

    await mintCfAccessJwt({
      url: 'https://app.example.com/dashboard',
      clientId: 'test-client-id.access',
      clientSecret: 'test-client-secret',
    });

    expect(capturedUrl).toBe('https://app.example.com/dashboard');
    expect((capturedInit.headers as Record<string, string>)['CF-Access-Client-Id']).toBe(
      'test-client-id.access'
    );
    expect((capturedInit.headers as Record<string, string>)['CF-Access-Client-Secret']).toBe(
      'test-client-secret'
    );
    expect(capturedInit.redirect).toBe('manual');
  });

  test('extracts the CF_Authorization cookie value and domain', async () => {
    mockFetch([
      'other_cookie=irrelevant; Path=/',
      'CF_Authorization=eyJhbGciOiJ.payload.sig; Path=/',
    ]);

    const result = await mintCfAccessJwt({
      url: 'https://app.example.com/dashboard',
      clientId: 'test-client-id.access',
      clientSecret: 'test-client-secret',
    });

    expect(result.cookie.name).toBe('CF_Authorization');
    expect(result.cookie.value).toBe('eyJhbGciOiJ.payload.sig');
    expect(result.cookie.domain).toBe('app.example.com');
  });

  test('throws a clear error when no CF_Authorization cookie is issued (rejected token)', async () => {
    mockFetch([]);

    await expect(
      mintCfAccessJwt({
        url: 'https://app.example.com/dashboard',
        clientId: 'test-client-id.access',
        clientSecret: 'test-client-secret',
      })
    ).rejects.toThrow(/service_token_status/);
  });
});
