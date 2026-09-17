/**
 * Cookie snapshot parse/serialize + capture/restore.
 *
 * Pure/portable: no `node:*` imports, no `process.env`, no `console`. Capture
 * and restore accept a structural "page" (not the concrete `Page` class) so
 * this module has no dependency on `src/browser/page.ts`.
 */

import { filterCookiesForScope, hostFromUrl, stripUrlForSnapshot } from './cookie-scope.ts';
import { CookieStateError } from './errors.ts';
import type {
  CdpCookieParam,
  CdpNetworkCookie,
  CookieCaptureOptions,
  CookiePriority,
  CookieRestoreResult,
  CookieSameSite,
  CookieSourceScheme,
  CookieState,
  SerializedCookie,
} from './types.ts';

const MAX_SNAPSHOT_BYTES = 1024 * 1024; // 1 MiB

/** Structural page contract — satisfied by `Page` (`cdpClient`, `targetId`, `url()`). */
export interface CookieStatePage {
  cdpClient: {
    send<T = unknown>(
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string | null
    ): Promise<T>;
  };
  targetId: string;
  url(): Promise<string>;
}

const TOP_LEVEL_KEYS = new Set(['format', 'schemaVersion', 'savedAt', 'sourceUrl', 'cookies']);

const COOKIE_KEYS = new Set([
  'name',
  'value',
  'domain',
  'hostOnly',
  'path',
  'secure',
  'httpOnly',
  'sameSite',
  'expires',
  'priority',
  'sourceScheme',
  'sourcePort',
  'partitionKey',
]);

