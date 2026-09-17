/**
 * Pure, browser-free cookie scope helpers.
 *
 * No public-suffix list is used (zero-dependency constraint) — see PLAN.md
 * §1.2 for the accepted `.co.uk`-style consequence.
 */

import { CookieStateError } from './errors.ts';
import type { CdpNetworkCookie } from './types.ts';

/** Lowercased hostname from a URL string. Throws on unparsable input. */
export function hostFromUrl(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

/** A CDP cookie is host-only when its `domain` has no leading dot. */
function isHostOnly(cookie: CdpNetworkCookie): boolean {
  return !cookie.domain.startsWith('.');
}

function undottedDomain(cookie: CdpNetworkCookie): string {
  return cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
}

/**
 * `H` = the host being served (e.g. the page's host), `d` = a cookie's domain
 * attribute (undotted). `hostOnly` cookies require an exact match; domain
 * cookies match `H === d` or `H` ending with `"." + d` (label boundary only).
 */
export function domainMatches(host: string, domain: string, hostOnly: boolean): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  if (hostOnly) {
    return h === d;
  }
  return h === d || h.endsWith(`.${d}`);
}

export interface FilterCookiesForScopeResult {
  cookies: CdpNetworkCookie[];
  skippedOpaquePartition: number;
  skippedOutOfScopePartition: number;
}

/**
 * Filter a full cookie jar (as returned by `Storage.getCookies`) down to
 * those applicable to the given source host (plus any additional
 * include-url hosts). All paths are included. Operates on the raw CDP shape
 * so `partitionKeyOpaque` can be inspected before it is dropped — it is
 * never carried into the serialized snapshot.
 */
export function filterCookiesForScope(
  cookies: CdpNetworkCookie[],
  sourceHost: string,
  includeUrls: string[] = []
): FilterCookiesForScopeResult {
  const scopeHosts = [sourceHost.toLowerCase()];
  for (const includeUrl of includeUrls) {
    try {
      scopeHosts.push(hostFromUrl(includeUrl));
    } catch {
      throw new CookieStateError(
        'invalid_format',
        `Cookie capture includeUrls entry is not a valid URL: ${includeUrl}`
      );
    }
  }

  let skippedOpaquePartition = 0;
  let skippedOutOfScopePartition = 0;
  const out: CdpNetworkCookie[] = [];

  for (const cookie of cookies) {
    const hostOnly = isHostOnly(cookie);
    const domain = undottedDomain(cookie);
    const matchesScope = scopeHosts.some((h) => domainMatches(h, domain, hostOnly));
    if (!matchesScope) continue;

    if (cookie.partitionKeyOpaque) {
      skippedOpaquePartition++;
      continue;
    }

    if (cookie.partitionKey) {
      const topHost = hostFromTopLevelSite(cookie.partitionKey.topLevelSite);
      if (topHost === null) {
        skippedOpaquePartition++;
        continue;
      }
      const partitionMatches = scopeHosts.some((h) => domainMatches(h, topHost, false));
      if (!partitionMatches) {
        skippedOutOfScopePartition++;
        continue;
      }
    }

    out.push(cookie);
  }

  return { cookies: out, skippedOpaquePartition, skippedOutOfScopePartition };
}

function hostFromTopLevelSite(topLevelSite: string): string | null {
  try {
    return hostFromUrl(topLevelSite);
  } catch {
    return null;
  }
}

/** Strip query string and fragment from a URL for storage in a snapshot. */
export function stripUrlForSnapshot(url: string): string {
  const parsed = new URL(url);
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}
