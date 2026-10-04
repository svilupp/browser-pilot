import { Browser, type BrowserOptions } from '../../browser/browser.ts';
import { type MessageSocket, transportFromSocket } from '../../cdp/socket-transport.ts';
import type { TransportFactory } from '../../cdp/transport.ts';
import { withinBudget } from '../../core/budget.ts';
import { CapabilityError } from '../../core/ports.ts';
import { normalizeProviderSelector } from '../../providers/selector.ts';
import type {
  CloudflareChromiumOptions,
  ProviderReleaseResult,
  ProviderSession,
} from '../../providers/types.ts';

/** Narrow structural surface; compatible with generated Worker binding types. */
export interface BrowserBinding {
  acquire(options?: { keepAlive?: number; recording?: boolean }): Promise<{ sessionId: string }>;
  connectSession(
    sessionId: string
  ): Promise<{ webSocket: { fetch(input: string, init?: RequestInit): Promise<Response> } }>;
  closeSession(sessionId: string): Promise<{ status: 'closing' | 'closed' }>;
  getSession(sessionId: string): Promise<unknown | null>;
}
export interface UpgradeSocket extends MessageSocket {
  accept(): void;
  binaryType: string;
}
export interface WorkersTransportOptions {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Already-upgraded Workers sockets need accept(), not a constructor open event. */
export function createWorkersTransportFactory(
  host: WorkersTransportOptions = {}
): TransportFactory {
  const upgrade = host.fetch ?? ((input, init) => fetch(input, init));
  return async (url, options = {}) => {
    if (options.signal?.aborted) throw new Error('WebSocket upgrade aborted');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout ?? 30000);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await withinBudget(
        upgrade(url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'), {
          headers: { ...options.headers, Upgrade: 'websocket' },
          redirect: 'error',
          signal: controller.signal,
        }),
        options,
        (response) => {
          (response as Response & { webSocket?: UpgradeSocket }).webSocket?.close();
        }
      );
      const socket = (response as Response & { webSocket?: UpgradeSocket }).webSocket;
      if (!socket)
        throw new CapabilityError('transport', 'Workers CDP upgrade did not return a WebSocket');
      if (controller.signal.aborted) {
        socket.close();
        throw new Error('WebSocket upgrade aborted');
      }
      socket.binaryType = 'arraybuffer';
      const transport = transportFromSocket(socket);
      try {
        socket.accept();
      } catch {
        await transport.close();
        throw new CapabilityError('transport', 'Workers WebSocket accept failed');
      }
      return transport;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  };
}

export type WorkersConnectOptions =
  | BrowserOptions
  | (Omit<BrowserOptions, 'provider' | 'cloudflare' | 'apiKey'> & {
      provider: 'cloudflare' | 'cloudflare:chromium';
      apiKey?: never;
      cloudflare: Omit<CloudflareChromiumOptions, 'accountId' | 'lab'> & {
        binding: BrowserBinding;
        lab?: never;
        accountId?: never;
      };
    });

