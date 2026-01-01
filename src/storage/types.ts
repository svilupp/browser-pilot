/**
 * Cookie and storage types
 */

export interface Cookie {
  /** Cookie name */
  name: string;
  /** Cookie value */
  value: string;
  /** Cookie domain */
  domain: string;
  /** Cookie path */
  path: string;
  /** Expiration timestamp (Unix epoch in seconds) */
  expires: number;
  /** Size in bytes */
  size: number;
  /** HTTP only flag */
  httpOnly: boolean;
  /** Secure flag */
  secure: boolean;
  /** Session cookie flag */
  session: boolean;
  /** SameSite attribute */
  sameSite: 'Strict' | 'Lax' | 'None';
  /** Priority */
  priority: 'Low' | 'Medium' | 'High';
  /** Source scheme */
  sourceScheme: 'Unset' | 'NonSecure' | 'Secure';
}

export interface SetCookieOptions {
  /** Cookie name */
  name: string;
  /** Cookie value */
  value: string;
  /** Cookie domain (optional, defaults to current page domain) */
  domain?: string;
  /** Cookie path (default: "/") */
  path?: string;
  /** Expiration timestamp or Date */
  expires?: number | Date;
  /** HTTP only flag */
  httpOnly?: boolean;
  /** Secure flag */
  secure?: boolean;
  /** SameSite attribute */
  sameSite?: 'Strict' | 'Lax' | 'None';
  /** URL to associate cookie with (alternative to domain+path) */
  url?: string;
}

export interface DeleteCookieOptions {
  /** Cookie name */
  name: string;
  /** Cookie domain */
  domain?: string;
  /** Cookie path */
  path?: string;
  /** URL to scope cookie deletion */
  url?: string;
}

export interface ClearCookiesOptions {
  /** Clear only for specific domain */
  domain?: string;
}
