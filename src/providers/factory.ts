/**
 * Portable provider factory.
 *
 * Runtime-portable: resolves credentials only from explicit options or an
 * injected {@link SecretsPort} — never from ambient `process.env`. The root
 * entry (`src/providers/index.ts`) wraps this with an env-backed SecretsPort
 * for backward compatibility.
 */

import { CapabilityError, type SecretsPort } from '../core/ports.ts';
import { BrowserUseProvider } from './browser-use.ts';
import { BrowserBaseProvider } from './browserbase.ts';
import { BrowserlessProvider } from './browserless.ts';
import { CloudflareProvider, resolveCloudflareOptions } from './cloudflare.ts';
import { GenericProvider } from './generic.ts';
import { normalizeProviderSelector } from './selector.ts';
import type { ConnectOptions, Provider } from './types.ts';

/** Ports the provider factory may use. */
export interface ProviderFactoryPorts {
  /** Secret source for provider API keys (e.g. env-backed in Node). */
  secrets?: SecretsPort;
  idGenerator?: () => string;
}

function resolveApiKey(
  options: ConnectOptions,
  ports: ProviderFactoryPorts | undefined,
  envName: string,
  requirement: string
): string {
  const apiKey = options.apiKey ?? ports?.secrets?.get(envName);
  if (!apiKey) {
    throw new CapabilityError('secrets', requirement);
  }
  return apiKey;
}

/**
 * Create a provider instance based on connection options.
 *
 * When `apiKey` is not passed explicitly, hosted-provider credentials are
 * resolved through `ports.secrets`; if that also fails, a
 * `CapabilityError('secrets')` is thrown.
 */
export function createProvider(options: ConnectOptions, ports?: ProviderFactoryPorts): Provider {
  const normalized = normalizeProviderSelector(options.provider);
  switch (normalized.provider) {
    case 'cloudflare':
      return new CloudflareProvider({
        ...resolveCloudflareOptions(options, ports?.secrets),
        idGenerator: ports?.idGenerator,
      });
    case 'browserbase': {
      const apiKey = resolveApiKey(
        options,
        ports,
        'BROWSERBASE_API_KEY',
        'BrowserBase provider requires apiKey: pass `apiKey` or provide BROWSERBASE_API_KEY through secrets'
      );
      const projectId = options.projectId ?? ports?.secrets?.get('BROWSERBASE_PROJECT_ID');
      return new BrowserBaseProvider({
        apiKey,
        projectId,
      });
    }

    case 'browserless': {
      const apiKey = resolveApiKey(
        options,
        ports,
        'BROWSERLESS_API_KEY',
        'Browserless provider requires apiKey (token) or BROWSERLESS_API_KEY through secrets'
      );
      return new BrowserlessProvider({
        token: apiKey,
      });
    }

    case 'browser-use': {
      const apiKey = resolveApiKey(
        options,
        ports,
        'BROWSER_USE_API_KEY',
        'Browser Use provider requires apiKey or BROWSER_USE_API_KEY through secrets'
      );
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
