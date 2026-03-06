/**
 * Browser class - manages CDP connection and pages
 */

import { type CDPClient, createCDPClient } from '../cdp/index.ts';
import type { TargetInfo } from '../cdp/protocol.ts';
import {
  type ConnectOptions,
  createProvider,
  type Provider,
  type ProviderSession,
} from '../providers/index.ts';
import { Page } from './page.ts';

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
   * Minimum acceptable viewport dimensions.
   * If the attached target's viewport is smaller, it will be overridden.
   * Defaults to { width: 200, height: 200 }.
   * Set to false to disable viewport validation.
   */
  minViewport?: { width: number; height: number } | false;
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

export class Browser {
  private cdp: CDPClient;
  private providerSession: ProviderSession;
  private pages = new Map<string, Page>();

  private constructor(
    cdp: CDPClient,
    _provider: Provider,
    providerSession: ProviderSession,
    _options: BrowserOptions
  ) {
    this.cdp = cdp;
    this.providerSession = providerSession;
  }

  /**
   * Connect to a browser instance
   */
  static async connect(options: BrowserOptions): Promise<Browser> {
    const provider = createProvider(options);
    const session = await provider.createSession(options.session);

    const cdp = await createCDPClient(session.wsUrl, {
      debug: options.debug,
      timeout: options.timeout,
    });

    return new Browser(cdp, provider, session, options);
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

    // Return cached page if available
    const cached = this.pages.get(pageName);
    if (cached) return cached;

    // Get available targets
    const targets = await this.cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
    let pageTargets = targets.targetInfos.filter((t) => t.type === 'page');

    // Apply URL filter if provided
    if (options?.targetUrl) {
      const urlFilter = options.targetUrl;
      const filtered = pageTargets.filter((t) => t.url.includes(urlFilter));
      if (filtered.length > 0) {
        pageTargets = filtered;
      } else {
        console.warn(
          `[browser-pilot] No targets match URL filter "${urlFilter}", falling back to all page targets`
        );
      }
    }

    let targetId: string;

    if (options?.targetId) {
      // Verify the requested target still exists
      const targetExists = targets.targetInfos.some(
        (t) => t.type === 'page' && t.targetId === options.targetId
      );
      if (targetExists) {
        targetId = options.targetId;
      } else {
        console.warn(`[browser-pilot] Target ${options.targetId} no longer exists, falling back`);
        targetId =
          pickBestTarget(pageTargets) ??
          (
            await this.cdp.send<{ targetId: string }>('Target.createTarget', {
              url: 'about:blank',
            })
          ).targetId;
      }
    } else if (pageTargets.length > 0) {
      targetId = pickBestTarget(pageTargets)!;
    } else {
      // Create a new page
      const result = await this.cdp.send<{ targetId: string }>('Target.createTarget', {
        url: 'about:blank',
      });
      targetId = result.targetId;
    }

    // Attach to the target
    await this.cdp.attachToTarget(targetId);

    // Create and initialize page
    const page = new Page(this.cdp, targetId);
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
    const result = await this.cdp.send<{ targetId: string }>('Target.createTarget', {
      url,
    });

    await this.cdp.attachToTarget(result.targetId);

    const page = new Page(this.cdp, result.targetId);
    await page.init();

    // Generate unique name for the page
    const name = `page-${this.pages.size + 1}`;
    this.pages.set(name, page);

    return page;
  }

  /**
   * Close a page by name
   */
  async closePage(name: string): Promise<void> {
    const page = this.pages.get(name);
    if (!page) return;

    // Get the target ID for this page
    const targets = await this.cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
    const pageTargets = targets.targetInfos.filter((t) => t.type === 'page');

    if (pageTargets.length > 0) {
      await this.cdp.send('Target.closeTarget', {
        targetId: pageTargets[0]!.targetId,
      });
    }

    this.pages.delete(name);
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
    this.pages.clear();
    await this.cdp.close();
  }

  /**
   * Close the browser session completely
   */
  async close(): Promise<void> {
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
