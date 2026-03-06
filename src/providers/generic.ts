/**
 * Generic CDP provider for direct WebSocket connections
 * Use this when connecting to a local Chrome instance or any CDP-compatible endpoint
 */

import type { CreateSessionOptions, Provider, ProviderSession } from './types.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchDevToolsJson<T>(
  host: string,
  path: string,
  errorPrefix: string,
  options: { attempts?: number; initialDelayMs?: number; maxDelayMs?: number } = {}
): Promise<T> {
  const protocol = host.includes('://') ? '' : 'http://';
  const attempts = options.attempts ?? 1;
  let delayMs = options.initialDelayMs ?? 50;
  const maxDelayMs = options.maxDelayMs ?? 250;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(`${protocol}${host}${path}`);
      if (response.ok) {
        return (await response.json()) as T;
      }
      lastError = new Error(`${errorPrefix}: ${response.status}`);
    } catch (error) {
      lastError = new Error(
        `${errorPrefix}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    if (attempt < attempts) {
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
  }

  throw lastError ?? new Error(errorPrefix);
}

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
  return fetchDevToolsJson<
    Array<{
      id: string;
      type: string;
      url: string;
      webSocketDebuggerUrl?: string;
    }>
  >(host, '/json/list', 'Failed to discover targets');
}

/**
 * Get the browser-level WebSocket debugger URL
 *
 * @param host - Host to query (e.g., "localhost:9222")
 * @returns WebSocket URL for browser-level CDP connection
 */
export async function getBrowserWebSocketUrl(host: string = 'localhost:9222'): Promise<string> {
  const info = await fetchDevToolsJson<{
    id: string;
    webSocketDebuggerUrl: string;
  }>(host, '/json/version', 'Failed to get browser info', {
    attempts: 10,
    initialDelayMs: 50,
    maxDelayMs: 250,
  });
  return info.webSocketDebuggerUrl;
}
