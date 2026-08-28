import { createCDPClientFromTransport } from '../cdp/client.ts';
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
