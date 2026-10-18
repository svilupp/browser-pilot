import { createCDPClientFromTransport } from '../../cdp/client.ts';
import { resolveSession } from '../../cli/attach.ts';
import type { OwnerActionPort } from '../../core/owner-actions/types.ts';
import { endpointFingerprint } from '../../daemon/registry.ts';
import { createDaemonTransport } from '../../daemon/transport.ts';
import { now as clockNow } from '../../runtime/clock.ts';
import type { NamedSessionHandback, NamedSessionOptions } from './named-session.ts';

export interface BorrowedOwnerActions {
  protocolVersion: 1;
  ownerEpoch: string;
  fencingToken: string;
  exclusive: true;
  pageTargetId: string;
  port: OwnerActionPort;
  handback(options: { targetId: string }): Promise<NamedSessionHandback>;
  detach(): Promise<void>;
}

/** Strict typed port: no raw Page, expression or CDP client escapes to the caller. */
export async function borrowOwnerActions(
  options: NamedSessionOptions
): Promise<BorrowedOwnerActions> {
  if (options.signal?.aborted || (options.deadline !== undefined && options.deadline <= clockNow()))
    throw new Error('Owner borrowing cancelled before acquisition');
  const saved = await resolveSession(options.session);
  const pageTargetId = options.targetPolicy === 'exact' ? options.targetId : saved.targetId;
  if (!saved.daemon || !pageTargetId)
    throw new Error('Typed owner borrowing requires an existing daemon and page');
  const cdp = createCDPClientFromTransport(await createDaemonTransport(saved.daemon.socketPath));
  let detached = false;
  const expire = () => {
    void cdp.close();
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
  const invoke = <T>(method: string, params?: Record<string, unknown>) =>
    cdp.send<T>(method, params, null, {
      signal: options.signal,
      timeout:
        options.deadline === undefined ? undefined : Math.max(0, options.deadline - clockNow()),
    });
  try {
    const hello = await invoke<{
      protocolVersion: number;
      ownerEpoch: string;
      endpointFingerprint?: string;
      daemonId?: string;
    }>('daemon.ping');
    if (hello.protocolVersion !== 2)
      throw new Error('Typed borrowing requires owner protocol version 2');
    if (
      hello.endpointFingerprint !== endpointFingerprint(saved.wsUrl) ||
      (saved.transport?.mode === 'daemon' &&
        saved.transport.daemonId !== undefined &&
        hello.daemonId !== saved.transport.daemonId)
    )
      throw new Error('Typed borrowing owner identity does not match the named session');
    const grant = await invoke<{ ownerEpoch: string; grantId: string }>('daemon.acquireLease', {
      session: saved.id,
    });
    if (grant.ownerEpoch !== hello.ownerEpoch || !grant.grantId)
      throw new Error('Owner epoch changed during acquisition');
    const port: OwnerActionPort = {
      capabilities: () => invoke('owner.action.capabilities'),
      observe: (request) => invoke('owner.action.observe', request),
      extract: (request) => invoke('owner.action.extract', { ...request }),
      prepare: (request) => invoke('owner.action.prepare', request),
      authorize: (request) => invoke('owner.action.authorize', request),
      dispatch: (request) => invoke('owner.action.dispatch', request),
    };
    await port.capabilities();
    // Resolve the exact page using owner-controlled observations before returning authority.
    await port.observe({ pageTargetId, kind: 'state' });
    return {
      protocolVersion: 1,
      ownerEpoch: grant.ownerEpoch,
      fencingToken: grant.grantId,
      exclusive: true,
      pageTargetId,
      port,
      handback: ({ targetId }) => invoke('daemon.handback', { targetId }),
      async detach() {
        if (detached) return;
        detached = true;
        clearLifetime();
        try {
          await cdp.send('daemon.releaseLease', undefined, null);
        } finally {
          await cdp.close();
        }
      },
    };
  } catch (error) {
    clearLifetime();
    await cdp.close();
    throw error;
  }
}
