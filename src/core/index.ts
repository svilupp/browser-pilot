/**
 * browser-pilot/core — portable hexagonal core.
 *
 * This entrypoint is safe for any Web-Standard runtime (Node, Bun, Cloudflare
 * Workers, browsers): its reachable import graph contains no `node:*` imports,
 * no `process.env` access, no CLI/daemon code, and no local Chrome discovery.
 * Hosted credentials and transport inputs are explicit connection options;
 * this entry never reads `process.env` or performs local browser discovery.
 */

import { Browser, type BrowserOptions } from '../browser/browser.ts';

// Browser & Page (portable classes; no ambient runtime access)
export {
  Browser,
  type BrowserOptions,
  type LocalEndpointRequest,
  type LocalEndpointResolver,
  type NewPageOptions,
  type PageOptions,
} from '../browser/browser.ts';
export { Page, type PageInitOptions } from '../browser/page.ts';
// Portable provider factory + providers (explicit credentials or SecretsPort only)
export { type BrowserUseOptions, BrowserUseProvider } from '../providers/browser-use.ts';
export {
  type BrowserBaseClock,
  type BrowserBaseOptions,
  BrowserBaseProvider,
} from '../providers/browserbase.ts';
export { type BrowserlessOptions, BrowserlessProvider } from '../providers/browserless.ts';
export { createProvider, type ProviderFactoryPorts } from '../providers/factory.ts';
export {
  discoverTargets,
  GenericProvider,
  type GenericProviderOptions,
  getBrowserWebSocketUrl,
} from '../providers/generic.ts';
// Provider data types (includes ProviderReleaseResult, ProviderSession, ConnectOptions)
export * from '../providers/types.ts';
// Port contracts
export * from './ports.ts';

/**
 * Portable connection entry. Credentials and transport are supplied through
 * the options object (or through a provider session created by a trusted host).
 */
export function connectCore(options: BrowserOptions): Promise<Browser> {
  return Browser.connect(options);
}

/** Compatibility type alias; core connection options are plain Browser options. */
export type ConnectCoreOptions = BrowserOptions;