const SAME_SITE_VALUES: ReadonlySet<CookieSameSite> = new Set(['Strict', 'Lax', 'None']);
const PRIORITY_VALUES: ReadonlySet<CookiePriority> = new Set(['Low', 'Medium', 'High']);
const SOURCE_SCHEME_VALUES: ReadonlySet<CookieSourceScheme> = new Set([
  'Unset',
  'NonSecure',
  'Secure',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cookieIdentity(cookie: SerializedCookie): string {
  const partition = cookie.partitionKey
    ? `${cookie.partitionKey.topLevelSite}|${cookie.partitionKey.hasCrossSiteAncestor}`
    : '';
  return `${cookie.name}\u0000${cookie.domain}\u0000${cookie.hostOnly}\u0000${cookie.path}\u0000${partition}`;
}

function parseCookie(raw: unknown): SerializedCookie {
  if (!isPlainObject(raw)) {
    throw new CookieStateError('invalid_cookie', 'Cookie entry must be an object');
  }
  for (const key of Object.keys(raw)) {
    if (!COOKIE_KEYS.has(key)) {
      throw new CookieStateError('invalid_cookie', `Unknown cookie field: ${key}`);
    }
  }

  const name = raw['name'];
  if (typeof name !== 'string' || name.length === 0) {
    throw new CookieStateError('invalid_cookie', 'Cookie name must be a non-empty string');
  }
  const value = raw['value'];
  if (typeof value !== 'string') {
    throw new CookieStateError('invalid_cookie', 'Cookie value must be a string');
  }
  const domain = raw['domain'];
  if (typeof domain !== 'string' || domain.length === 0) {
    throw new CookieStateError('invalid_cookie', 'Cookie domain must be a non-empty string');
  }
  const hostOnly = raw['hostOnly'];
  if (typeof hostOnly !== 'boolean') {
    throw new CookieStateError('invalid_cookie', 'Cookie hostOnly must be a boolean');
  }
  const path = raw['path'];
  if (typeof path !== 'string' || path.length === 0) {
    throw new CookieStateError('invalid_cookie', 'Cookie path must be a non-empty string');
  }
  const secure = raw['secure'];
  if (typeof secure !== 'boolean') {
    throw new CookieStateError('invalid_cookie', 'Cookie secure must be a boolean');
  }
  const httpOnly = raw['httpOnly'];
  if (typeof httpOnly !== 'boolean') {
    throw new CookieStateError('invalid_cookie', 'Cookie httpOnly must be a boolean');
  }
  const sameSiteRaw = raw['sameSite'];
  if (sameSiteRaw !== null && !SAME_SITE_VALUES.has(sameSiteRaw as CookieSameSite)) {
    throw new CookieStateError('invalid_cookie', 'Cookie sameSite must be Strict/Lax/None/null');
  }
  const sameSite = sameSiteRaw as CookieSameSite | null;
  const expiresRaw = raw['expires'];
  if (
    expiresRaw !== null &&
    !(typeof expiresRaw === 'number' && Number.isFinite(expiresRaw) && expiresRaw > 0)
  ) {
    throw new CookieStateError(
      'invalid_cookie',
      'Cookie expires must be null or a positive finite number'
    );
  }
  const expires = expiresRaw;
  let priority: CookiePriority;
  if (raw['priority'] === undefined) {
    priority = 'Medium';
  } else if (!PRIORITY_VALUES.has(raw['priority'] as CookiePriority)) {
    throw new CookieStateError('invalid_cookie', 'Cookie priority must be Low/Medium/High');
  } else {
    priority = raw['priority'] as CookiePriority;
  }

  let sourceScheme: CookieSourceScheme;
  if (raw['sourceScheme'] === undefined) {
    sourceScheme = 'Unset';
  } else if (!SOURCE_SCHEME_VALUES.has(raw['sourceScheme'] as CookieSourceScheme)) {
    throw new CookieStateError(
      'invalid_cookie',
      'Cookie sourceScheme must be Unset/NonSecure/Secure'
    );
  } else {
    sourceScheme = raw['sourceScheme'] as CookieSourceScheme;
  }

  let sourcePort: number;
  if (raw['sourcePort'] === undefined) {
    sourcePort = sourceScheme === 'NonSecure' ? 80 : 443;
  } else if (typeof raw['sourcePort'] !== 'number' || !Number.isFinite(raw['sourcePort'])) {
    throw new CookieStateError('invalid_cookie', 'Cookie sourcePort must be a number');
  } else {
    sourcePort = raw['sourcePort'];
  }

  let partitionKey: SerializedCookie['partitionKey'];
  const partitionRaw = raw['partitionKey'];
  if (partitionRaw !== undefined) {
    if (
      !isPlainObject(partitionRaw) ||
      typeof partitionRaw['topLevelSite'] !== 'string' ||
      typeof partitionRaw['hasCrossSiteAncestor'] !== 'boolean'
    ) {
      throw new CookieStateError('invalid_cookie', 'Cookie partitionKey is malformed');
    }
    partitionKey = {
      topLevelSite: partitionRaw['topLevelSite'],
      hasCrossSiteAncestor: partitionRaw['hasCrossSiteAncestor'],
    };
  }

  const cookie: SerializedCookie = {
    name,
    value,
    domain: domain.toLowerCase(),
    hostOnly,
    path,
    secure,
    httpOnly,
    sameSite,
    expires,
    priority,
    sourceScheme,
    sourcePort,
    ...(partitionKey ? { partitionKey } : {}),
  };
  return cookie;
}

/**
 * Parse and validate a serialized cookie state (JSON text or already-parsed
 * value). Throws `CookieStateError` for every documented error code.
 */
export function parseCookieState(input: unknown): CookieState {
  let raw: unknown;
  if (typeof input === 'string') {
    if (new TextEncoder().encode(input).byteLength > MAX_SNAPSHOT_BYTES) {
      throw new CookieStateError('invalid_format', 'Cookie state input exceeds 1 MiB');
    }
    try {
      raw = JSON.parse(input);
    } catch {
      throw new CookieStateError('invalid_format', 'Cookie state input is not valid JSON');
    }
  } else {
    raw = input;
  }

  if (!isPlainObject(raw)) {
    throw new CookieStateError('invalid_format', 'Cookie state must be a JSON object');
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new CookieStateError('invalid_format', `Unknown top-level field: ${key}`);
    }
  }

  if (raw['format'] !== 'browser-pilot-cookie-auth') {
    throw new CookieStateError('invalid_format', 'Unrecognized cookie state format');
  }
  if (raw['schemaVersion'] !== 1) {
    throw new CookieStateError(
      'unsupported_version',
      `Unsupported schemaVersion: ${String(raw['schemaVersion'])}`
    );
  }
  if (typeof raw['savedAt'] !== 'string') {
    throw new CookieStateError('invalid_format', 'savedAt must be a string');
  }
  if (typeof raw['sourceUrl'] !== 'string') {
    throw new CookieStateError('invalid_format', 'sourceUrl must be a string');
  }
  if (!Array.isArray(raw['cookies'])) {
    throw new CookieStateError('invalid_format', 'cookies must be an array');
  }

  const cookies = (raw['cookies'] as unknown[]).map(parseCookie);

  const seen = new Set<string>();
  for (const cookie of cookies) {
    const identity = cookieIdentity(cookie);
    if (seen.has(identity)) {
      throw new CookieStateError('invalid_cookie', 'Duplicate cookie identity in snapshot');
    }
    seen.add(identity);
  }

  if (cookies.length === 0) {
    throw new CookieStateError('empty', 'Cookie state contains no cookies');
  }

  return {
    format: 'browser-pilot-cookie-auth',
    schemaVersion: 1,
    savedAt: raw['savedAt'],
    sourceUrl: raw['sourceUrl'],
    cookies,
  };
}

/** Serialize a cookie state to its canonical JSON string (whitelist fields only). */
export function serializeCookieState(state: {
  savedAt: string;
  sourceUrl: string;
  cookies: SerializedCookie[];
}): string {
  const cookies = state.cookies.map((cookie) => {
    const out: SerializedCookie = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain.toLowerCase(),
      hostOnly: cookie.hostOnly,
      path: cookie.path,
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite,
      expires: cookie.expires !== null && cookie.expires > 0 ? cookie.expires : null,
      priority: cookie.priority,
      sourceScheme: cookie.sourceScheme,
      sourcePort: cookie.sourcePort,
      ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
    };
    return out;
  });

  const body: CookieState = {
    format: 'browser-pilot-cookie-auth',
    schemaVersion: 1,
    savedAt: state.savedAt,
    sourceUrl: stripUrlForSnapshot(state.sourceUrl),
    cookies,
  };
  return JSON.stringify(body, null, 2);
}

