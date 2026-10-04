import { CapabilityError } from '../core/ports.ts';
import type { CloudflareEngine, ProviderId, ProviderSelector } from './types.ts';

export interface NormalizedProviderSelector {
  provider: ProviderId;
  engine?: CloudflareEngine;
  explicitEngine: boolean;
}

/** Normalize selection without credentials, environment reads, or I/O. */
export function normalizeProviderSelector(selector: string): NormalizedProviderSelector {
  if (
    selector === 'cloudflare' ||
    selector === 'cloudflare:chromium' ||
    selector === 'cloudflare:kitesurf'
  ) {
    return {
      provider: 'cloudflare',
      engine: selector === 'cloudflare:kitesurf' ? 'kitesurf' : 'chromium',
      explicitEngine: selector !== 'cloudflare',
    };
  }
  if (['generic', 'browserbase', 'browserless', 'browser-use'].includes(selector)) {
    return { provider: selector as ProviderId, explicitEngine: false };
  }
  throw new CapabilityError(
    'provider-selector',
    'Invalid provider selector. Use generic, browserbase, browserless, browser-use, cloudflare, cloudflare:chromium, or cloudflare:kitesurf.'
  );
}

/** Validate a constraint against authoritative stored identity, without applying a new-session default. */
export function assertProviderConstraint(
  selector: ProviderSelector,
  provider: ProviderId,
  engine?: CloudflareEngine
): void {
  const requested = normalizeProviderSelector(selector);
  if (
    requested.provider !== provider ||
    (requested.explicitEngine && requested.engine !== engine)
  ) {
    throw new CapabilityError(
      'provider-selector',
      'Requested provider/engine conflicts with stored session identity'
    );
  }
}
