/**
 * Request interception implementation
 */

import type { CDPClient } from '../cdp/client.ts';
import type {
  ContinueRequestOptions,
  FailRequestOptions,
  FulfillRequestOptions,
  InterceptedRequest,
  RequestActions,
  RequestHandler,
  RequestPattern,
} from './types.ts';

interface PendingRequest {
  request: InterceptedRequest;
  handled: boolean;
}

export class RequestInterceptor {
  private cdp: CDPClient;
  private enabled = false;
  private handlers: Array<{ pattern: RequestPattern; handler: RequestHandler }> = [];
  private pendingRequests = new Map<string, PendingRequest>();
  private boundHandleRequestPaused: (params: Record<string, unknown>) => Promise<void>;
  private boundHandleAuthRequired: (params: Record<string, unknown>) => Promise<void>;

  constructor(cdp: CDPClient) {
    this.cdp = cdp;
    // Bind handlers once to allow proper removal
    this.boundHandleRequestPaused = this.handleRequestPaused.bind(this);
    this.boundHandleAuthRequired = this.handleAuthRequired.bind(this);
  }

  /**
   * Enable request interception with optional patterns
   */
  async enable(patterns?: RequestPattern[]): Promise<void> {
    if (this.enabled) return;

    // Subscribe to Fetch events
    this.cdp.on('Fetch.requestPaused', this.boundHandleRequestPaused);
    this.cdp.on('Fetch.authRequired', this.boundHandleAuthRequired);

    // Enable Fetch domain
    await this.cdp.send('Fetch.enable', {
      patterns: patterns?.map((p) => ({
        urlPattern: p.urlPattern ?? '*',
        resourceType: p.resourceType,
        requestStage: p.requestStage ?? 'Request',
      })) ?? [{ urlPattern: '*' }],
      handleAuthRequests: true,
    });

    this.enabled = true;
  }

  /**
   * Disable request interception
   */
  async disable(): Promise<void> {
    if (!this.enabled) return;

    await this.cdp.send('Fetch.disable');
    this.cdp.off('Fetch.requestPaused', this.boundHandleRequestPaused);
    this.cdp.off('Fetch.authRequired', this.boundHandleAuthRequired);

    this.enabled = false;
    this.handlers = [];
    this.pendingRequests.clear();
  }

  /**
   * Add a request handler
   */
  addHandler(pattern: RequestPattern, handler: RequestHandler): () => void {
    const entry = { pattern, handler };
    this.handlers.push(entry);

    // Return unsubscribe function
    return () => {
      const idx = this.handlers.indexOf(entry);
      if (idx !== -1) this.handlers.splice(idx, 1);
    };
  }

  /**
   * Handle paused request from CDP
   */
  private async handleRequestPaused(params: Record<string, unknown>): Promise<void> {
    const requestId = params['requestId'] as string;
    const request = params['request'] as Record<string, unknown>;
    const responseStatusCode = params['responseStatusCode'] as number | undefined;
    const responseHeaders = params['responseHeaders'] as
      | Array<{ name: string; value: string }>
      | undefined;

    const intercepted: InterceptedRequest = {
      requestId,
      url: request['url'] as string,
      method: request['method'] as string,
      headers: request['headers'] as Record<string, string>,
      postData: request['postData'] as string | undefined,
      resourceType: params['resourceType'] as InterceptedRequest['resourceType'],
      frameId: params['frameId'] as string,
      isNavigationRequest: params['isNavigationRequest'] as boolean,
      responseStatusCode,
      responseHeaders: responseHeaders
        ? Object.fromEntries(responseHeaders.map((h) => [h.name, h.value]))
        : undefined,
    };

    // Track pending request
    this.pendingRequests.set(requestId, { request: intercepted, handled: false });

    // Find matching handler
    const matchingHandler = this.handlers.find((h) => this.matchesPattern(intercepted, h.pattern));

    if (matchingHandler) {
      const actions = this.createActions(requestId);
      try {
        await matchingHandler.handler(intercepted, actions);
      } catch (err) {
        console.error('[RequestInterceptor] Handler error:', err);
        // Continue request on handler error
        if (!this.pendingRequests.get(requestId)?.handled) {
          await actions.continue();
        }
      }
    } else {
      // No handler matched, continue normally
      await this.continueRequest(requestId);
    }

    // Cleanup
    this.pendingRequests.delete(requestId);
  }

  /**
   * Handle auth challenge
   */
  private async handleAuthRequired(params: Record<string, unknown>): Promise<void> {
    const requestId = params['requestId'] as string;
    // Default: cancel auth (can be extended with auth handler support)
    await this.cdp.send('Fetch.continueWithAuth', {
      requestId,
      authChallengeResponse: { response: 'CancelAuth' },
    });
  }

  /**
   * Check if request matches pattern
   */
  private matchesPattern(request: InterceptedRequest, pattern: RequestPattern): boolean {
    if (pattern.resourceType && request.resourceType !== pattern.resourceType) {
      return false;
    }

    if (pattern.urlPattern) {
      const regex = this.globToRegex(pattern.urlPattern);
      if (!regex.test(request.url)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Convert glob pattern to regex
   */
  private globToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`);
  }

  /**
   * Create actions object for handler
   */
  private createActions(requestId: string): RequestActions {
    const pending = this.pendingRequests.get(requestId);

    const markHandled = () => {
      if (pending) pending.handled = true;
    };

    return {
      continue: async (options?: ContinueRequestOptions) => {
        markHandled();
        await this.continueRequest(requestId, options);
      },
      fulfill: async (options: FulfillRequestOptions) => {
        markHandled();
        await this.fulfillRequest(requestId, options);
      },
      fail: async (options?: FailRequestOptions) => {
        markHandled();
        await this.failRequest(requestId, options);
      },
    };
  }

  /**
   * Continue a paused request
   */
  private async continueRequest(
    requestId: string,
    options?: ContinueRequestOptions
  ): Promise<void> {
    await this.cdp.send('Fetch.continueRequest', {
      requestId,
      url: options?.url,
      method: options?.method,
      headers: options?.headers
        ? Object.entries(options.headers).map(([name, value]) => ({ name, value }))
        : undefined,
      postData: options?.postData ? btoa(options.postData) : undefined,
    });
  }

  /**
   * Fulfill a request with custom response
   */
  private async fulfillRequest(requestId: string, options: FulfillRequestOptions): Promise<void> {
    const headers = Object.entries(options.headers ?? {}).map(([name, value]) => ({
      name,
      value,
    }));

    await this.cdp.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: options.status,
      responseHeaders: headers,
      body: options.isBase64Encoded ? options.body : options.body ? btoa(options.body) : undefined,
    });
  }

  /**
   * Fail/abort a request
   */
  private async failRequest(requestId: string, options?: FailRequestOptions): Promise<void> {
    await this.cdp.send('Fetch.failRequest', {
      requestId,
      errorReason: options?.reason ?? 'BlockedByClient',
    });
  }
}