function toSerializedCookie(cookie: CdpNetworkCookie): SerializedCookie {
  const hostOnly = !cookie.domain.startsWith('.');
  const domain = (
    cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain
  ).toLowerCase();
  const expires = cookie.expires > 0 ? cookie.expires : null;
  const sourceScheme = cookie.sourceScheme ?? 'Unset';
  return {
    name: cookie.name,
    value: cookie.value,
    domain,
    hostOnly,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite ?? null,
    expires,
    priority: cookie.priority ?? 'Medium',
    sourceScheme,
    sourcePort: cookie.sourcePort ?? (sourceScheme === 'NonSecure' ? 80 : 443),
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
  };
}

/**
 * Resolve the browser context id for a page's target, per PLAN.md §1.3:
 * browser-level `Target.getTargets`, hard error if the target isn't found
 * (never substitute the default context); then `Target.getBrowserContexts`
 * to detect whether it's the default context (omit the param) or an
 * explicit non-default context (pass its id).
 */
export async function resolveBrowserContextId(page: CookieStatePage): Promise<string | undefined> {
  const { targetInfos } = await page.cdpClient.send<{
    targetInfos: Array<{ targetId: string; browserContextId?: string }>;
  }>('Target.getTargets', undefined, null);

  const info = targetInfos.find((t) => t.targetId === page.targetId);
  if (!info) {
    throw new CookieStateError(
      'invalid_cookie',
      'Target for this page was not found via Target.getTargets'
    );
  }

  if (!info.browserContextId) {
    return undefined;
  }

  const { browserContextIds } = await page.cdpClient.send<{ browserContextIds: string[] }>(
    'Target.getBrowserContexts',
    undefined,
    null
  );

  if (!browserContextIds.includes(info.browserContextId)) {
    return undefined;
  }

  return info.browserContextId;
}

function assertCapturableUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CookieStateError('invalid_format', 'Page URL is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CookieStateError('invalid_format', 'Page URL must be http or https');
  }
  if (parsed.username || parsed.password) {
    throw new CookieStateError('invalid_format', 'Page URL must not embed credentials');
  }
  return parsed;
}

/** Capture domain-matched cookies for a page's current URL into a portable snapshot. */
export async function captureCookieState(
  page: CookieStatePage,
  opts: CookieCaptureOptions = {}
): Promise<CookieState> {
  const sourceUrl = await page.url();
  assertCapturableUrl(sourceUrl);
  const sourceHost = hostFromUrl(sourceUrl);

  const browserContextId = await resolveBrowserContextId(page);
  const params = browserContextId ? { browserContextId } : {};

  const { cookies: allCookies } = await page.cdpClient.send<{ cookies: CdpNetworkCookie[] }>(
    'Storage.getCookies',
    params,
    null
  );

  const { cookies: scopedCdpCookies } = filterCookiesForScope(
    allCookies,
    sourceHost,
    opts.includeUrls ?? []
  );

  const cookies = scopedCdpCookies.map(toSerializedCookie);

  const afterUrl = await page.url();
  let afterOrigin: string;
  try {
    afterOrigin = new URL(afterUrl).origin;
  } catch {
    throw new CookieStateError('invalid_format', 'page navigated during capture');
  }
  if (afterOrigin !== new URL(sourceUrl).origin) {
    throw new CookieStateError('invalid_format', 'page navigated during capture');
  }

  if (cookies.length === 0) {
    throw new CookieStateError('empty', 'No cookies matched the capture scope');
  }

  return {
    format: 'browser-pilot-cookie-auth',
    schemaVersion: 1,
    savedAt: new Date().toISOString(),
    sourceUrl: stripUrlForSnapshot(sourceUrl),
    cookies,
  };
}

