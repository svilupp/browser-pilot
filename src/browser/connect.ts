import { randomUUID } from 'node:crypto';
import { CapabilityError } from '../core/ports.ts';
import { validateCloudflareOptions } from '../providers/cloudflare.ts';
import { normalizeProviderSelector } from '../providers/selector.ts';
/**
 * Node-flavored connect entry.
 *
 * Wires the Node runtime capabilities (env-backed secrets, local Chrome
 * discovery) into the Node-flavored Browser entry. This module is intentionally
 * NOT part of the portable `browser-pilot/core` graph.
 */

import { createBunTransportFactory } from '../adapters/bun/index.ts';
import { nodeRecordingIo } from '../adapters/node/recording.ts';
import { createNodeTransportFactory } from '../adapters/node/transport.ts';
import type { CDPClient } from '../cdp/client.ts';
import type { SecretsPort } from '../core/ports.ts';
import { resolveBrowserEndpoint } from '../providers/local-discovery.ts';
import type { Provider, ProviderSession } from '../providers/types.ts';
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
  protected constructor(
    cdp: CDPClient,
    provider: Provider,
    session: ProviderSession,
    options: BrowserOptions
  ) {
    super(cdp, provider, session, {
      ...options,
      recordingIo: options.recordingIo ?? nodeRecordingIo,
    });
  }
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
    const selection = normalizeProviderSelector(options.provider);
    if (selection.provider === 'cloudflare')
      validateCloudflareOptions(options.cloudflare ?? {}, selection.engine);
    if (options.signal?.aborted)
      throw new CapabilityError('cancelled', 'Connect cancelled before allocation');
    const transportFactory =
      options.transportFactory ??
      (typeof globalThis.Bun !== 'undefined'
        ? createBunTransportFactory()
        : options.provider.startsWith('cloudflare') ||
            options.wsHeaders ||
            typeof globalThis.WebSocket === 'undefined'
          ? await createNodeTransportFactory()
          : undefined);
    // biome-ignore lint/complexity/noThisInStatic: super must preserve the concrete static constructor
    return super.connect({
      transportFactory,
      idGenerator: options.idGenerator ?? randomUUID,
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
