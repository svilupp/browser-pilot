/**
 * Node-flavored connect entry.
 *
 * Wires the Node runtime capabilities (env-backed secrets, local Chrome
 * discovery) into the Node-flavored Browser entry. This module is intentionally
 * NOT part of the portable `browser-pilot/core` graph.
 */

import type { SecretsPort } from '../core/ports.ts';
import { resolveBrowserEndpoint } from '../providers/local-discovery.ts';
import { getEnv } from '../runtime/env.ts';
import {
  type BrowserOptions,
  type LocalEndpointRequest,
  Browser as PortableBrowser,
} from './browser.ts';

/** Env-backed secrets (honors `setEnvOverrides`). */
const envSecrets: SecretsPort = { get: getEnv };

async function resolveLocalEndpoint(request: LocalEndpointRequest): Promise<{ wsUrl: string }> {
  const endpoint = await resolveBrowserEndpoint({
    channel: request.channel,
    userDataDir: request.userDataDir,
    allowLocalDiscovery: true,
    allowLegacyHostFallback: true,
  });
  return { wsUrl: endpoint.wsUrl };
}

/**
 * Node-flavored Browser constructor.
 *
 * The portable Browser class deliberately has no ambient runtime fallback.
 * Keeping these defaults on the root entry's subclass means `Browser.connect`
 * remains useful when a bundler tree-shakes the convenience `connect` export,
 * without mutating shared module state or changing the portable class.
 */
export class Browser extends PortableBrowser {
  static override fromCDP(
    cdp: Parameters<typeof PortableBrowser.fromCDP>[0],
    sessionInfo: Parameters<typeof PortableBrowser.fromCDP>[1]
  ): Browser {
    // `super` preserves the subclass as the polymorphic static constructor.
    // biome-ignore lint/complexity/noThisInStatic: required for polymorphic static construction
    return super.fromCDP(cdp, sessionInfo) as Browser;
  }

  static override async connect(options: BrowserOptions): Promise<Browser> {
    // `super` preserves the subclass as the polymorphic static constructor.
    // biome-ignore lint/complexity/noThisInStatic: required for polymorphic static construction
    return super.connect({
      ...options,
      secrets: options.secrets ?? envSecrets,
      localEndpointResolver: options.localEndpointResolver ?? resolveLocalEndpoint,
    }) as Promise<Browser>;
  }
}

/**
 * Connect to a browser instance.
 * Convenience function for Browser.connect() with Node runtime defaults
 * (env-backed API keys, local Chrome discovery for the generic provider).
 */
export function connect(options: BrowserOptions): Promise<Browser> {
  return Browser.connect(options);
}
