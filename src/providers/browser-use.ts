/**
 * Browser Use provider implementation
 * https://browser-use.com/
 */

import type { CreateSessionOptions, Provider, ProviderSession } from './types.ts';

export interface BrowserUseOptions {
  apiKey: string;
  baseUrl?: string;
  proxyCountryCode?: string | null;
  profileId?: string;
  timeout?: number;
  allowResizing?: boolean;
  customProxy?: {
    host: string;
    port: number;
    username?: string;
    password?: string;
  };
}

interface BrowserUseSession {
  id: string;
  status: 'active' | 'stopped';
  cdpUrl: string | null;
  liveUrl: string | null;
  timeoutAt: string;
  startedAt: string;
  finishedAt?: string | null;
}

export class BrowserUseProvider implements Provider {
  readonly name = 'browser-use';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly proxyCountryCode: string | null;
  private readonly profileId?: string;
  private readonly timeout?: number;
  private readonly allowResizing?: boolean;
  private readonly customProxy?: BrowserUseOptions['customProxy'];

  constructor(options: BrowserUseOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://api.browser-use.com/api/v2';
    this.proxyCountryCode =
      options.proxyCountryCode === undefined ? 'uk' : options.proxyCountryCode;
    this.profileId = options.profileId;
    this.timeout = options.timeout;
    this.allowResizing = options.allowResizing;
    this.customProxy = options.customProxy;
  }

  async createSession(options: CreateSessionOptions = {}): Promise<ProviderSession> {
    const body: Record<string, unknown> = {};

    // Proxy — default 'uk', explicit null disables
    body['proxyCountryCode'] = this.proxyCountryCode;

    if (options.width) body['browserScreenWidth'] = options.width;
    if (options.height) body['browserScreenHeight'] = options.height;
    if (this.profileId) body['profileId'] = this.profileId;
    if (this.timeout !== undefined) body['timeout'] = this.timeout;
    if (this.allowResizing !== undefined) body['allowResizing'] = this.allowResizing;
    if (this.customProxy) body['customProxy'] = this.customProxy;

    const response = await fetch(`${this.baseUrl}/browsers`, {
      method: 'POST',
      headers: {
        'X-Browser-Use-API-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      this.throwApiError(response.status, text);
    }

    const session = (await response.json()) as BrowserUseSession;

    if (!session.cdpUrl) {
      throw new Error('Browser Use session does not have a cdpUrl');
    }

    return this.toProviderSession(session);
  }

  async resumeSession(sessionId: string): Promise<ProviderSession> {
    const response = await fetch(`${this.baseUrl}/browsers/${sessionId}`, {
      headers: {
        'X-Browser-Use-API-Key': this.apiKey,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Browser Use resumeSession failed: ${response.status} ${text}`);
    }

    const session = (await response.json()) as BrowserUseSession;

    if (session.status !== 'active' || !session.cdpUrl) {
      throw new Error(
        'Browser Use session is not active or does not have a cdpUrl (may be stopped)'
      );
    }

    return this.toProviderSession(session);
  }

  private toProviderSession(session: BrowserUseSession): ProviderSession {
    return {
      wsUrl: session.cdpUrl!,
      sessionId: session.id,
      metadata: {
        liveUrl: session.liveUrl,
        status: session.status,
        timeoutAt: session.timeoutAt,
        proxyCountryCode: this.proxyCountryCode,
      },
      close: async () => {
        await fetch(`${this.baseUrl}/browsers/${session.id}`, {
          method: 'PATCH',
          headers: {
            'X-Browser-Use-API-Key': this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action: 'stop' }),
        });
      },
    };
  }

  private throwApiError(status: number, body: string): never {
    switch (status) {
      case 402:
        throw new Error(`Browser Use: insufficient credits (min $0.10 required). ${body}`);
      case 403:
        throw new Error(`Browser Use: invalid API key. ${body}`);
      case 422:
        throw new Error(`Browser Use: validation error. ${body}`);
      case 429:
        throw new Error(`Browser Use: rate limit exceeded. ${body}`);
      default:
        throw new Error(`Browser Use createSession failed: ${status} ${body}`);
    }
  }
}
