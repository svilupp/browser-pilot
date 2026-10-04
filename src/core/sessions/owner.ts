import { Browser, type BrowserOptions, type PageOptions } from '../../browser/browser.ts';
import type { Page } from '../../browser/page.ts';
import { normalizeProviderSelector } from '../../providers/selector.ts';
import type { ProviderReleaseResult } from '../../providers/types.ts';
import { withinBudget } from '../budget.ts';
import {
  CapabilityError,
  type ExecutionContext,
  type SessionHandle,
  type SessionOpenOptions,
} from '../ports.ts';
import { createLeaseCDP } from './lease-cdp.ts';

/** Borrowed operations deliberately omit provider close and socket disconnect. */
export interface BorrowedBrowser {
  page(name?: string, options?: PageOptions): Promise<Page>;
  listTargets(): Promise<import('../../cdp/protocol.ts').TargetInfo[]>;
}
export interface BrowserLease {
  handle: SessionHandle;
  browser: BorrowedBrowser;
  detach(): Promise<void>;
}
export interface SessionStatus {
  capabilities?: {
    lifecycle: import('../../browser/capabilities.ts').CapabilityReport[];
    interaction: import('../../browser/capabilities.ts').CapabilityReport[];
  };
  provider: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  ownerAvailable: boolean;
  socketOpen: boolean;
  browserResponsive?: boolean;
  targetExists?: boolean;
  documentHealthy?: boolean;
  cleanup: 'active' | 'releasing' | 'cleanup_pending';
}
export interface SessionOwnerV2 {
  open(options: SessionOpenOptions, ctx: ExecutionContext): Promise<SessionHandle>;
  acquire(handle: SessionHandle, ctx: ExecutionContext): Promise<BrowserLease>;
  inspect(handle: SessionHandle, ctx: ExecutionContext): Promise<SessionStatus>;
  release(handle: SessionHandle, ctx: ExecutionContext): Promise<ProviderReleaseResult>;
}
export interface ConnectionSessionOwnerOptions {
  /** Host defaults, including credentials, transports, and discovery. */
  connect?: (options: BrowserOptions) => Promise<Browser>;
  defaults?: Omit<BrowserOptions, 'provider'>;
  leaseMs?: number;
  idGenerator?: () => string;
}
interface RecordState {
  browser: Browser;
  handle: SessionHandle;
  active: boolean;
  releasing: boolean;
  cleanupPending: boolean;
  releaseResult?: ProviderReleaseResult;
  targetId?: string;
  connectOptions: BrowserOptions;
  releasePromise?: Promise<ProviderReleaseResult>;
}
function admit(ctx: ExecutionContext): void {
  if (ctx.signal.aborted) throw new CapabilityError('cancelled', 'Session operation cancelled');
  if (ctx.deadline !== undefined && ctx.clock.now() >= ctx.deadline)
    throw new CapabilityError('deadline', 'Session operation deadline exceeded');
}

