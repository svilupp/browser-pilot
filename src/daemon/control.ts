import { createCDPClientFromTransport } from '../cdp/client.ts';
import { isDaemonAlive } from './lifecycle.ts';
import { createDaemonTransport } from './transport.ts';

export interface DaemonControlExpectation {
  socketPath: string;
  daemonId?: string;
  endpointFingerprint?: string;
}

/** Prove that a live control socket belongs to the expected daemon/browser. */
export async function daemonControlMatches(expected: DaemonControlExpectation): Promise<boolean> {
  let closeClient: (() => Promise<void>) | undefined;
  try {
    const transport = await createDaemonTransport(expected.socketPath);
    const cdp = createCDPClientFromTransport(transport);
    closeClient = () => cdp.close();
    const ping = await cdp.send<{
      ok?: boolean;
      daemonId?: string;
      endpointFingerprint?: string;
    }>('daemon.ping', undefined, null);
    return (
      ping.ok === true &&
      (expected.daemonId === undefined || ping.daemonId === expected.daemonId) &&
      (expected.endpointFingerprint === undefined ||
        ping.endpointFingerprint === expected.endpointFingerprint)
    );
  } catch {
    return false;
  } finally {
    await closeClient?.().catch(() => {});
  }
}

/** Replace an owner without releasing the browser allocation it will resume. */
export async function stopDaemonForRecovery(
  expected: DaemonControlExpectation & { pid: number }
): Promise<void> {
  if (!isDaemonAlive(expected.pid)) return;
  const transport = await createDaemonTransport(expected.socketPath);
  const cdp = createCDPClientFromTransport(transport);
  try {
    const ping = await cdp.send<{
      ok?: boolean;
      daemonId?: string;
      endpointFingerprint?: string;
    }>('daemon.ping', undefined, null, { timeout: 2000 });
    if (
      ping.ok !== true ||
      (expected.daemonId !== undefined && ping.daemonId !== expected.daemonId) ||
      (expected.endpointFingerprint !== undefined &&
        ping.endpointFingerprint !== expected.endpointFingerprint)
    )
      throw new Error('Daemon recovery shutdown could not prove owner identity');
    // Shutdown may close IPC before its acknowledgement reaches this client.
    await cdp
      .send('daemon.shutdown', { reason: 'recovery' }, null, { timeout: 2000 })
      .catch(() => {});
  } finally {
    await cdp.close().catch(() => {});
  }
  const deadline = Date.now() + 2000;
  while (isDaemonAlive(expected.pid) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  if (isDaemonAlive(expected.pid))
    throw new Error('Daemon recovery shutdown did not complete; allocation was retained');
}
