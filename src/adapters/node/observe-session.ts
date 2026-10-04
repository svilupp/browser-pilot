import type { Browser } from '../../browser/browser.ts';
import type { Page } from '../../browser/page.ts';
import { attachSession, resolveSession } from '../../cli/attach.ts';

/** Borrow a named local CLI session without reapplying environment or changing its owner binding. */
export interface ObserveSessionOptions {
  session: string;
  targetId: string;
}
export interface ObservedSession {
  browser: Browser;
  page: Page;
  viaDaemon: boolean;
  /** Dispose only this borrower's wrapper and transport; never stop a shared daemon/tab. */
  disconnect(): Promise<void>;
}
export async function observeSession(options: ObserveSessionOptions): Promise<ObservedSession> {
  if (!options.session || !options.targetId)
    throw new Error('observeSession requires a named session and exact target ID');
  const saved = await resolveSession(options.session);
  if (saved.provider !== 'generic')
    throw new Error('observeSession currently supports local generic browser sessions only');
  const endpoint = new URL(saved.wsUrl);
  if (
    !['ws:', 'wss:'].includes(endpoint.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
  )
    throw new Error('observeSession requires a loopback browser endpoint');
  const attached = await attachSession(
    saved,
    { policy: 'observe', targetId: options.targetId, persistBinding: false },
    false
  );
  let closed = false;
  return {
    browser: attached.browser,
    page: attached.page,
    viaDaemon: attached.viaDaemon,
    async disconnect() {
      if (closed) return;
      closed = true;
      attached.page.dispose();
      // A new borrowed daemon attachment is not pinned to the owner record.
      const sid = attached.page.cdpClient.sessionId;
      if (attached.viaDaemon && sid && sid !== saved.daemon?.cdpSessionId)
        await attached.page.cdpClient
          .send('daemon.detach', { sessionId: sid }, null)
          .catch(() => {});
      await attached.browser.disconnect();
    },
  };
}

/** Resolve a named observation connection without changing its target or attaching a page. */
export async function describeObservationSession(
  session: string
): Promise<{ endpoint: string; targetId?: string }> {
  const saved = await resolveSession(session);
  const endpoint = new URL(saved.wsUrl);
  if (
    saved.provider !== 'generic' ||
    !['ws:', 'wss:'].includes(endpoint.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('Observation requires a named local generic session');
  return { endpoint: endpoint.href, targetId: saved.targetId };
}
