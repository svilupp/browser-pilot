/**
 * Unit tests for parseCookieState / serializeCookieState.
 */

import { describe, expect, test } from 'bun:test';
import { parseCookieState, serializeCookieState } from '../../src/auth/cookie-state.ts';
import { CookieStateError, type CookieStateErrorCode } from '../../src/auth/errors.ts';
import type { SerializedCookie } from '../../src/auth/types.ts';

function baseCookie(overrides: Partial<SerializedCookie> = {}): SerializedCookie {
  return {
    name: 'session',
    value: 'abc123',
    domain: 'example.com',
    hostOnly: true,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    expires: 4102444800, // far future
    priority: 'Medium',
    sourceScheme: 'Secure',
    sourcePort: 443,
    ...overrides,
  };
}

function baseState(cookies: SerializedCookie[] = [baseCookie()]) {
  return {
    format: 'browser-pilot-cookie-auth',
    schemaVersion: 1,
    savedAt: '2026-01-01T00:00:00.000Z',
    sourceUrl: 'https://example.com/dashboard',
    cookies,
  };
}

function expectCode(fn: () => unknown, code: CookieStateErrorCode) {
  try {
    fn();
    throw new Error('expected to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(CookieStateError);
    expect((err as CookieStateError).code).toBe(code);
  }
}

describe('parseCookieState', () => {
  test('round-trips a valid state', () => {
    const state = baseState();
    const parsed = parseCookieState(JSON.stringify(state));
    expect(parsed.cookies).toHaveLength(1);
    expect(parsed.cookies[0]?.name).toBe('session');
    expect(parsed.sourceUrl).toBe('https://example.com/dashboard');
  });

  test('accepts a pre-parsed object', () => {
    const parsed = parseCookieState(baseState());
    expect(parsed.cookies).toHaveLength(1);
  });

  test('explicit null priority is invalid_cookie, not defaulted', () => {
    expectCode(
      () => parseCookieState(baseState([baseCookie({ priority: null as never })])),
      'invalid_cookie'
    );
  });

  test('explicit null sourceScheme is invalid_cookie, not defaulted', () => {
    expectCode(
      () => parseCookieState(baseState([baseCookie({ sourceScheme: null as never })])),
      'invalid_cookie'
    );
  });

  test('explicit null sourcePort is invalid_cookie, not defaulted', () => {
    expectCode(
      () => parseCookieState(baseState([baseCookie({ sourcePort: null as never })])),
      'invalid_cookie'
    );
  });

  test('absent priority/sourceScheme/sourcePort fields still default', () => {
    const full = baseCookie() as unknown as Record<string, unknown>;
    const {
      priority: _priority,
      sourceScheme: _sourceScheme,
      sourcePort: _sourcePort,
      ...cookie
    } = full;
    const parsed = parseCookieState(baseState([cookie as unknown as SerializedCookie]));
    expect(parsed.cookies[0]?.priority).toBe('Medium');
    expect(parsed.cookies[0]?.sourceScheme).toBe('Unset');
    expect(parsed.cookies[0]?.sourcePort).toBe(443);
  });

  test('rejects input over 1 MiB (invalid_format)', () => {
    const huge = 'x'.repeat(1024 * 1024 + 1);
    expectCode(() => parseCookieState(huge), 'invalid_format');
  });

  test('measures the 1 MiB cap in bytes, not UTF-16 code units', () => {
    // Multi-byte characters: string.length underestimates the true byte size.
    // 400,000 3-byte chars = 1.2MB in bytes but only 400,000 in .length.
    const multiByte = '\u2603'.repeat(400_000); // snowman, 3 bytes each in UTF-8
    expect(new TextEncoder().encode(multiByte).byteLength).toBeGreaterThan(1024 * 1024);
    expect(multiByte.length).toBeLessThan(1024 * 1024);
    expectCode(() => parseCookieState(multiByte), 'invalid_format');
  });

  test('rejects invalid JSON (invalid_format)', () => {
    expectCode(() => parseCookieState('{not json'), 'invalid_format');
  });

  test('rejects non-object top-level (invalid_format)', () => {
    expectCode(() => parseCookieState('[]'), 'invalid_format');
  });

  test('rejects unknown top-level keys (invalid_format)', () => {
    const state = { ...baseState(), extra: 'nope' };
    expectCode(() => parseCookieState(state), 'invalid_format');
  });

  test('rejects wrong format string (invalid_format)', () => {
    const state = { ...baseState(), format: 'something-else' };
    expectCode(() => parseCookieState(state), 'invalid_format');
  });

  test('rejects unsupported schemaVersion (unsupported_version)', () => {
    const state = { ...baseState(), schemaVersion: 2 };
    expectCode(() => parseCookieState(state), 'unsupported_version');
  });

  test('rejects unknown cookie fields (invalid_cookie)', () => {
    const state = baseState([{ ...baseCookie(), extraField: true } as unknown as SerializedCookie]);
    expectCode(() => parseCookieState(state), 'invalid_cookie');
  });

  test('rejects empty cookie name (invalid_cookie)', () => {
    const state = baseState([baseCookie({ name: '' })]);
    expectCode(() => parseCookieState(state), 'invalid_cookie');
  });

  test('rejects negative expires (invalid_cookie)', () => {
    const state = baseState([{ ...baseCookie(), expires: -1 }]);
    expectCode(() => parseCookieState(state), 'invalid_cookie');
  });

  test('rejects NaN expires (invalid_cookie)', () => {
    const state = baseState([{ ...baseCookie(), expires: Number.NaN }]);
    expectCode(() => parseCookieState(state), 'invalid_cookie');
  });

  test('accepts null expires (session cookie)', () => {
    const parsed = parseCookieState(baseState([baseCookie({ expires: null })]));
    expect(parsed.cookies[0]?.expires).toBeNull();
  });

  test('rejects invalid sameSite (invalid_cookie)', () => {
    const state = baseState([{ ...baseCookie(), sameSite: 'Bogus' as unknown as 'Lax' }]);
    expectCode(() => parseCookieState(state), 'invalid_cookie');
  });

  test('accepts null sameSite', () => {
    const parsed = parseCookieState(baseState([baseCookie({ sameSite: null })]));
    expect(parsed.cookies[0]?.sameSite).toBeNull();
  });

  test('rejects duplicate cookie identity (invalid_cookie)', () => {
    const dup = baseCookie();
    const state = baseState([dup, { ...dup }]);
    expectCode(() => parseCookieState(state), 'invalid_cookie');
  });

  test('allows same name/domain/path with different partitionKey', () => {
    const a = baseCookie({
      partitionKey: { topLevelSite: 'https://a.com', hasCrossSiteAncestor: false },
    });
    const b = baseCookie({
      partitionKey: { topLevelSite: 'https://b.com', hasCrossSiteAncestor: false },
    });
    const parsed = parseCookieState(baseState([a, b]));
    expect(parsed.cookies).toHaveLength(2);
  });

  test('rejects zero cookies (empty)', () => {
    expectCode(() => parseCookieState(baseState([])), 'empty');
  });

  test('lowercases domain', () => {
    const parsed = parseCookieState(baseState([baseCookie({ domain: 'Example.COM' })]));
    expect(parsed.cookies[0]?.domain).toBe('example.com');
  });
});

describe('serializeCookieState', () => {
  test('round-trips through parseCookieState', () => {
    const json = serializeCookieState({
      savedAt: '2026-01-01T00:00:00.000Z',
      sourceUrl: 'https://example.com/dashboard?x=1#f',
      cookies: [baseCookie()],
    });
    const parsed = parseCookieState(json);
    expect(parsed.sourceUrl).toBe('https://example.com/dashboard');
    expect(parsed.cookies[0]?.name).toBe('session');
  });

  test('maps expires <= 0 to null', () => {
    const json = serializeCookieState({
      savedAt: '2026-01-01T00:00:00.000Z',
      sourceUrl: 'https://example.com/dashboard',
      cookies: [baseCookie({ expires: -1 })],
    });
    const parsed = JSON.parse(json);
    expect(parsed.cookies[0].expires).toBeNull();
  });

  test('never includes CDP-only fields like size/session/sameParty', () => {
    const json = serializeCookieState({
      savedAt: '2026-01-01T00:00:00.000Z',
      sourceUrl: 'https://example.com/dashboard',
      cookies: [baseCookie()],
    });
    expect(json).not.toContain('"size":');
    expect(json).not.toContain('"session":');
    expect(json).not.toContain('"sameParty"');
  });
});