/** Worker convenience entry over the same Browser/CDP implementation. */
export async function connect(options: WorkersConnectOptions): Promise<Browser> {
  const selection = normalizeProviderSelector(options.provider);
  if (options.signal?.aborted)
    throw new CapabilityError('cancelled', 'Worker connect cancelled before allocation');
  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0))
    throw new CapabilityError('deadline', 'Connect timeout must be positive');
  if (!options.cloudflare || !('binding' in options.cloudflare)) {
    return Browser.connect({
      ...options,
      transportFactory: options.transportFactory ?? createWorkersTransportFactory(),
    } as BrowserOptions);
  }
  const cf = options.cloudflare;
  if ('lab' in cf && cf.lab !== undefined)
    throw new CapabilityError('binding', 'Browser binding does not document lab selection');
  const deadline = Date.now() + (options.timeout ?? 30000);
  const remaining = () => Math.max(0, deadline - Date.now());
  if (
    selection.provider !== 'cloudflare' ||
    selection.engine !== 'chromium' ||
    options.apiKey !== undefined ||
    cf.accountId !== undefined
  )
    throw new CapabilityError(
      'provider-config',
      'Browser binding supports Chromium only; binding and token modes are mutually exclusive'
    );
  const binding = cf.binding;
  for (const method of ['acquire', 'connectSession', 'closeSession', 'getSession'] as const) {
    if (typeof binding[method] !== 'function')
      throw new CapabilityError('binding', `Browser binding requires ${method}()`);
  }
  if (
    cf.keepAliveMs !== undefined &&
    (!Number.isInteger(cf.keepAliveMs) || cf.keepAliveMs < 10000 || cf.keepAliveMs > 1200000)
  )
    throw new CapabilityError(
      'provider-config',
      'keepAliveMs must be an integer from 10000 to 1200000'
    );
  const owned = cf.providerSessionId === undefined || cf.takeOwnership === true;
  const id =
    cf.providerSessionId ??
    (
      await withinBudget(
        binding.acquire({ keepAlive: cf.keepAliveMs, recording: cf.recording }),
        options,
        async (allocation) => {
          if (allocation.sessionId) await binding.closeSession(allocation.sessionId);
        }
      )
    ).sessionId;
  if (typeof id !== 'string' || !id)
    throw new CapabilityError('allocation_unknown', 'Binding returned no allocation identity');
  let closing: Promise<ProviderReleaseResult> | undefined;
  let terminal: ProviderReleaseResult | undefined;
  let lastCleanup: ProviderReleaseResult | undefined;
  const close = (): Promise<ProviderReleaseResult> => {
    if (terminal) return Promise.resolve(terminal);
    if (closing) return closing;
    closing = (async (): Promise<ProviderReleaseResult> => {
      if (!owned) return { status: 'detached', sessionId: id, providerStatus: 'borrowed' };
      try {
        const result = await withinBudget(binding.closeSession(id), { timeout: options.timeout });
        if (result.status === 'closed')
          return { status: 'released', sessionId: id, allocationId: id };
        if ((await withinBudget(binding.getSession(id), { timeout: options.timeout })) === null)
          return { status: 'already_released', sessionId: id, allocationId: id };
        return { status: 'cleanup_pending', sessionId: id, providerStatus: result.status };
      } catch {
        return {
          status: 'cleanup_pending',
          sessionId: id,
          error: 'Binding release could not be confirmed',
        };
      }
    })().then((result) => {
      lastCleanup = result;
      if (result.status !== 'cleanup_pending') terminal = result;
      closing = undefined;
      return result;
    });
    return closing;
  };
  try {
    const session: ProviderSession = {
      wsUrl: '',
      sessionId: id,
      lifecycle: { reconnectable: true, ownership: owned ? 'owned' : 'borrowed' },
      metadata: {
        provider: 'cloudflare',
        requestedEngine: 'chromium',
        allocationId: id,
        browserGeneration: crypto.randomUUID(),
        ownership: owned ? 'owned' : 'borrowed',
      },
      connection: {
        kind: 'opener',
        open: async (_url, transportOptions) => {
          const connectDeadline = Date.now() + (transportOptions?.timeout ?? 30000);
          const connection = await withinBudget(binding.connectSession(id), transportOptions ?? {});
          return createWorkersTransportFactory({
            fetch: (url, init) => connection.webSocket.fetch(url, init),
          })('https://browser-binding.invalid', {
            ...transportOptions,
            timeout: Math.max(0, connectDeadline - Date.now()),
          });
        },
      },
      close,
    };
    return await Browser.connect({
      ...options,
      cloudflare: undefined,
      providerSession: session,
      timeout: remaining(),
    } as BrowserOptions);
  } catch (error) {
    const cleanup = lastCleanup ?? (await close());
    if (error instanceof Error && cleanup.status === 'cleanup_pending')
      Object.assign(error, { providerCleanup: cleanup });
    throw error;
  }
}
