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
   * Get or create a page by name
   * If no name is provided, returns the first available page or creates a new one
   */
  async page(name?: string): Promise<Page> {
    const pageName = name ?? 'default';

    // Return cached page if available
    const cached = this.pages.get(pageName);
    if (cached) return cached;

    // Get available targets
    const targets = await this.cdp.send<{ targetInfos: TargetInfo[] }>('Target.getTargets');
    const pageTargets = targets.targetInfos.filter((t) => t.type === 'page');

    let targetId: string;

    if (pageTargets.length > 0) {
      // Use the first available page
      targetId = pageTargets[0]!.targetId;
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
    const page = new Page(this.cdp);
    await page.init();

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

    const page = new Page(this.cdp);
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
