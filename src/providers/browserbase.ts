/**
 * BrowserBase provider implementation
 * https://docs.browserbase.com/
 */

import type { CreateSessionOptions, Provider, ProviderSession } from './types.ts';

export interface BrowserBaseOptions {
  apiKey: string;
  projectId: string;
  baseUrl?: string;
}

interface BrowserBaseSession {
  id: string;
  projectId: string;
  status: string;
  createdAt: string;
  connectUrl?: string;
  debugUrl?: string;
}

export class BrowserBaseProvider implements Provider {
  readonly name = 'browserbase';
  private readonly apiKey: string;
  private readonly projectId: string;
  private readonly baseUrl: string;

  constructor(options: BrowserBaseOptions) {
    this.apiKey = options.apiKey;
    this.projectId = options.projectId;
    this.baseUrl = options.baseUrl ?? 'https://api.browserbase.com';
  }

  async createSession(options: CreateSessionOptions = {}): Promise<ProviderSession> {
    const response = await fetch(`${this.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        'X-BB-API-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId: this.projectId,
        browserSettings: {
          viewport:
            options.width && options.height
              ? {
                  width: options.width,
                  height: options.height,
                }
              : undefined,
        },
        ...options,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`BrowserBase createSession failed: ${response.status} ${text}`);
    }

    const session = (await response.json()) as BrowserBaseSession;

    // Get the connect URL
    const connectResponse = await fetch(`${this.baseUrl}/v1/sessions/${session.id}`, {
      headers: {
        'X-BB-API-Key': this.apiKey,
      },
    });

    if (!connectResponse.ok) {
      throw new Error(`BrowserBase getSession failed: ${connectResponse.status}`);
    }

    const sessionDetails = (await connectResponse.json()) as BrowserBaseSession;

    if (!sessionDetails.connectUrl) {
      throw new Error('BrowserBase session does not have a connectUrl');
    }

    return {
      wsUrl: sessionDetails.connectUrl,
      sessionId: session.id,
      metadata: {
        debugUrl: sessionDetails.debugUrl,
        projectId: this.projectId,
        status: sessionDetails.status,
      },
      close: async () => {
        await fetch(`${this.baseUrl}/v1/sessions/${session.id}`, {
          method: 'DELETE',
          headers: {
            'X-BB-API-Key': this.apiKey,
          },
        });
      },
    };
  }

  async resumeSession(sessionId: string): Promise<ProviderSession> {
    const response = await fetch(`${this.baseUrl}/v1/sessions/${sessionId}`, {
      headers: {
        'X-BB-API-Key': this.apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`BrowserBase resumeSession failed: ${response.status}`);
    }

    const session = (await response.json()) as BrowserBaseSession;

    if (!session.connectUrl) {
      throw new Error('BrowserBase session does not have a connectUrl (may be closed)');
    }

    return {
      wsUrl: session.connectUrl,
      sessionId: session.id,
      metadata: {
        debugUrl: session.debugUrl,
        projectId: this.projectId,
        status: session.status,
      },
      close: async () => {
        await fetch(`${this.baseUrl}/v1/sessions/${sessionId}`, {
          method: 'DELETE',
          headers: {
            'X-BB-API-Key': this.apiKey,
          },
        });
      },
    };
  }
}
