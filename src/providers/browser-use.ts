/**
 * Browser Use provider implementation
 * https://browser-use.com/
 */

import type {
  CreateSessionOptions,
  Provider,
  ProviderReleaseResult,
  ProviderSession,
} from './types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

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

    const response = await this.request('createSession', '/browsers', {
      method: 'POST',
      headers: {
        'X-Browser-Use-API-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      this.throwApiError('createSession', response.status);
    }

    let session: BrowserUseSession | undefined;
    let sessionId: string | undefined;
    try {
      session = await this.readSession(response);
      sessionId = session.id;

      if (!session.cdpUrl) {
        throw new Error('Browser Use session does not have a cdpUrl');
      }
    } catch (error) {
      // The session may already exist on Browser Use's side even though
      // setup failed locally. Best-effort release it so we don't leak a
      // billable cloud session, without masking the original failure.
      if (sessionId) {
        const cleanup = await this.releaseSession(sessionId);
        if (error instanceof Error) {
          (error as Error & { cause?: unknown }).cause = { cleanup };
        }
      }
      throw error;
    }

    return this.toProviderSession(session);
  }

  async resumeSession(sessionId: string): Promise<ProviderSession> {
    const response = await this.request(
      'resumeSession',
      `/browsers/${encodeURIComponent(sessionId)}`,
      {
        headers: {
          'X-Browser-Use-API-Key': this.apiKey,
        },
      }
    );

    if (!response.ok) {
      this.throwApiError('resumeSession', response.status);
    }

    const session = await this.readSession(response);

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
      close: () => this.releaseSession(session.id),
    };
  }

  private async releaseSession(sessionId: string): Promise<ProviderReleaseResult> {
    try {
      const response = await this.request(
        'stopSession',
        `/browsers/${encodeURIComponent(sessionId)}`,
        {
          method: 'PATCH',
          headers: {
            'X-Browser-Use-API-Key': this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action: 'stop' }),
        }
      );
      if (response.status === 404 || response.status === 410) {
        return { status: 'already_released', sessionId };
      }
      if (!response.ok) this.throwApiError('stopSession', response.status);
      const stopped = await this.readSession(response);
      if (stopped.id !== sessionId) throw new Error('Browser Use returned a different session ID');
      if (stopped.status === 'stopped') {
        return { status: 'released', sessionId, providerStatus: 'stopped' };
      }
      return { status: 'cleanup_pending', sessionId, providerStatus: 'active' };
    } catch (error) {
      // Only locally constructed diagnostics reach this point: request/body
      // failures are normalized below, without untrusted response contents.
      return {
        status: 'cleanup_pending',
        sessionId,
        error: error instanceof Error ? error.message : 'Browser Use stopSession failed',
      };
    }
  }

  private async request(operation: string, path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${path}`, init);
    } catch {
      // Fetch errors can contain reflected headers or credentials too.
      throw new Error(`Browser Use ${operation} failed: Network error`);
    }
  }

  private async readSession(response: Response): Promise<BrowserUseSession> {
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new Error('Browser Use returned invalid session JSON');
    }
    if (
      !isRecord(data) ||
      typeof data['id'] !== 'string' ||
      !data['id'] ||
      (data['status'] !== 'active' && data['status'] !== 'stopped')
    ) {
      throw new Error('Browser Use returned an invalid session response');
    }
    return data as unknown as BrowserUseSession;
  }

  private throwApiError(operation: string, status: number): never {
    const prefix = `Browser Use ${operation} failed (HTTP ${status})`;
    switch (status) {
      case 402:
        throw new Error(`${prefix}: insufficient credits`);
      case 403:
        throw new Error(`${prefix}: invalid API key`);
      case 422:
        throw new Error(`${prefix}: validation error`);
      case 429:
        throw new Error(`${prefix}: rate limit exceeded`);
      default:
        throw new Error(prefix);
    }
  }
}
