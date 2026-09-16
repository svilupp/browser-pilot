/**
 * Portable error type for cookie-snapshot auth (parse/capture/restore).
 *
 * Plain `Error` subclass — no Node dependency, safe for Workers/browser bundles.
 * Messages must never include cookie values.
 */

export type CookieStateErrorCode =
  | 'not_found'
  | 'invalid_format'
  | 'unsupported_version'
  | 'expired'
  | 'empty'
  | 'invalid_cookie'
  | 'unsupported_partition'
  | 'already_exists'
  | 'io_error'
  | 'nothing_restored';

export class CookieStateError extends Error {
  readonly code: CookieStateErrorCode;

  constructor(code: CookieStateErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'CookieStateError';
    this.code = code;
  }
}