function toCookieParam(cookie: SerializedCookie, nowSeconds: number): CdpCookieParam | null {
  if (cookie.expires !== null && cookie.expires <= nowSeconds) {
    return null;
  }

  const param: CdpCookieParam = {
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    priority: cookie.priority,
    sourceScheme: cookie.sourceScheme,
    sourcePort: cookie.sourcePort,
  };
  if (cookie.sameSite !== null) {
    param.sameSite = cookie.sameSite;
  }
  if (cookie.expires !== null) {
    param.expires = cookie.expires;
  }
  if (cookie.partitionKey) {
    param.partitionKey = cookie.partitionKey;
  }

  if (cookie.hostOnly) {
    const scheme =
      cookie.sourceScheme === 'Secure'
        ? 'https'
        : cookie.sourceScheme === 'NonSecure'
          ? 'http'
          : cookie.secure
            ? 'https'
            : 'http';
    param.url = `${scheme}://${cookie.domain}${cookie.path}`;
  } else {
    param.domain = `.${cookie.domain}`;
  }

  return param;
}

function verificationIdentity(entry: {
  name: string;
  domain: string;
  path: string;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
}): string {
  const hostOnly = !entry.domain.startsWith('.');
  const domain = (
    entry.domain.startsWith('.') ? entry.domain.slice(1) : entry.domain
  ).toLowerCase();
  const partition = entry.partitionKey
    ? `${entry.partitionKey.topLevelSite}|${entry.partitionKey.hasCrossSiteAncestor}`
    : '';
  return `${entry.name}\u0000${domain}\u0000${hostOnly}\u0000${entry.path}\u0000${partition}`;
}

/** Restore a portable cookie snapshot into a page's browser context. */
export async function restoreCookieState(
  page: CookieStatePage,
  state: CookieState
): Promise<CookieRestoreResult> {
  const nowSeconds = Date.now() / 1000;

  if (state.cookies.length === 0) {
    throw new CookieStateError('empty', 'Cookie state contains no cookies to restore');
  }

  let skippedExpired = 0;
  const eligible: CdpCookieParam[] = [];
  const eligibleSource: SerializedCookie[] = [];
  for (const cookie of state.cookies) {
    const param = toCookieParam(cookie, nowSeconds);
    if (param === null) {
      skippedExpired++;
      continue;
    }
    eligible.push(param);
    eligibleSource.push(cookie);
  }

  if (eligible.length === 0) {
    throw new CookieStateError('expired', 'All cookies in the snapshot have expired');
  }

  const browserContextId = await resolveBrowserContextId(page);
  const contextParam = browserContextId ? { browserContextId } : {};

  await page.cdpClient.send('Storage.setCookies', { cookies: eligible, ...contextParam }, null);

  const { cookies: verifyCookies } = await page.cdpClient.send<{ cookies: CdpNetworkCookie[] }>(
    'Storage.getCookies',
    contextParam,
    null
  );
  const verifySet = new Set(
    verifyCookies.map((c) =>
      verificationIdentity({
        name: c.name,
        domain: c.domain,
        path: c.path,
        partitionKey: c.partitionKey,
      })
    )
  );

  let unverified = 0;
  const domains = new Set<string>();
  for (const cookie of eligibleSource) {
    domains.add(cookie.domain);
    const identity = verificationIdentity({
      name: cookie.name,
      domain: cookie.hostOnly ? cookie.domain : `.${cookie.domain}`,
      path: cookie.path,
      partitionKey: cookie.partitionKey,
    });
    if (!verifySet.has(identity)) {
      unverified++;
    }
  }

  const restored = eligible.length;
  if (restored - unverified === 0) {
    throw new CookieStateError('nothing_restored', 'No cookies could be verified after restore');
  }

  return {
    restored,
    skippedExpired,
    unverified,
    domains: [...domains],
  };
}
