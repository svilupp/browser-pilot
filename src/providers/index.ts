/**
 * Provider module exports
 */

export { type BrowserUseOptions, BrowserUseProvider } from './browser-use.ts';
export { type BrowserBaseOptions, BrowserBaseProvider } from './browserbase.ts';
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
  type ChromeChannel,
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

import { getEnv } from '../runtime/env.ts';
import { BrowserUseProvider } from './browser-use.ts';
import { BrowserBaseProvider } from './browserbase.ts';
import { BrowserlessProvider } from './browserless.ts';
import { GenericProvider } from './generic.ts';
import type { ConnectOptions, Provider } from './types.ts';

/**
 * Create a provider instance based on connection options
 */
export function createProvider(options: ConnectOptions): Provider {
  switch (options.provider) {
    case 'browserbase':
      if (!options.apiKey) {
        throw new Error('BrowserBase provider requires apiKey');
      }
      if (!options.projectId) {
        throw new Error('BrowserBase provider requires projectId');
      }
      return new BrowserBaseProvider({
        apiKey: options.apiKey,
        projectId: options.projectId,
      });

    case 'browserless':
      if (!options.apiKey) {
        throw new Error('Browserless provider requires apiKey (token)');
      }
      return new BrowserlessProvider({
        token: options.apiKey,
      });

    case 'browser-use': {
      const apiKey = options.apiKey ?? getEnv('BROWSER_USE_API_KEY');
      if (!apiKey) {
        throw new Error('Browser Use provider requires apiKey or BROWSER_USE_API_KEY env var');
      }
      return new BrowserUseProvider({
        apiKey,
        proxyCountryCode: options.proxyCountryCode === undefined ? 'uk' : options.proxyCountryCode,
        profileId: options.profileId,
        timeout: options.cloudTimeout,
      });
    }

    case 'generic':
      if (!options.wsUrl) {
        throw new Error('Generic provider requires wsUrl');
      }
      return new GenericProvider({
        wsUrl: options.wsUrl,
      });

    default:
      throw new Error(`Unknown provider: ${options.provider}`);
  }
}
