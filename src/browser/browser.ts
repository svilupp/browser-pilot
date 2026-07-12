/**
 * Browser class - manages CDP connection and pages
 */

import { type CDPClient, createCDPClient, createSessionScopedCDP } from '../cdp/index.ts';
import type { TargetInfo } from '../cdp/protocol.ts';
import {
  type ConnectOptions,
  createProvider,
  type Provider,
  type ProviderSession,
  resolveBrowserEndpoint,
} from '../providers/index.ts';
import { type BuildProvenance, getBuildProvenance } from '../runtime/provenance.ts';
import { Page } from './page.ts';
import {
  type ExpectNewPageOptions,
  TargetNotFoundError,
  type TargetProvenance,
  type TargetSummary,
} from './types.ts';

export interface BrowserOptions extends ConnectOptions {
  /** Enable debug logging */
  debug?: boolean;
}

export interface PageOptions {
  /** Specific target ID to attach to */
  targetId?: string;
  /** Filter targets to those whose URL contains this string */
  targetUrl?: string;
  /**
   * Compatibility escape hatch for callers that previously accepted a best
   * effort target when an explicit target disappeared. Defaults to false.
   */
  fallbackToBestTarget?: boolean;
  /**
   * Minimum acceptable viewport dimensions.
   * If the attached target's viewport is smaller, it will be overridden.
   * Defaults to { width: 200, height: 200 }.
   * Set to false to disable viewport validation.
   */
  minViewport?: { width: number; height: number } | false;
  /**
   * Override `window.print` with a logging no-op on every document for this page,
   * so a stray click on a "Print" control can't freeze the renderer in a native
   * print preview (which stalls every subsequent CDP call). Off by default.
   */
  blockNativePrint?: boolean;
}

function targetConstraintMatches(
  actual: string,
  expected: string | RegExp | undefined,
  mode: 'contains' | 'exact' = 'contains'
): boolean {
  if (expected === undefined) return true;
  if (expected instanceof RegExp) return expected.test(actual);
  return mode === 'exact' ? actual === expected : actual.includes(expected);
}

/**
 * Score a target for selection priority.
 * Higher score = more likely to be a real interactive tab.
 */
function scoreTarget(t: TargetInfo): number {
  let score = 0;

  // Strongly prefer http/https URLs (real pages)
  if (t.url.startsWith('http://') || t.url.startsWith('https://')) score += 10;

  // Penalize internal Chrome URLs
  if (t.url.startsWith('chrome://')) score -= 20;
  if (t.url.startsWith('chrome-extension://')) score -= 15;
  if (t.url.startsWith('devtools://')) score -= 25;

  // Slight penalty for blank pages
  if (t.url === 'about:blank') score -= 5;

  // Prefer targets not already attached by another client
  if (!t.attached) score += 3;

  // Prefer targets with a title (usually real pages)
  if (t.title && t.title.length > 0) score += 2;

  return score;
}

/**
 * Pick the best target from a list of page targets using scoring heuristics.
 * Returns undefined if the list is empty.
 */
function pickBestTarget(targets: TargetInfo[]): string | undefined {
  if (targets.length === 0) return undefined;
  const sorted = [...targets].sort((a, b) => scoreTarget(b) - scoreTarget(a));
  return sorted[0]!.targetId;
}

function summarizeTargets(targets: TargetInfo[]): TargetSummary[] {
  return targets.map((target) => ({
    targetId: target.targetId,
    url: target.url,
    ...(target.title ? { title: target.title } : {}),
  }));
}

export class Browser {
  private cdp: CDPClient;
  private providerSession: ProviderSession;
  private pages = new Map<string, Page>();
  private pageCounter = 0;
  private targetDiscoveryReady: Promise<void>;

  private constructor(
    cdp: CDPClient,
    _provider: Provider,
    providerSession: ProviderSession,
    _options: BrowserOptions
  ) {
    this.cdp = cdp;
    this.providerSession = providerSession;
    // Popup expectations rely on Target.targetCreated/targetInfoChanged. Ask
    // Chrome for those browser-level events as part of every Browser
    // initialization, including daemon-backed connections.
    this.targetDiscoveryReady = cdp
      .send('Target.setDiscoverTargets', { discover: true }, null)
      .then(() => undefined);
  }

