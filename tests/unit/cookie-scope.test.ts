/**
 * Unit tests for cookie scope helpers (pure, no browser).
 */

import { describe, expect, test } from 'bun:test';
import {
  domainMatches,
  filterCookiesForScope,
  hostFromUrl,
  stripUrlForSnapshot,
} from '../../src/auth/cookie-scope.ts';
import { CookieStateError } from '../../src/auth/errors.ts';
import type { CdpNetworkCookie } from '../../src/auth/types.ts';

function cookie(overrides: Partial<CdpNetworkCookie> = {}): CdpNetworkCookie {
  return {
    name: 'session',
    value: 'abc',
    domain: 'example.com',
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: false,
    ...overrides,
  };
}

describe('hostFromUrl', () => {
  test('lowercases host', () => {
    expect(hostFromUrl('https://Example.COM/path')).toBe('example.com');
  });
});

describe('domainMatches', () => {
  test('host-only requires exact match', () => {
    expect(domainMatches('example.com', 'example.com', true)).toBe(true);
    expect(domainMatches('app.example.com', 'example.com', true)).toBe(false);
  });

  test('domain cookie matches exact host', () => {
    expect(domainMatches('example.com', 'example.com', false)).toBe(true);
  });

  test('domain cookie matches subdomain at label boundary', () => {
    expect(domainMatches('app.example.com', 'example.com', false)).toBe(true);
  });

  test('domain cookie does not substring-match a sibling domain', () => {
    // notexample.com must NOT match example.com (no leading dot boundary)
    expect(domainMatches('notexample.com', 'example.com', false)).toBe(false);
  });

  test('domain cookie does not match a host that merely contains the domain as suffix without label boundary', () => {
    expect(
      domainMatches('pple.example.com'.replace('example.com', 'xexample.com'), 'example.com', false)
    ).toBe(false);
  });
});

describe('filterCookiesForScope', () => {
  test('includes host-only exact match', () => {
    const result = filterCookiesForScope([cookie({ domain: 'example.com' })], 'example.com');
    expect(result.cookies).toHaveLength(1);
  });

  test('includes parent-domain cookie for subdomain host', () => {
    const result = filterCookiesForScope([cookie({ domain: '.example.com' })], 'app.example.com');
    expect(result.cookies).toHaveLength(1);
  });

  test('excludes sibling/other-site cookies', () => {
    const result = filterCookiesForScope([cookie({ domain: 'other.com' })], 'example.com');
    expect(result.cookies).toHaveLength(0);
  });

  test('includes cookies of all paths', () => {
    const result = filterCookiesForScope(
      [
        cookie({ domain: 'example.com', path: '/' }),
        cookie({ domain: 'example.com', path: '/api', name: 'api-token' }),
      ],
      'example.com'
    );
    expect(result.cookies).toHaveLength(2);
  });

  test('unions include-url hosts into scope', () => {
    const result = filterCookiesForScope(
      [cookie({ domain: 'accounts.example.com' })],
      'app.example.com',
      ['https://accounts.example.com/sso']
    );
    expect(result.cookies).toHaveLength(1);
  });

  test('keeps partitioned cookie whose topLevelSite domain-matches scope', () => {
    const result = filterCookiesForScope(
      [
        cookie({
          domain: 'example.com',
          partitionKey: { topLevelSite: 'https://example.com', hasCrossSiteAncestor: true },
        }),
      ],
      'example.com'
    );
    expect(result.cookies).toHaveLength(1);
    expect(result.skippedOutOfScopePartition).toBe(0);
  });

  test('skips partitioned cookie whose topLevelSite is out of scope', () => {
    const result = filterCookiesForScope(
      [
        cookie({
          domain: 'example.com',
          partitionKey: { topLevelSite: 'https://unrelated.com', hasCrossSiteAncestor: true },
        }),
      ],
      'example.com'
    );
    expect(result.cookies).toHaveLength(0);
    expect(result.skippedOutOfScopePartition).toBe(1);
  });

  test('skips opaque partitioned cookies', () => {
    const result = filterCookiesForScope(
      [cookie({ domain: 'example.com', partitionKeyOpaque: true })],
      'example.com'
    );
    expect(result.cookies).toHaveLength(0);
    expect(result.skippedOpaquePartition).toBe(1);
  });

  test('throws CookieStateError(invalid_format) for an unparsable includeUrls entry, not a raw TypeError', () => {
    expect(() =>
      filterCookiesForScope([cookie({ domain: 'example.com' })], 'example.com', ['not a url'])
    ).toThrow(CookieStateError);
    try {
      filterCookiesForScope([cookie({ domain: 'example.com' })], 'example.com', ['not a url']);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CookieStateError);
      expect((err as CookieStateError).code).toBe('invalid_format');
    }
  });

  test('no public-suffix list: a .co.uk domain cookie would be treated as a normal parent domain', () => {
    // Documented accepted behavior: without a PSL, foo.co.uk capturing a
    // hypothetical `.co.uk` cookie is included (real jars won't contain this).
    const result = filterCookiesForScope([cookie({ domain: '.co.uk' })], 'foo.co.uk');
    expect(result.cookies).toHaveLength(1);
  });
});

describe('stripUrlForSnapshot', () => {
  test('drops query and fragment', () => {
    expect(stripUrlForSnapshot('https://app.example.com/dashboard?x=1#frag')).toBe(
      'https://app.example.com/dashboard'
    );
  });
});
