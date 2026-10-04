import { withinBudget } from '../core/budget.ts';
import { CapabilityError, type SecretsPort } from '../core/ports.ts';
import { normalizeProviderSelector } from './selector.ts';
import type {
  CloudflareChromiumOptions,
  CloudflareEngine,
  ConnectOptions,
  Provider,
  ProviderReleaseResult,
  ProviderSession,
} from './types.ts';

export interface CloudflareProviderOptions extends CloudflareChromiumOptions {
  accountId: string;
  apiKey: string;
  engine?: CloudflareEngine;
  explicitEngine?: boolean;
  timeout?: number;
  idGenerator?: () => string;
  /** Trusted host HTTP implementation, primarily for scripted contract tests. */
  fetch?: typeof fetch;
}

export function validateCloudflareOptions(
  options: CloudflareChromiumOptions,
  engine?: CloudflareEngine
): void {
  if (
    options.accountId !== undefined &&
    (typeof options.accountId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(options.accountId))
  )
    throw new CapabilityError('provider-config', 'Invalid Cloudflare account ID');
  for (const flag of ['lab', 'recording', 'takeOwnership'] as const)
    if (options[flag] !== undefined && typeof options[flag] !== 'boolean')
      throw new CapabilityError('provider-config', `${flag} must be boolean`);
  if ('engine' in options || 'browser' in options)
    throw new CapabilityError(
      'provider-config',
      'Use the provider selector to choose a Cloudflare engine'
    );
  if (
    engine === 'kitesurf' &&
    ['keepAliveMs', 'lab', 'recording', 'providerSessionId', 'takeOwnership'].some(
      (key) => options[key as keyof CloudflareChromiumOptions] !== undefined
    )
  )
    throw new CapabilityError(
      'provider-config',
      'Kitesurf does not support keepAliveMs, lab, recording, or existing-allocation attach'
    );
  if (
    options.keepAliveMs !== undefined &&
    (!Number.isInteger(options.keepAliveMs) ||
      options.keepAliveMs < 10000 ||
      options.keepAliveMs > 1200000)
  )
    throw new CapabilityError(
      'provider-config',
      'keepAliveMs must be an integer from 10000 to 1200000'
    );
}

export function resolveCloudflareOptions(
  options: ConnectOptions,
  secrets?: SecretsPort
): CloudflareProviderOptions {
  const selection = normalizeProviderSelector(options.provider);
  validateCloudflareOptions(options.cloudflare ?? {}, selection.engine);
  if (options.wsUrl || options.wsHeaders)
    throw new CapabilityError(
      'provider-config',
      'Cloudflare provider conflicts with direct URL/header modes'
    );
  const canonicalAccount = secrets?.get('CLOUDFLARE_ACCOUNT_ID');
  const canonicalToken = secrets?.get('CLOUDFLARE_API_TOKEN');
  const useCanonical = canonicalAccount !== undefined || canonicalToken !== undefined;
  const accountId =
    options.cloudflare?.accountId ??
    (useCanonical ? canonicalAccount : secrets?.get('CF_ACCOUNT_ID'));
  const apiKey = options.apiKey ?? (useCanonical ? canonicalToken : secrets?.get('CF_API_KEY'));
  if (!accountId || !apiKey)
    throw new CapabilityError(
      'secrets',
      'Cloudflare requires accountId and apiKey, or CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN (aliases CF_ACCOUNT_ID / CF_API_KEY).'
    );
  return {
    ...options.cloudflare,
    accountId,
    apiKey,
    engine: selection.engine,
    explicitEngine: selection.explicitEngine,
    timeout: options.timeout,
  };
}