  /**
   * Create a Browser from an existing CDPClient (used by daemon fast-path).
   * The caller is responsible for the CDP connection lifecycle.
   */
  static fromCDP(
    cdp: CDPClient,
    sessionInfo: { wsUrl: string; provider?: string; sessionId?: string }
  ): Browser {
    // Create a minimal ProviderSession that wraps the daemon connection
    const providerSession: ProviderSession = {
      wsUrl: sessionInfo.wsUrl,
      sessionId: sessionInfo.sessionId,
      async close() {
        // No-op — daemon manages the actual Chrome session
      },
    };
    // Create a no-op provider
    const provider: Provider = {
      name: sessionInfo.provider ?? 'daemon',
      async createSession() {
        return providerSession;
      },
    };
    return new Browser(cdp, provider, providerSession, { provider: 'generic' });
  }

  /**
   * Connect to a browser instance
   */
  static async connect(options: BrowserOptions): Promise<Browser> {
    let connectOptions = options;

    if (options.provider === 'generic' && !options.wsUrl) {
      const endpoint = await resolveBrowserEndpoint({
        channel: options.channel,
        userDataDir: options.userDataDir,
        allowLocalDiscovery: true,
        allowLegacyHostFallback: true,
      });
      connectOptions = {
        ...options,
        wsUrl: endpoint.wsUrl,
      };
    }

    const provider = createProvider(connectOptions);
    const session = await provider.createSession(connectOptions.session);

    if (session.metadata?.['liveUrl']) {
      console.error(`Live viewer: ${session.metadata['liveUrl']}`);
    }

    const cdp = await createCDPClient(session.wsUrl, {
      debug: connectOptions.debug,
      timeout: connectOptions.timeout,
    });

    const browser = new Browser(cdp, provider, session, connectOptions);
    await browser.targetDiscoveryReady;
    return browser;
  }

