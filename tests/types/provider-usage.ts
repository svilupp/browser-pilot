/**
 * Consumer type test: Provider usage
 *
 * Verifies provider types work for downstream consumers.
 */
import type {
  BrowserBaseProvider,
  BrowserlessProvider,
  GenericProvider,
  Provider,
  ProviderSession,
} from '../../src/index.ts';

// Verify Provider interface can be typed
declare const provider: Provider;
const _session: ProviderSession = await provider.createSession({});
void _session;

// Verify concrete providers implement Provider
declare const bb: BrowserBaseProvider;
const _bbProvider: Provider = bb;
void _bbProvider;

declare const bl: BrowserlessProvider;
const _blProvider: Provider = bl;
void _blProvider;

declare const gp: GenericProvider;
const _gpProvider: Provider = gp;
void _gpProvider;
