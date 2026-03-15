/**
 * Branded types for cross-boundary identifiers.
 *
 * Prevents accidental mixing of string IDs that have different semantics.
 * Start with 3 brands; add more only when motivated by real bugs.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type SessionId = Brand<string, 'SessionId'>;
export type TargetId = Brand<string, 'TargetId'>;
export type BrowserWsUrl = Brand<string, 'BrowserWsUrl'>;

export function sessionId(raw: string): SessionId {
  return raw as SessionId;
}

export function targetId(raw: string): TargetId {
  return raw as TargetId;
}

export function browserWsUrl(raw: string): BrowserWsUrl {
  return raw as BrowserWsUrl;
}