  /**
   * Get or create a page by name.
   * If no name is provided, returns the first available page or creates a new one.
   *
   * Target selection heuristics (when no targetId is specified):
   * - Prefer http/https URLs over chrome://, devtools://, about:blank
   * - Prefer unattached targets (not already controlled by another client)
   * - Filter by targetUrl if provided
   */
  async page(name?: string, options?: PageOptions): Promise<Page> {
    const pageName = name ?? 'default';

    const hasExplicitTargetId = options?.targetId !== undefined;
    const hasExplicitTargetUrl = options?.targetUrl !== undefined;
    const hasExplicitTarget = hasExplicitTargetId || hasExplicitTargetUrl;
    const explicitTargetId = options?.targetId;
    const explicitTargetUrl = options?.targetUrl;

    // Return cached page if available
    const cached = this.pages.get(pageName);
    if (cached && !hasExplicitTarget) return cached;

    // Get available targets
    const targets = await this.cdp.send<{ targetInfos: TargetInfo[] }>(
      'Target.getTargets',
      undefined,
      null
    );
    let pageTargets = targets.targetInfos.filter((t) => t.type === 'page');

    if (cached && hasExplicitTarget) {
      const cachedTarget = pageTargets.find((target) => target.targetId === cached.targetId);
      const cachedMatches =
        cachedTarget !== undefined &&
        (!hasExplicitTargetUrl || cachedTarget.url.includes(explicitTargetUrl ?? '')) &&
        (!hasExplicitTargetId || cached.targetId === explicitTargetId);
      if (cachedMatches) return cached;
      throw new TargetNotFoundError({
        targetId: options?.targetId,
        targetUrl: options?.targetUrl,
        availableTargets: summarizeTargets(pageTargets),
        reason: 'The requested constraints do not match the cached page.',
      });
    }

    // Apply URL filter if provided
    const urlFilter = explicitTargetUrl;
    if (hasExplicitTargetUrl && urlFilter !== undefined) {
      const filtered = pageTargets.filter((t) => t.url.includes(urlFilter));
      pageTargets = filtered;
    }

    let targetId: string;

    if (hasExplicitTargetId) {
      // Verify the requested target still exists
      const requestedTarget = pageTargets.find((t) => t.targetId === explicitTargetId);
      const targetWithoutUrlFilter = targets.targetInfos.find(
        (t) => t.type === 'page' && t.targetId === explicitTargetId
      );
      if (
        targetWithoutUrlFilter &&
        hasExplicitTargetUrl &&
        !targetWithoutUrlFilter.url.includes(urlFilter!)
      ) {
        throw new TargetNotFoundError({
          targetId: options?.targetId,
          targetUrl: options?.targetUrl,
          availableTargets: summarizeTargets(pageTargets),
          reason: 'The targetId exists but does not satisfy targetUrl.',
        });
      }
      if (requestedTarget || (!hasExplicitTargetUrl && targetWithoutUrlFilter)) {
        targetId = explicitTargetId!;
      } else {
        if (!options?.fallbackToBestTarget) {
          throw new TargetNotFoundError({
            targetId: options?.targetId,
            targetUrl: options?.targetUrl,
            availableTargets: summarizeTargets(pageTargets),
            reason: 'The explicit target is missing or does not match the URL filter.',
          });
        }
        const fallbackTargets =
          pageTargets.length > 0
            ? pageTargets
            : targets.targetInfos.filter((target) => target.type === 'page');
        targetId = pickBestTarget(fallbackTargets) ?? '';
      }
    } else if (hasExplicitTargetUrl && pageTargets.length === 0) {
      if (!options?.fallbackToBestTarget) {
        throw new TargetNotFoundError({
          targetUrl: options?.targetUrl,
          availableTargets: summarizeTargets(targets.targetInfos.filter((t) => t.type === 'page')),
          reason: 'No page target satisfies the URL filter.',
        });
      }
      const allPageTargets = targets.targetInfos.filter((t) => t.type === 'page');
      targetId = pickBestTarget(allPageTargets) ?? '';
    } else if (pageTargets.length > 0) {
      targetId = pickBestTarget(pageTargets)!;
    } else {
      if (hasExplicitTarget) {
        throw new TargetNotFoundError({
          targetId: options?.targetId,
          targetUrl: options?.targetUrl,
          availableTargets: [],
          reason: 'No page targets are available.',
        });
      }
      // Create a new page
      const result = await this.cdp.send<{ targetId: string }>(
        'Target.createTarget',
        {
          url: 'about:blank',
        },
        null
      );
      targetId = result.targetId;
    }

    if (!targetId) {
      throw new TargetNotFoundError({
        targetId: options?.targetId,
        targetUrl: options?.targetUrl,
        availableTargets: summarizeTargets(pageTargets),
      });
    }

    // Attach to the target and PIN the page to the returned session id. Using a
    // session-scoped view keeps this page's session-omitting send/on calls on
    // its own target even after another target is later attached (which would
    // otherwise move the client's mutable "current default session").
    const sessionId = await this.cdp.attachToTarget(targetId);

    // Create and initialize page
    const page = new Page(createSessionScopedCDP(this.cdp, sessionId), targetId, {
      blockNativePrint: options?.blockNativePrint === true,
      targetProvenance: { targetId, source: 'selected' },
    });
    await page.init();

    // Validate viewport dimensions (detect pathological targets like 921x56)
    const minViewport =
      options?.minViewport !== undefined ? options.minViewport : { width: 200, height: 200 };

    if (minViewport !== false) {
      try {
        const viewport = await page.evaluate<{ w: number; h: number }>(
          '({ w: window.innerWidth, h: window.innerHeight })'
        );
        if (viewport.w < minViewport.width || viewport.h < minViewport.height) {
          console.warn(
            `[browser-pilot] Attached target has small viewport (${viewport.w}x${viewport.h}). ` +
              `Applying default viewport override (1280x720). ` +
              `Use { minViewport: false } to disable this check.`
          );
          await page.setViewport({ width: 1280, height: 720 });
        }
      } catch {
        // Viewport check is best-effort; don't fail the connection
      }
    }

    this.pages.set(pageName, page);
    return page;
  }

  /**
   * Create a new page (tab)
   */
  async newPage(url = 'about:blank'): Promise<Page> {
    const result = await this.cdp.send<{ targetId: string }>(
      'Target.createTarget',
      {
        url,
      },
      null
    );

    // Pin the page to its own session (see page() for rationale).
    const sessionId = await this.cdp.attachToTarget(result.targetId);

    const page = new Page(createSessionScopedCDP(this.cdp, sessionId), result.targetId, {
      targetProvenance: { targetId: result.targetId, source: 'new_page', url },
    });
    await page.init();

    // Generate unique name for the page
    const name = `page-${++this.pageCounter}`;
    this.pages.set(name, page);

    return page;
  }

