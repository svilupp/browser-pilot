/**
 * Cloudflare Access service-token -> CF_Authorization cookie exchange.
 *
 * This is the library-level primitive behind `bp connect --cf-access` and
 * `bp env auth set-cookie`'s sugar path. It performs the out-of-band fetch
 * exchange described in docs/proposals/cloudflare-access-auth.md (Method B)
 * and returns a ready-to-apply cookie descriptor; it never reads environment
 * variables itself — callers resolve `clientId`/`clientSecret` (e.g. via
 * `getEnv()`) and pass them in explicitly.
 */

import type { SetCookieOptions } from '../storage/types.ts';

export interface MintCfAccessJwtOptions {
  /** Target URL protected by Cloudflare Access. */
  url: string;
  /** Cloudflare Access service token client ID. */
  clientId: string;
  /** Cloudflare Access service token client secret. */
  clientSecret: string;
}

export interface CfAccessJwtResult {
  /** Cookie descriptor ready to pass to `Page.setCookie()`. */
  cookie: SetCookieOptions;
}

function extractSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === 'function') {
    return withGetSetCookie.getSetCookie();
  }
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

/**
 * Exchange a Cloudflare Access service token for a `CF_Authorization` JWT
 * cookie via an out-of-band fetch to the protected URL.
 *
 * Throws a clear error (referencing Cloudflare's `service_token_status`
 * diagnostic) when the token is rejected and no `CF_Authorization` cookie is
 * issued.
 */
export async function mintCfAccessJwt(options: MintCfAccessJwtOptions): Promise<CfAccessJwtResult> {
  const { url, clientId, clientSecret } = options;

  const response = await fetch(url, {
    redirect: 'manual',
    headers: {
      'CF-Access-Client-Id': clientId,
      'CF-Access-Client-Secret': clientSecret,
    },
  });

  const setCookieHeaders = extractSetCookieHeaders(response.headers);
  const cfCookiePair = setCookieHeaders
    .map((raw) => raw.split(';')[0]?.trim() ?? '')
    .find((pair) => pair.startsWith('CF_Authorization='));

  if (!cfCookiePair) {
    throw new Error(
      'Cloudflare Access rejected the service token: no CF_Authorization cookie was issued. ' +
        "Check the token's service_token_status in the redirect response's JWT payload " +
        '(Cloudflare Zero Trust -> Access -> Service Auth) to confirm the token is Active and ' +
        'included via an "Include: Service Auth" rule in the app\'s Access policy.'
    );
  }

  const eqIndex = cfCookiePair.indexOf('=');
  const value = eqIndex === -1 ? '' : cfCookiePair.slice(eqIndex + 1);
  const domain = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return undefined;
    }
  })();

  return {
    cookie: {
      name: 'CF_Authorization',
      value,
      domain,
      path: '/',
      secure: true,
    },
  };
}
