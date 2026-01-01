/**
 * Generic CDP provider for direct WebSocket connections
 * Use this when connecting to a local Chrome instance or any CDP-compatible endpoint
 */

import type { CreateSessionOptions, Provider, ProviderSession } from './types.ts';

export interface GenericProviderOptions {
  /** WebSocket URL to connect to (e.g., ws://localhost:9222/devtools/browser/xxx) */
  wsUrl: string;
}

export class GenericProvider implements Provider {
  readonly name = 'generic';
  private readonly wsUrl: string;

  constructor(options: GenericProviderOptions) {
    this.wsUrl = options.wsUrl;
  }

  async createSession(_options: CreateSessionOptions = {}): Promise<ProviderSession> {
    // For generic provider, the wsUrl is provided directly
    return {
      wsUrl: this.wsUrl,
      metadata: {
        provider: 'generic',
      },
      close: async () => {
        // No cleanup needed for generic provider
        // The browser instance is managed externally
      },
    };
  }
}

/**
 * Discover CDP endpoints from a Chrome DevTools JSON endpoint
 * Useful for connecting to a local Chrome instance
 *
 * @param host - Host to query (e.g., "localhost:9222")
 * @returns List of available debug targets
 */
export async function discoverTargets(
  host: string = 'localhost:9222'
): Promise<Array<{ id: string; type: string; url: string; webSocketDebuggerUrl?: string }>> {
  const protocol = host.includes('://') ? '' : 'http://';
  const response = await fetch(`${protocol}${host}/json/list`);

  if (!response.ok) {
    throw new Error(`Failed to discover targets: ${response.status}`);
  }

  return (await response.json()) as Array<{
    id: string;
    type: string;
    url: string;
    webSocketDebuggerUrl?: string;
  }>;
}

/**
 * Get the browser-level WebSocket debugger URL
 *
 * @param host - Host to query (e.g., "localhost:9222")
 * @returns WebSocket URL for browser-level CDP connection
 */
export async function getBrowserWebSocketUrl(host: string = 'localhost:9222'): Promise<string> {
  const protocol = host.includes('://') ? '' : 'http://';
  const response = await fetch(`${protocol}${host}/json/version`);

  if (!response.ok) {
    throw new Error(`Failed to get browser info: ${response.status}`);
  }

  const info = (await response.json()) as { webSocketDebuggerUrl: string };
  return info.webSocketDebuggerUrl;
}