  /**
   * Arm target lifecycle listeners before running a trigger that is expected
   * to open a new page. The opener Page is never retargeted; the returned Page
   * owns a separate pinned CDP session and is retained by this Browser.
   */
  async expectNewPage<T>(
    trigger: () => Promise<T> | T,
    options: ExpectNewPageOptions = {}
  ): Promise<Page> {
    await (this.targetDiscoveryReady ?? Promise.resolve());
    const armedAt = Date.now();
    const timeout = options.timeout ?? 15000;
    const expectedTypes = options.type
      ? new Set(Array.isArray(options.type) ? options.type : [options.type])
      : new Set(['page']);
    const candidates = new Map<string, { info: TargetInfo; createdAt: number }>();
    let settled = false;
    let attaching = false;
    let attachingTargetId: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let targetPoll: ReturnType<typeof setInterval> | undefined;
    let refreshingTargets = false;
    let resolveResult!: (page: Page) => void;
    let rejectResult!: (error: Error) => void;

    const result = new Promise<Page>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const availableTargets = (): TargetSummary[] =>
      [...candidates.values()].map(({ info }) => ({
        targetId: info.targetId,
        url: info.url,
        ...(info.title ? { title: info.title } : {}),
      }));

    const matches = (candidate: { info: TargetInfo; createdAt: number }): boolean => {
      const { info, createdAt } = candidate;
      if (createdAt < armedAt || !expectedTypes.has(info.type)) return false;
      if (options.openerTargetId !== undefined && info.openerId !== options.openerTargetId) {
        return false;
      }

      // Chrome commonly creates a popup at about:blank and changes its URL
      // later. Keep that candidate pending instead of accepting an unrelated
      // tab or rejecting the legitimate popup too early.
      const waitingForUrl = options.url !== undefined && info.url === 'about:blank';
      const urlMatches = targetConstraintMatches(info.url, options.url);
      if (!waitingForUrl && !urlMatches) return false;

      const waitingForTitle = options.title !== undefined && info.title === '';
      const titleMatches = targetConstraintMatches(info.title, options.title, 'exact');
      if (!waitingForTitle && !titleMatches) return false;

      return !waitingForUrl && !waitingForTitle;
    };

    const fail = (reason: string): void => {
      if (settled) return;
      settled = true;
      rejectResult(
        new TargetNotFoundError({
          targetUrl: typeof options.url === 'string' ? options.url : undefined,
          availableTargets: availableTargets(),
          reason,
        })
      );
    };

    const cleanup = (): void => {
      this.cdp.off('Target.targetCreated', onCreated);
      this.cdp.off('Target.targetInfoChanged', onChanged);
      this.cdp.off('Target.targetDestroyed', onDestroyed);
      if (timer) clearTimeout(timer);
      if (targetPoll) clearInterval(targetPoll);
    };

    // Chrome does not consistently emit a second Target.targetInfoChanged event when a page
    // updates document.title after navigation. Refresh pending candidates from the authoritative
    // target listing so a provisional URL-as-title value cannot make a valid title filter time out.
    const refreshTargets = async (): Promise<void> => {
      if (settled || refreshingTargets) return;
      refreshingTargets = true;
      try {
        const { targetInfos } = await this.cdp.send<{ targetInfos: TargetInfo[] }>(
          'Target.getTargets',
          undefined,
          null
        );
        for (const info of targetInfos) {
          const prior = candidates.get(info.targetId);
          if (!prior) continue;
          const candidate = { info, createdAt: prior.createdAt };
          candidates.set(info.targetId, candidate);
          attachCandidate(candidate);
        }
      } catch {
        // Target discovery remains event-driven if a best-effort refresh races connection close.
      } finally {
        refreshingTargets = false;
      }
    };

    const attachCandidate = (candidate: { info: TargetInfo; createdAt: number }): void => {
      if (settled || attaching || !matches(candidate)) return;
      attaching = true;
      attachingTargetId = candidate.info.targetId;
      const targetId = candidate.info.targetId;
      void (async () => {
        try {
          const sessionId = await this.cdp.attachToTarget(targetId);
          const provenance: TargetProvenance = {
            targetId,
            source: 'popup',
            type: candidate.info.type,
            openerTargetId: options.openerTargetId ?? candidate.info.openerId,
            createdAt: new Date(candidate.createdAt).toISOString(),
            url: candidate.info.url,
            title: candidate.info.title,
          };
          const page = new Page(createSessionScopedCDP(this.cdp, sessionId), targetId, {
            targetProvenance: provenance,
          });
          await page.init();
          attaching = false;
          attachingTargetId = undefined;
          if (settled) {
            page.dispose();
            return;
          }
          const matchingTargets = [...candidates.values()].filter(matches);
          if (matchingTargets.length > 1) {
            page.dispose();
            fail(
              `New-page expectation is ambiguous: ${matchingTargets.length} newly created targets match the supplied constraints.`
            );
            return;
          }
          settled = true;
          this.pages.set(`popup-${++this.pageCounter}`, page);
          resolveResult(page);
        } catch (error) {
          attaching = false;
          attachingTargetId = undefined;
          if (!settled) {
            settled = true;
            rejectResult(
              new TargetNotFoundError({
                targetId,
                targetUrl: typeof options.url === 'string' ? options.url : undefined,
                availableTargets: availableTargets(),
                reason: `The matching target disappeared before it could be attached: ${error instanceof Error ? error.message : String(error)}`,
              })
            );
          }
        }
      })();
    };

    const onCreated = (params: Record<string, unknown>): void => {
      const info = params['targetInfo'] as TargetInfo | undefined;
      if (!info || typeof info.targetId !== 'string') return;
      const candidate = { info, createdAt: Date.now() };
      candidates.set(info.targetId, candidate);
      attachCandidate(candidate);
    };
    const onChanged = (params: Record<string, unknown>): void => {
      const info = params['targetInfo'] as TargetInfo | undefined;
      if (!info || typeof info.targetId !== 'string') return;
      const prior = candidates.get(info.targetId);
      if (!prior) return;
      const candidate = { info, createdAt: prior.createdAt };
      candidates.set(info.targetId, candidate);
      attachCandidate(candidate);
    };
    const onDestroyed = (params: Record<string, unknown>): void => {
      const targetId = params['targetId'];
      if (typeof targetId !== 'string' || !candidates.has(targetId)) return;
      candidates.delete(targetId);
      if (attaching && !settled && targetId === attachingTargetId)
        fail(`Candidate target ${targetId} was destroyed before attachment.`);
    };

    // These listeners are intentionally registered before trigger() is called.
    this.cdp.on('Target.targetCreated', onCreated);
    this.cdp.on('Target.targetInfoChanged', onChanged);
    this.cdp.on('Target.targetDestroyed', onDestroyed);
    timer = setTimeout(() => fail('Timed out waiting for a matching new page.'), timeout);
    targetPoll = setInterval(() => void refreshTargets(), 25);

    try {
      await trigger();
      const page = await result;
      cleanup();
      return page;
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  /**
   * Close a page by name
   */
  async closePage(name: string): Promise<void> {
    const page = this.pages.get(name);
    if (!page) return;

    const targetId = page.targetId;
    // Release the page's connection-global listeners before dropping it, so a
    // closed Page stops reacting to target attach/detach events on the shared
    // connection (listener leak on long-lived connections with tab churn).
    page.dispose();
    await this.cdp.send('Target.closeTarget', { targetId }, null);
    this.pages.delete(name);

    // Wait for the browser to actually destroy the target
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const { targetInfos } = await this.cdp.send<{ targetInfos: TargetInfo[] }>(
        'Target.getTargets',
        undefined,
        null
      );
      if (!targetInfos.some((t) => t.targetId === targetId)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * List all page targets in the connected browser.
   */
  async listTargets(): Promise<TargetInfo[]> {
    const { targetInfos } = await this.cdp.send<{ targetInfos: TargetInfo[] }>(
      'Target.getTargets',
      undefined,
      null
    );
    return targetInfos.filter((target) => target.type === 'page');
  }

  /**
   * Get the WebSocket URL for this browser connection
   */
  get wsUrl(): string {
    return this.providerSession.wsUrl;
  }

  /**
   * Get the provider session ID (for resumption)
   */
  get sessionId(): string | undefined {
    return this.providerSession.sessionId;
  }

  /**
   * Get provider metadata
   */
  get metadata(): Record<string, unknown> | undefined {
    return this.providerSession.metadata;
  }

  /** Package/source/build identity for diagnostics and evidence. */
  get provenance(): BuildProvenance {
    return getBuildProvenance();
  }

  /**
   * Check if connected
   */
  get isConnected(): boolean {
    return this.cdp.isConnected;
  }

  /**
   * Disconnect from the browser (keeps provider session alive for reconnection)
   */
  async disconnect(): Promise<void> {
    for (const page of this.pages.values()) page.dispose();
    this.pages.clear();
    await this.cdp.close();
  }

  /**
   * Close the browser session completely
   */
  async close(): Promise<void> {
    for (const page of this.pages.values()) page.dispose();
    this.pages.clear();
    await this.cdp.close();
    await this.providerSession.close();
  }

  /**
   * Get the underlying CDP client (for advanced usage)
   */
  get cdpClient(): CDPClient {
    return this.cdp;
  }
}

/**
 * Connect to a browser instance
 * Convenience function for Browser.connect()
 */
export function connect(options: BrowserOptions): Promise<Browser> {
  return Browser.connect(options);
}
