/**
 * Shared session attach helper for CLI commands.
 * Connects to a browser session lazily — no preflight /json/version check.
 * If the WebSocket connect fails, cleans up the stale session file.
 */

import type { BatchOptions, BatchResult, Step } from '../actions/types.ts';
import type { Browser } from '../browser/browser.ts';
import type { Page } from '../browser/page.ts';
import { addBatchToPage, connect } from '../index.ts';
import { deleteSession, getDefaultSession, loadSession, type SessionData } from './session.ts';

export interface AttachResult {
  session: SessionData;
  browser: Browser;
  page: Page & { batch: (steps: Step[], options?: BatchOptions) => Promise<BatchResult> };
}

/**
 * Resolve the session to use (explicit ID or most recent).
 */
export async function resolveSession(sessionId?: string): Promise<SessionData> {
  if (sessionId) {
    return loadSession(sessionId);
  }
  const session = await getDefaultSession();
  if (!session) {
    throw new Error('No session found. Run "bp connect" first.');
  }
  return session;
}

/**
 * Attach to a browser session.
 * Skips preflight validation — connects directly via WebSocket.
 * On failure, cleans up the stale session file.
 */
export async function attachSession(
  session: SessionData,
  options: { trace?: boolean } = {}
): Promise<AttachResult> {
  let browser: Browser;
  try {
    browser = await connect({
      provider: session.provider,
      wsUrl: session.wsUrl,
      debug: options.trace,
    });
  } catch {
    // Connection failed — browser is probably gone. Clean up stale session.
    await deleteSession(session.id);
    throw new Error(
      `Session "${session.id}" is no longer valid (browser may have closed).\n` +
        'Session file has been cleaned up. Run "bp connect" to create a new session.'
    );
  }

  const page = addBatchToPage(await browser.page(undefined, { targetId: session.targetId }));

  // Hydrate ref map from session cache if URL matches
  const currentUrl = await page.url();
  const refCache = session.metadata?.refCache;
  if (refCache && refCache.url === currentUrl) {
    page.importRefMap(refCache.refMap);
  }

  return { session, browser, page };
}
