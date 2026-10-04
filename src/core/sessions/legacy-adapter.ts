import { Browser } from '../../browser/browser.ts';
import { normalizeProviderSelector } from '../../providers/selector.ts';
import { withinBudget } from '../budget.ts';
import {
  CapabilityError,
  type ExecutionContext,
  type SessionHandle,
  type SessionOpenOptions,
  type SessionOwner,
} from '../ports.ts';
import { createLeaseCDP } from './lease-cdp.ts';
import type { BrowserLease, SessionOwnerV2, SessionStatus } from './owner.ts';

export interface LegacyReconnectAdapterOptions {
  owner: SessionOwner;
  /** An explicit host declaration; URL shape cannot establish reconnectability. */
  reconnectable(handle: SessionHandle): boolean;
  /** Host connector supplies authentication without serializing it in the handle. */
  connect(
    endpoint: { wsUrl: string },
    handle: SessionHandle,
    ctx: ExecutionContext
  ): Promise<Browser>;
}

/** Opt-in compatibility for URL owners; connection-bound launches are never admitted. */
export class LegacyReconnectAdapter implements SessionOwnerV2 {
  private readonly active = new Set<string>();
  private readonly releasing = new Set<string>();
  constructor(private readonly options: LegacyReconnectAdapterOptions) {}
  open(options: SessionOpenOptions, ctx: ExecutionContext): Promise<SessionHandle> {
    const selection = normalizeProviderSelector(options.provider);
    if (selection.provider === 'cloudflare' && selection.engine === 'kitesurf')
      throw new CapabilityError(
        'session-reconnect',
        'Connection-bound launch requires a connection owner'
      );
    return this.options.owner.open(options, ctx);
  }
  async acquire(handle: SessionHandle, ctx: ExecutionContext): Promise<BrowserLease> {
    if (!this.options.reconnectable(handle))
      throw new CapabilityError(
        'session-reconnect',
        'Host has not declared this legacy session reconnectable'
      );
    if (ctx.signal.aborted)
      throw new CapabilityError('cancelled', 'Lease cancelled before connection');
    if (this.releasing.has(handle.id)) throw new CapabilityError('session_releasing');
    if (this.active.has(handle.id)) throw new CapabilityError('session_busy');
    const remaining = () =>
      ctx.deadline === undefined ? undefined : Math.max(0, ctx.deadline - ctx.clock.now());
    if (remaining() === 0) throw new CapabilityError('deadline');
    this.active.add(handle.id);
    let connected: Browser | undefined;
    try {
      const endpoint = await withinBudget(this.options.owner.resolve(handle, ctx), {
        signal: ctx.signal,
        timeout: remaining(),
      });
      connected = await withinBudget(
        this.options.connect(endpoint, handle, ctx),
        { signal: ctx.signal, timeout: remaining() },
        (late) => late.disconnect()
      );
      const connection = connected;
      const view = Browser.fromCDP(createLeaseCDP(connection.cdpClient, ctx), { wsUrl: '' });
      let detached = false;
      return {
        handle,
        browser: { page: view.page.bind(view), listTargets: view.listTargets.bind(view) },
        detach: async () => {
          if (detached) return;
          detached = true;
          try {
            await view.disconnect();
          } finally {
            await connection.disconnect();
            this.active.delete(handle.id);
          }
        },
      };
    } catch (error) {
      await connected?.disconnect().catch(() => {});
      this.active.delete(handle.id);
      throw error;
    }
  }
  async inspect(handle: SessionHandle, _ctx: ExecutionContext): Promise<SessionStatus> {
    return {
      provider: handle.provider,
      sessionId: handle.sessionId,
      ownerAvailable: true,
      socketOpen: this.active.has(handle.id),
      cleanup: this.releasing.has(handle.id) ? 'releasing' : 'active',
    };
  }
  release(handle: SessionHandle, ctx: ExecutionContext) {
    this.releasing.add(handle.id);
    if (this.active.has(handle.id))
      return Promise.resolve({
        status: 'cleanup_pending' as const,
        sessionId: handle.sessionId ?? handle.id,
        error: 'Active legacy lease must detach before release',
      });
    return this.options.owner.release(handle, ctx);
  }
}
