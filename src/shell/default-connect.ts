/**
 * Default browser connection for the shell bridge.
 *
 * Connects to an already-resolved WebSocket URL with the generic provider —
 * the trusted host's SessionOwner has already exchanged the opaque handle for
 * the wsUrl, so no provider credentials are needed here. The returned wrapper
 * only exposes `disconnect()` (never `close()`), so a shell command can never
 * release the provider session.
 */

import { Browser } from '../browser/browser.ts';
import type { Page } from '../browser/page.ts';
import { webmcpCall, webmcpList } from '../webmcp/client.ts';
import type { ExecutionContext } from './ports.ts';
import type { BpBrowser, BpPage, BpPageOptions } from './types.ts';

function wrapPage(page: Page): BpPage {
  return {
    get targetId() {
      return page.targetId;
    },
    goto: (url, options) => page.goto(url, options),
    url: () => page.url(),
    title: () => page.title(),
    text: (selector) => page.text(selector),
    snapshot: () => page.snapshot(),
    screenshot: (options) => page.screenshot(options),
    evaluate: (expression) => page.evaluate(expression),
    click: (selector, options) => page.click(selector, options),
    type: (selector, text, options) => page.type(selector, text, options),
    press: (key, options) => page.press(key, options),
    getLastActionReceipt: () => page.getLastActionReceipt(),
    resetLastActionReceipt: () => page.resetLastActionReceipt(),
    webmcpList: (fromOrigins) => webmcpList(page, fromOrigins),
    webmcpCall: async (name, input, options) =>
      (await webmcpCall(page, name, input, options)).result,
  };
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason ?? 'Aborted'));
}

function remainingTimeout(ctx: ExecutionContext): number | undefined {
  if (ctx.deadline === undefined) return undefined;
  return Math.max(1, ctx.deadline - ctx.clock.now());
}

function assertConnectAdmission(ctx: ExecutionContext): void {
  if (ctx.signal.aborted) throw abortError(ctx.signal);
  if (ctx.deadline !== undefined && ctx.clock.now() >= ctx.deadline) {
    throw new Error('Execution deadline exceeded before browser connect.');
  }
}

/**
 * Browser.connect() predates the shell context and has no AbortSignal input.
 * Race it against the host signal, and release a connection that finishes
 * after cancellation so an in-flight connect cannot leave a socket behind.
 */
async function connectWithContext(
  options: { provider: 'generic'; wsUrl: string; timeout?: number },
  ctx: ExecutionContext
): Promise<Browser> {
  assertConnectAdmission(ctx);

  const pending = Browser.connect(options);
  return new Promise<Browser>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      ctx.signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError(ctx.signal));
      // `pending` may still resolve after the race has rejected. Its handler
      // below disconnects that late browser to keep ownership deterministic.
    };

    ctx.signal.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal.aborted) {
      onAbort();
    }

    void pending.then(
      (browser) => {
        if (settled) {
          void browser.disconnect().catch(() => {});
          return;
        }
        settled = true;
        cleanup();
        if (ctx.signal.aborted) {
          void browser.disconnect().catch(() => {});
          reject(abortError(ctx.signal));
          return;
        }
        resolve(browser);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

export async function defaultConnect(wsUrl: string, ctx: ExecutionContext): Promise<BpBrowser> {
  assertConnectAdmission(ctx);
  const timeout = remainingTimeout(ctx);
  const browser = await connectWithContext(
    {
      provider: 'generic',
      wsUrl,
      ...(timeout !== undefined ? { timeout } : {}),
    },
    ctx
  );
  try {
    assertConnectAdmission(ctx);
  } catch (error) {
    await browser.disconnect().catch(() => {});
    throw error;
  }
  return {
    page: async (options?: BpPageOptions) => wrapPage(await browser.page(undefined, options)),
    listTargets: async () =>
      (await browser.listTargets())
        .filter((t) => t.type === 'page')
        .map((t) => ({ targetId: t.targetId, type: t.type, url: t.url, title: t.title })),
    disconnect: () => browser.disconnect(),
  };
}