/** Cloudflare HTTP allocation for Chromium and connection-bound Kitesurf launch. */
export class CloudflareProvider implements Provider {
  readonly name = 'cloudflare';
  private readonly base: string;
  private readonly http: typeof fetch;
  constructor(private readonly options: CloudflareProviderOptions) {
    if (!/^[a-zA-Z0-9_-]+$/.test(options.accountId) || !options.apiKey.trim())
      throw new CapabilityError(
        'provider-config',
        'Invalid Cloudflare account ID or empty API token'
      );
    validateCloudflareOptions(
      {
        accountId: options.accountId,
        keepAliveMs: options.keepAliveMs,
        lab: options.lab,
        recording: options.recording,
        takeOwnership: options.takeOwnership,
        providerSessionId: options.providerSessionId,
      },
      options.engine
    );
    if (!options.idGenerator && !globalThis.crypto?.randomUUID)
      throw new CapabilityError('crypto', 'This host must supply an idGenerator before allocation');
    this.base = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/browser-run/devtools/browser`;
    this.http = options.fetch ?? fetch;
  }
  private async request(url: string, method: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeout ?? 30000);
    try {
      return await this.http(url, {
        method,
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      throw new CapabilityError(
        method === 'POST' ? 'allocation_unknown' : 'provider-http',
        method === 'POST'
          ? 'Cloudflare allocation outcome unknown; do not retry allocation blindly'
          : 'Cloudflare lifecycle request failed'
      );
    } finally {
      clearTimeout(timer);
    }
  }
  private endpoint(sessionId: string): string {
    return `${this.base}/${encodeURIComponent(sessionId)}`;
  }
  private session(
    sessionId: string | undefined,
    owned: boolean,
    url: string,
    requestedEngine?: CloudflareEngine
  ): ProviderSession {
    let terminal: ProviderReleaseResult | undefined;
    let pending: Promise<ProviderReleaseResult> | undefined;
    const generation = this.options.idGenerator?.() ?? globalThis.crypto?.randomUUID();
    if (!generation)
      throw new CapabilityError('crypto', 'This host must supply an idGenerator before allocation');
    return {
      wsUrl: url,
      sessionId,
      connection: { kind: 'url', url, headers: { Authorization: `Bearer ${this.options.apiKey}` } },
      lifecycle: {
        reconnectable: requestedEngine !== 'kitesurf',
        ownership: owned ? 'owned' : 'borrowed',
      },
      metadata: {
        provider: 'cloudflare',
        requestedEngine,
        allocationId: sessionId,
        browserGeneration: generation,
        ownership: owned ? 'owned' : 'borrowed',
      },
      close: () => {
        if (terminal) return Promise.resolve(terminal);
        if (pending) return pending;
        pending = (async (): Promise<ProviderReleaseResult> => {
          if (!owned || !sessionId)
            return {
              status: owned ? 'terminated' : 'detached',
              sessionId: sessionId ?? generation,
              providerStatus: owned ? 'connection_bound' : 'borrowed',
            };
          try {
            const response = await this.request(this.endpoint(sessionId), 'DELETE');
            if (response.status === 404 || response.status === 410)
              return { status: 'already_released', sessionId, allocationId: sessionId };
            if (!response.ok)
              return {
                status: 'cleanup_pending',
                sessionId,
                error: `Cloudflare release HTTP ${response.status}`,
              };
            const data: unknown = await withinBudget(response.json(), {
              timeout: this.options.timeout,
            }).catch(() => {
              throw new CapabilityError(
                'PROTOCOL_RESULT_INVALID',
                'Cloudflare returned invalid JSON'
              );
            });
            const status =
              typeof data === 'object' && data !== null && 'status' in data
                ? String(data.status)
                : undefined;
            return {
              status: status === 'closed' ? 'released' : 'cleanup_pending',
              sessionId,
              allocationId: sessionId,
              providerStatus: status,
            };
          } catch {
            return {
              status: 'cleanup_pending',
              sessionId,
              error: 'Cloudflare release could not be confirmed',
            };
          }
        })().then((result) => {
          if (result.status !== 'cleanup_pending') terminal = result;
          pending = undefined;
          return result;
        });
        return pending;
      },
    };
  }
  async createSession(): Promise<ProviderSession> {
    if (this.options.providerSessionId) return this.resumeSession(this.options.providerSessionId);
    if (this.options.engine === 'kitesurf')
      return this.session(
        undefined,
        true,
        `${this.base.replace('https:', 'wss:')}?browser=kitesurf`,
        'kitesurf'
      );
    const url = new URL(this.base);
    if (this.options.keepAliveMs !== undefined)
      url.searchParams.set('keep_alive', String(this.options.keepAliveMs));
    if (this.options.lab !== undefined) url.searchParams.set('lab', String(this.options.lab));
    if (this.options.recording !== undefined)
      url.searchParams.set('recording', String(this.options.recording));
    const response = await this.request(url.href, 'POST');
    if (!response.ok)
      throw new CapabilityError(
        response.status >= 500 || response.status === 408 ? 'allocation_unknown' : 'provider-http',
        `Cloudflare allocation HTTP ${response.status}; no automatic retry`
      );
    const data: unknown = await withinBudget(response.json(), {
      timeout: this.options.timeout,
    }).catch(() => {
      throw new CapabilityError(
        'allocation_unknown',
        'Cloudflare returned unreadable allocation JSON; do not retry blindly'
      );
    });
    if (
      !data ||
      typeof data !== 'object' ||
      !('sessionId' in data) ||
      typeof data.sessionId !== 'string' ||
      !data.sessionId
    )
      throw new CapabilityError(
        'allocation_unknown',
        'Cloudflare returned no allocation identity; do not retry blindly'
      );
    const session = this.session(
      data.sessionId,
      true,
      this.endpoint(data.sessionId).replace('https:', 'wss:'),
      'chromium'
    );
    try {
      if (!('webSocketDebuggerUrl' in data) || typeof data.webSocketDebuggerUrl !== 'string')
        throw new Error();
      const endpoint = new URL(data.webSocketDebuggerUrl);
      const legacyEndpoint = session.wsUrl.replace('/browser-run/', '/browser-rendering/');
      if (
        (endpoint.href !== session.wsUrl && endpoint.href !== legacyEndpoint) ||
        endpoint.username ||
        endpoint.password
      )
        throw new Error();
      return endpoint.href === session.wsUrl
        ? session
        : this.session(data.sessionId, true, endpoint.href, 'chromium');
    } catch {
      const cleanup = await session.close();
      throw Object.assign(
        new CapabilityError(
          'provider-endpoint',
          `Cloudflare returned an invalid authenticated endpoint; cleanup ${cleanup?.status}`
        ),
        { providerCleanup: cleanup }
      );
    }
  }
  async resumeSession(sessionId: string): Promise<ProviderSession> {
    if (!sessionId || this.options.engine === 'kitesurf')
      throw new CapabilityError(
        'SESSION_LOST',
        'Kitesurf requires its existing live owner; it cannot be reallocated on resume'
      );
    return this.session(
      sessionId,
      this.options.takeOwnership === true,
      this.endpoint(sessionId).replace('https:', 'wss:'),
      this.options.explicitEngine ? this.options.engine : undefined
    );
  }
}
