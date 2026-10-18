import type { Browser } from '../../browser/browser.ts';
import type { Page } from '../../browser/page.ts';
import { attachSession, resolveSession } from '../../cli/attach.ts';
import { now as clockNow } from '../../runtime/clock.ts';

export interface NamedSessionOptions {
  session: string;
  targetPolicy: 'selected' | 'exact';
  targetId?: string;
  recovery?: 'never';
  signal?: AbortSignal;
  deadline?: number;
}
export interface NamedSessionHandback {
  confirmed: true;
  ownerEpoch: string;
  targetId: string;
  refsInvalidated: true;
  pendingActions: 'drained';
  bindingRevision: number;
  observationEpoch: string;
}
export interface NamedSessionBorrow {
  protocolVersion: 1;
  ownerEpoch: string;
  fencingToken: string;
  exclusive: true;
  capabilities: { ownerProtocolVersion: 2; rawCompatibility: true; nativeAtomic: false };
  browser: Browser;
  page: Page;
  handback(options: { targetId: string }): Promise<NamedSessionHandback>;
  detach(): Promise<void>;
}

/** Borrow only a live daemon-owned named session. Never reconnect or create a page. */
export async function borrowNamedSession(
  options: NamedSessionOptions
): Promise<NamedSessionBorrow> {
  if (options.signal?.aborted || (options.deadline !== undefined && options.deadline <= clockNow()))
    throw new Error('Named session borrowing cancelled before acquisition');
  const saved = await resolveSession(options.session);
  if (!saved.daemon) throw new Error('Named borrowing requires an existing daemon owner');
  const targetId = options.targetPolicy === 'exact' ? options.targetId : saved.targetId;
  if (!targetId) throw new Error('Named borrowing requires an exact existing page identity');
  const attached = await attachSession(
    // Legacy records may carry daemon metadata without a transport declaration.
    // Borrowing must still forbid attachSession's legacy direct-connect fallback.
    {
      ...saved,
      transport: {
        mode: 'daemon',
        ...(saved.transport?.mode === 'daemon' ? { daemonId: saved.transport.daemonId } : {}),
      },
    },
    { policy: 'observe', targetId, persistBinding: false },
    false
  );
  let detached = false;
  const expire = () => {
    void attached.browser.disconnect();
  };
  options.signal?.addEventListener('abort', expire, { once: true });
  const timer =
    options.deadline === undefined
      ? undefined
      : setTimeout(expire, Math.max(0, options.deadline - clockNow()));
  const clearLifetime = () => {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', expire);
  };
  try {
    if (!attached.viaDaemon) throw new Error('Named borrowing requires a daemon owner');
    const grant = await attached.page.cdpClient.send<{
      protocolVersion: number;
      ownerEpoch: string;
      grantId: string;
    }>('daemon.acquireLease', { session: saved.id }, null);
    if (grant.protocolVersion !== 2 || !grant.ownerEpoch || !grant.grantId)
      throw new Error('Named borrowing requires owner protocol version 2');
    if (
      options.signal?.aborted ||
      (options.deadline !== undefined && options.deadline <= clockNow())
    )
      throw new Error('Named session borrowing cancelled after acquisition');
    return {
      protocolVersion: 1,
      ownerEpoch: grant.ownerEpoch,
      fencingToken: grant.grantId,
      exclusive: true,
      capabilities: { ownerProtocolVersion: 2, rawCompatibility: true, nativeAtomic: false },
      browser: attached.browser,
      page: attached.page,
      handback: ({ targetId: returnedTarget }) =>
        attached.page.cdpClient.send<NamedSessionHandback>(
          'daemon.handback',
          { targetId: returnedTarget },
          null
        ),
      async detach() {
        if (detached) return;
        detached = true;
        clearLifetime();
        attached.page.dispose();
        try {
          await attached.page.cdpClient.send('daemon.releaseLease', undefined, null);
        } finally {
          await attached.browser.disconnect();
        }
      },
    };
  } catch (error) {
    clearLifetime();
    attached.page.dispose();
    await attached.browser.disconnect();
    throw error;
  }
}