/** Event-scoped portable owner. Holds exactly one physical connection per opened browser. */
export class ConnectionSessionOwner implements SessionOwnerV2 {
  private readonly records = new Map<string, RecordState>();
  private readonly epoch: string;
  private readonly idGenerator: () => string;
  constructor(private readonly options: ConnectionSessionOwnerOptions = {}) {
    this.idGenerator =
      options.idGenerator ??
      (() => {
        const id = globalThis.crypto?.randomUUID();
        if (!id) throw new CapabilityError('crypto', 'Session owners require a host idGenerator');
        return id;
      });
    this.epoch = this.idGenerator();
  }
  async open(options: SessionOpenOptions, ctx: ExecutionContext): Promise<SessionHandle> {
    admit(ctx);
    const selection = normalizeProviderSelector(options.provider);
    const timeout =
      ctx.deadline === undefined ? options.timeout : Math.max(1, ctx.deadline - ctx.clock.now());
    const browser = await withinBudget(
      (this.options.connect ?? Browser.connect.bind(Browser))({
        ...this.options.defaults,
        ...options,
        timeout,
        signal: ctx.signal,
      } as BrowserOptions),
      { timeout, signal: ctx.signal },
      (browser) => browser.close()
    );
    try {
      admit(ctx);
    } catch (error) {
      await browser.close();
      throw error;
    }
    const handle: SessionHandle = {
      id: `${this.epoch}:${this.idGenerator()}`,
      generation: ctx.generation,
      provider: selection.provider,
      ...(browser.sessionId ? { sessionId: browser.sessionId } : {}),
      ...(this.options.leaseMs === undefined
        ? {}
        : { leaseExpiresAt: ctx.clock.now() + this.options.leaseMs }),
    };
    this.records.set(handle.id, {
      browser,
      handle: { ...handle },
      active: false,
      releasing: false,
      cleanupPending: false,
      connectOptions: { ...this.options.defaults, ...options } as BrowserOptions,
    });
    return handle;
  }
  private record(handle: SessionHandle, ctx: ExecutionContext, cleanup = false): RecordState {
    const record = this.records.get(handle.id);
    if (
      !record ||
      record.handle.generation !== ctx.generation ||
      handle.generation !== ctx.generation ||
      record.handle.provider !== handle.provider ||
      record.handle.sessionId !== handle.sessionId ||
      (!cleanup && record.handle.leaseExpiresAt !== handle.leaseExpiresAt)
    )
      throw new CapabilityError('stale_handle', 'Unknown, forged, or stale session handle');
    if (
      !cleanup &&
      record.handle.leaseExpiresAt !== undefined &&
      ctx.clock.now() >= record.handle.leaseExpiresAt
    )
      throw new CapabilityError('lease_expired', 'Session lease expired');
    return record;
  }
  async acquire(handle: SessionHandle, ctx: ExecutionContext): Promise<BrowserLease> {
    admit(ctx);
    const record = this.record(handle, ctx);
    // A lease covers the entire command/frame/action batch. Conservative browser
    // arbitration avoids shared frame/ref state; contention never reconnects.
    if (record.releasing) throw new CapabilityError('session_releasing', 'Session is releasing');
    if (record.active)
      throw new CapabilityError('session_busy', 'Session already has an active command lease');
    if (!record.browser.cdpClient.isConnected) {
      if (
        record.handle.provider !== 'cloudflare' ||
        record.browser.metadata?.['detectedEngine'] !== 'chromium' ||
        !record.handle.sessionId ||
        record.connectOptions.providerSession
      ) {
        throw new CapabilityError(
          'SESSION_LOST',
          'Owner connection was lost; no replacement browser was allocated'
        );
      }
      record.active = true;
      let resumed: Browser | undefined;
      try {
        resumed = await withinBudget(
          (this.options.connect ?? Browser.connect.bind(Browser))({
            ...record.connectOptions,
            provider: 'cloudflare:chromium',
            cloudflare: {
              ...record.connectOptions.cloudflare,
              providerSessionId: record.handle.sessionId,
              takeOwnership: record.browser.metadata?.['ownership'] === 'owned',
            },
            signal: ctx.signal,
            timeout: ctx.deadline === undefined ? undefined : ctx.deadline - ctx.clock.now(),
          }),
          {
            signal: ctx.signal,
            timeout: ctx.deadline === undefined ? undefined : ctx.deadline - ctx.clock.now(),
          },
          (late) => late.disconnect()
        );
        const recoveryView = Browser.fromCDP(createLeaseCDP(resumed.cdpClient, ctx), { wsUrl: '' });
        let healthy: unknown;
        try {
          const page = await recoveryView.page(
            undefined,
            record.targetId ? { targetId: record.targetId } : undefined
          );
          healthy = await page.evaluate(
            'document.documentElement?.nodeName === "HTML" && typeof document.URL === "string"'
          );
        } finally {
          await recoveryView.disconnect();
        }
        admit(ctx);
        if (healthy !== true)
          throw new CapabilityError(
            'document_health',
            'Reattached renderer did not return a healthy document'
          );
        await record.browser.disconnect();
        record.browser = resumed;
      } catch (error) {
        await resumed?.disconnect();
        throw error;
      } finally {
        record.active = false;
      }
    }
    record.active = true;
    let view: Browser;
    try {
      view = Browser.fromCDP(createLeaseCDP(record.browser.cdpClient, ctx), {
        wsUrl: '',
        provider: handle.provider,
        sessionId: handle.sessionId,
      });
    } catch (error) {
      record.active = false;
      throw error;
    }
    let detached = false;
    let detachPromise: Promise<void> | undefined;
    const assertLease = () => {
      admit(ctx);
      if (detached) throw new CapabilityError('stale_handle', 'Browser lease detached');
    };
    const browser: BorrowedBrowser = {
      page: async (name, options) => {
        assertLease();
        // Match the owner's intended target instead of rescoring after each borrow.
        const page = await view.page(
          name,
          options ?? (record.targetId ? { targetId: record.targetId } : undefined)
        );
        record.targetId ??= page.targetId;
        assertLease();
        return page;
      },
      listTargets: async () => {
        assertLease();
        return view.listTargets();
      },
    };
    return {
      handle: { ...record.handle },
      browser,
      detach: () => {
        if (detachPromise) return detachPromise;
        detached = true;
        detachPromise = view.disconnect().finally(() => {
          record.active = false;
        });
        return detachPromise;
      },
    };
  }
  async inspect(handle: SessionHandle, ctx: ExecutionContext): Promise<SessionStatus> {
    admit(ctx);
    const record = this.record(handle, ctx);
    let browserResponsive = false;
    let targetExists: boolean | undefined;
    let documentHealthy: boolean | undefined;
    if (record.browser.cdpClient.isConnected) {
      try {
        const targets = await record.browser.cdpClient.send<{
          targetInfos: Array<{ targetId: string }>;
        }>('Target.getTargets', undefined, null, { timeout: 1000, signal: ctx.signal });
        browserResponsive = Array.isArray(targets.targetInfos);
        if (record.targetId)
          targetExists = targets.targetInfos.some((target) => target.targetId === record.targetId);
        if (targetExists && !record.active) {
          const page = await record.browser.page(undefined, { targetId: record.targetId });
          const result = await page.cdpClient.send<{ result?: { value?: unknown } }>(
            'Runtime.evaluate',
            {
              expression:
                'document.documentElement?.nodeName === "HTML" && typeof document.URL === "string"',
              returnByValue: true,
            },
            undefined,
            { timeout: 1000, signal: ctx.signal }
          );
          documentHealthy = result.result?.value === true;
        }
      } catch {
        documentHealthy = false;
      }
    }
    return {
      provider: record.handle.provider,
      capabilities: {
        lifecycle: record.browser.capabilities?.report() ?? [],
        interaction: [],
      },
      sessionId: record.handle.sessionId,
      metadata: record.browser.metadata,
      ownerAvailable: true,
      browserResponsive,
      targetExists,
      documentHealthy,
      socketOpen: record.browser.cdpClient.isConnected,
      cleanup: record.cleanupPending
        ? 'cleanup_pending'
        : record.releasing
          ? 'releasing'
          : 'active',
    };
  }
  async release(handle: SessionHandle, ctx: ExecutionContext): Promise<ProviderReleaseResult> {
    const record = this.record(handle, ctx, true);
    if (record.releaseResult) return record.releaseResult;
    record.releasing = true;
    if (record.active)
      return {
        status: 'cleanup_pending',
        sessionId: record.handle.sessionId ?? handle.id,
        error: 'Active lease must detach before release',
      };
    if (record.releasePromise) return record.releasePromise;
    record.releasePromise = record.browser
      .close()
      .then((result) => {
        const release = result ?? {
          status: 'cleanup_pending' as const,
          sessionId: record.handle.sessionId ?? handle.id,
          providerStatus: 'unconfirmed',
        };
        record.cleanupPending = release.status === 'cleanup_pending';
        if (!record.cleanupPending) record.releaseResult = release;
        return { ...release, localTerminated: !record.browser.cdpClient.isConnected };
      })
      .finally(() => {
        record.releasePromise = undefined;
      });
    return record.releasePromise;
  }
}
