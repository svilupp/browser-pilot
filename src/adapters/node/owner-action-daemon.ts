import type { CDPClient } from '../../cdp/client.ts';
import { createOwnerActionService } from '../../core/owner-actions/executor.ts';
import type { OwnerActionPolicy } from '../../core/owner-actions/types.ts';
import { endpointFingerprint } from '../../daemon/registry.ts';
import { type DaemonIdentity, type DaemonServer, startDaemonServer } from '../../daemon/server.ts';

export interface OwnerActionDaemonOptions {
  socketPath: string;
  /** Private browser-owner connection. Never expose this client to borrowed controllers. */
  cdp: CDPClient;
  /** Installed by the trusted local host, never accepted through daemon RPC. */
  policy: OwnerActionPolicy;
  daemonId?: string;
  /** Trusted endpoint of the already-connected private CDP client. Never sent to borrowers. */
  wsUrl?: string;
  endpointFingerprint?: string;
  onActivity?: () => void;
  onShutdown?: (reason?: 'recovery') => void;
  handback?: DaemonIdentity['handback'];
  resolveBinding?: DaemonIdentity['resolveBinding'];
}
/** Start the ordinary fenced daemon with a strict typed action boundary installed. */
export async function startOwnerActionDaemon(
  options: OwnerActionDaemonOptions
): Promise<DaemonServer> {
  const fingerprint = options.wsUrl
    ? endpointFingerprint(options.wsUrl)
    : options.endpointFingerprint;
  if (options.wsUrl && options.endpointFingerprint && options.endpointFingerprint !== fingerprint)
    throw new Error('Owner endpoint identity conflicts with the supplied fingerprint');
  return startDaemonServer(
    options.socketPath,
    options.cdp,
    options.onActivity ?? (() => {}),
    options.onShutdown,
    {
      requireLease: true,
      daemonId: options.daemonId,
      endpointFingerprint: fingerprint,
      ownerActions: createOwnerActionService({ policy: options.policy }),
      handback: options.handback,
      resolveBinding: options.resolveBinding,
    }
  );
}
