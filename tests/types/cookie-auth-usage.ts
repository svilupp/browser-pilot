/**
 * Consumer type test: Cookie-state auth usage
 *
 * This file is compile-only — it verifies that downstream TS consumers can
 * import and use the cookie-state auth API (root, `/core`, and
 * `/adapters/node`) without type errors.
 */

import {
  loadCookieStateFile,
  resolveCookieStateRef,
  saveCookieStateFile,
} from '../../src/adapters/node/index.ts';
import {
  type CookieCaptureOptions as CookieCaptureOptionsCore,
  type CookieRestoreResult as CookieRestoreResultCore,
  type CookieState as CookieStateCore,
  type CookieStateErrorCode as CookieStateErrorCodeCore,
  CookieStateError as CookieStateErrorCore,
  captureCookieState as captureCookieStateCore,
  parseCookieState as parseCookieStateCore,
  restoreCookieState as restoreCookieStateCore,
  type SerializedCookie as SerializedCookieCore,
  serializeCookieState as serializeCookieStateCore,
} from '../../src/core/index.ts';
import {
  type CookieCaptureOptions,
  type CookieRestoreResult,
  type CookieState,
  CookieStateError,
  type CookieStateErrorCode,
  captureCookieState,
  parseCookieState,
  restoreCookieState,
  type SerializedCookie,
  serializeCookieState,
} from '../../src/index.ts';

// Root entry: functions are callable, types are assignable.
void captureCookieState;
void restoreCookieState;
void parseCookieState;
void serializeCookieState;

declare const _state: CookieState;
void _state;

declare const _cookie: SerializedCookie;
void _cookie;

const _captureOpts: CookieCaptureOptions = {};
void _captureOpts;

declare const _restoreResult: CookieRestoreResult;
void _restoreResult;

const _code: CookieStateErrorCode = 'not_found';
void _code;

const _err: CookieStateError = new CookieStateError('not_found', 'boom');
void _err;

// `/core`: same surface, imported file-specifically (not the auth barrel).
void captureCookieStateCore;
void restoreCookieStateCore;
void parseCookieStateCore;
void serializeCookieStateCore;

declare const _stateCore: CookieStateCore;
void _stateCore;

declare const _cookieCore: SerializedCookieCore;
void _cookieCore;

const _captureOptsCore: CookieCaptureOptionsCore = {};
void _captureOptsCore;

declare const _restoreResultCore: CookieRestoreResultCore;
void _restoreResultCore;

const _codeCore: CookieStateErrorCodeCore = 'not_found';
void _codeCore;

const _errCore: CookieStateErrorCore = new CookieStateErrorCore('not_found', 'boom');
void _errCore;

// `/adapters/node`: file-persistence helpers.
void loadCookieStateFile;
void resolveCookieStateRef;
void saveCookieStateFile;
