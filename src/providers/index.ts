/**
 * Provider module exports
 */

export { type BrowserUseOptions, BrowserUseProvider } from './browser-use.ts';
export {
  type BrowserBaseClock,
  type BrowserBaseOptions,
  BrowserBaseProvider,
} from './browserbase.ts';
export { type BrowserlessOptions, BrowserlessProvider } from './browserless.ts';
export {
  discoverTargets,
  GenericProvider,
  type GenericProviderOptions,
  getBrowserWebSocketUrl,
} from './generic.ts';
export {
  BrowserEndpointResolutionError,
  buildLocalBrowserScanTargets,
  type ChromeUserDataDirOptions,
  type DiscoverLocalBrowsersOptions,
  discoverLocalBrowsers,
  parseDevToolsActivePortFile,
  type ResolvedBrowserEndpoint,
  type ResolvedBrowserSource,
  resolveBrowserEndpoint,
  resolveChromeUserDataDirs,
} from './local-discovery.ts';
export * from './types.ts';

import type { SecretsPort } from '../core/ports.ts';
import { getEnv } from '../runtime/env.ts';
import { createProvider as createProviderCore, type ProviderFactoryPorts } from './factory.ts';
import type { ConnectOptions, Provider } from './types.ts';

export type { ProviderFactoryPorts } from './factory.ts';

/** Env-backed secrets (honors `setEnvOverrides`); the Node default for this entry. */
const envSecrets: SecretsPort = { get: getEnv };

/**
 * Create a provider instance based on connection options.
 *
 * This Node-flavored wrapper falls back to environment variables
 * (`BROWSERBASE_API_KEY`, ...) via an env-backed SecretsPort. For the
 * portable, env-free variant import `createProvider` from
 * `browser-pilot/core` and pass an explicit SecretsPort.
 */
export function createProvider(options: ConnectOptions, ports?: ProviderFactoryPorts): Provider {
  return createProviderCore(options, { secrets: ports?.secrets ?? envSecrets });
}
