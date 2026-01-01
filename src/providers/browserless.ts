/**
 * Browserless.io provider implementation
 * https://www.browserless.io/docs/
 */

import type { CreateSessionOptions, Provider, ProviderSession } from './types.ts';

export interface BrowserlessOptions {
  token: string;
  baseUrl?: string;
}

export class BrowserlessProvider implements Provider {
  readonly name = 'browserless';
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(options: BrowserlessOptions) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? 'wss://chrome.browserless.io';
  }

  async createSession(options: CreateSessionOptions = {}): Promise<ProviderSession> {
    // Browserless uses direct WebSocket connection with token as query param
    const params = new URLSearchParams({
      token: this.token,
    });

    if (options.width && options.height) {
      params.set('--window-size', `${options.width},${options.height}`);
    }

    if (options.proxy?.server) {
      params.set('--proxy-server', options.proxy.server);
    }

    const wsUrl = `${this.baseUrl}?${params.toString()}`;

    return {
      wsUrl,
      metadata: {
        provider: 'browserless',
      },
      close: async () => {
        // Browserless sessions close when WebSocket disconnects
        // No explicit API call needed
      },
    };
  }

  // Browserless doesn't support session resumption in the same way
  // Each connection is a fresh browser instance
}
