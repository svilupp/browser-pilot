/**
 * Portable types for cookie-snapshot auth.
 *
 * `CdpNetworkCookie` / `CdpCookieParam` mirror the shapes of CDP's
 * `Network.Cookie` / `Network.CookieParam` domains. `src/cdp/protocol.ts`
 * defines no cookie types at all, so this module is self-contained and does
 * not import from it.
 */

export type CookieSameSite = 'Strict' | 'Lax' | 'None';
export type CookiePriority = 'Low' | 'Medium' | 'High';
export type CookieSourceScheme = 'Unset' | 'NonSecure' | 'Secure';

export interface CookiePartitionKey {
  topLevelSite: string;
  hasCrossSiteAncestor: boolean;
}

/** Shape of a single entry returned by CDP `Storage.getCookies` / `Network.getCookies`. */
export interface CdpNetworkCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size?: number;
  httpOnly: boolean;
  secure: boolean;
  session?: boolean;
  sameSite?: CookieSameSite;
  priority?: CookiePriority;
  sameParty?: boolean;
  sourceScheme?: CookieSourceScheme;
  sourcePort?: number;
  partitionKey?: CookiePartitionKey;
  partitionKeyOpaque?: boolean;
}

/** Shape of a single entry accepted by CDP `Storage.setCookies` / `Network.setCookie(s)`. */
export interface CdpCookieParam {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: CookieSameSite;
  expires?: number;
  priority?: CookiePriority;
  sourceScheme?: CookieSourceScheme;
  sourcePort?: number;
  partitionKey?: CookiePartitionKey;
}

/** Dedicated round-trip cookie shape used by the snapshot file format. */
export interface SerializedCookie {
  name: string;
  value: string;
  /** Lowercased, no leading dot. */
  domain: string;
  /** Derived at capture from the CDP leading-dot convention. */
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: CookieSameSite | null;
  /** Epoch seconds, or `null` for a session cookie. */
  expires: number | null;
  priority: CookiePriority;
  sourceScheme: CookieSourceScheme;
  sourcePort: number;
  partitionKey?: CookiePartitionKey;
}

export interface CookieState {
  format: 'browser-pilot-cookie-auth';
  schemaVersion: 1;
  savedAt: string;
  sourceUrl: string;
  cookies: SerializedCookie[];
}

export interface CookieCaptureOptions {
  /** Additional URLs whose hosts are unioned into the capture scope (e.g. cross-origin SSO). */
  includeUrls?: string[];
}

export interface CookieRestoreResult {
  restored: number;
  skippedExpired: number;
  unverified: number;
  domains: string[];
}

export type { CookieStateErrorCode } from './errors.ts';
