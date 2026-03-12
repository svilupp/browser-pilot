/**
 * Recorder class for capturing browser interactions via CDP
 *
 * The Recorder connects to a browser via CDP, injects a recording script,
 * and captures user interactions. Events are aggregated into Step[] for
 * replay via page.batch().
 */

import type { CDPClient } from '../cdp/client.ts';
import { createTraceId, normalizeTraceEvent, type CanonicalTraceEvent } from '../trace/model.ts';
import { TRACE_BINDING_NAME, TRACE_SCRIPT } from '../trace/script.ts';
import { aggregateEvents } from './aggregator.ts';
import { RECORDER_BINDING_NAME, RECORDER_SCRIPT } from './script.ts';
import type {
  FullRecordingOutput,
  RawRecordedEvent,
  RecordedNetworkRequest,
  RecordedNetworkResponse,
  RecordedWebSocketEvent,
  RecordedWebSocketFrame,
  TimelineEntry,
} from './types.ts';

/** Listen mode: which traffic to capture. */
export type ListenMode = 'ws' | 'http' | 'all';

/** Options for network traffic capture during recording. */
export interface RecorderListenOptions {
  mode?: ListenMode;
  match?: string;
  captureResponseBodies?: boolean;
  maxPayload?: number;
}

/** Options for creating a Recorder. */
export interface RecorderOptions {
  /** Enable network traffic capture alongside DOM recording. */
  listen?: boolean | RecorderListenOptions;
  /** Called after each captured event. Use for live screenshot capture. */
  onEvent?: (event: RawRecordedEvent) => void | Promise<void>;
}

/**
 * Recorder captures browser interactions and outputs them as Steps.
 *
 * @example
 * ```typescript
 * const recorder = new Recorder(cdpClient);
 * await recorder.start();
 * // User interacts with the page...
 * const output = await recorder.stop();
 * console.log(output.steps); // Steps for replay
 * ```
 */
export class Recorder {
  private cdp: CDPClient;
  private options: RecorderOptions;
  private events: RawRecordedEvent[] = [];
  private recording = false;
  private startTime = 0;
  private startUrl = '';
  private bindingHandler: ((params: Record<string, unknown>) => void) | null = null;

  // Network capture state
  private listenOpts: RecorderListenOptions | null = null;
  private networkRequests: RecordedNetworkRequest[] = [];
  private networkResponses: RecordedNetworkResponse[] = [];
  private wsEvents: RecordedWebSocketEvent[] = [];
  private wsFrames: RecordedWebSocketFrame[] = [];
  private networkHandlers: Array<{
    event: string;
    handler: (params: Record<string, unknown>) => void;
  }> = [];
  private matchRegex: RegExp | null = null;
  private pendingBodies: Promise<void>[] = [];
  private wsUrls = new Map<string, string>();
  private httpUrls = new Map<string, string>();
  private traceEvents: CanonicalTraceEvent[] = [];
  private traceHandlers: Array<{
    event: string;
    handler: (params: Record<string, unknown>) => void;
  }> = [];

  constructor(cdp: CDPClient, options?: RecorderOptions) {
    this.cdp = cdp;
    this.options = options ?? {};
  }

  /**
   * Check if recording is currently active.
   */
  get isRecording(): boolean {
    return this.recording;
  }

  /**
   * Start recording browser interactions.
   *
   * Sets up CDP bindings and injects the recorder script into
   * the current page and all future navigations.
   */
  async start(): Promise<void> {
    if (this.recording) {
      throw new Error('Recording already in progress');
    }

    this.events = [];
    this.traceEvents = [];
    this.startTime = Date.now();
    this.recording = true;

    // Enable required CDP domains
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Page.enable');

    // Get current URL for start state
    try {
      const result = await this.cdp.send<{ result: { value: string } }>('Runtime.evaluate', {
        expression: 'location.href',
        returnByValue: true,
      });
      this.startUrl = result.result.value;
    } catch {
      this.startUrl = '';
    }

    // Add binding for recorder callback
    await this.cdp.send('Runtime.addBinding', { name: RECORDER_BINDING_NAME });
    await this.cdp.send('Runtime.addBinding', { name: TRACE_BINDING_NAME });

    // Auto-inject script on navigation
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: RECORDER_SCRIPT,
    });
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: TRACE_SCRIPT,
    });

    // Inject script into current document
    await this.cdp.send('Runtime.evaluate', {
      expression: RECORDER_SCRIPT,
      awaitPromise: false,
    });
    await this.cdp.send('Runtime.evaluate', {
      expression: TRACE_SCRIPT,
      awaitPromise: false,
    });

    // Listen for binding calls
    this.bindingHandler = (params: Record<string, unknown>) => {
      if (params['name'] === RECORDER_BINDING_NAME) {
        this.handleBindingCall(params['payload'] as string);
      } else if (params['name'] === TRACE_BINDING_NAME) {
        this.handleTraceBindingCall(params['payload'] as string);
      }
    };
    this.cdp.on('Runtime.bindingCalled', this.bindingHandler);

    this.subscribeTrace('Runtime.consoleAPICalled', (params) => {
      const type = String(params['type'] ?? 'log');
      if (type !== 'log' && type !== 'warn' && type !== 'error') {
        return;
      }

      const args = Array.isArray(params['args'])
        ? (params['args'] as Array<Record<string, unknown>>)
        : [];
      const text = args
        .map((entry) => String(entry['value'] ?? entry['description'] ?? ''))
        .filter(Boolean)
        .join(' ');

      this.traceEvents.push(
        normalizeTraceEvent({
          traceId: createTraceId('console'),
          sessionId: '',
          ts: new Date().toISOString(),
          elapsedMs: this.elapsed(),
          channel: 'console',
          event: `console.${type}`,
          severity: type === 'error' ? 'error' : type === 'warn' ? 'warn' : 'info',
          summary: text || `console.${type}`,
          data: { args },
          url: this.startUrl,
        })
      );
    });

    this.subscribeTrace('Runtime.exceptionThrown', (params) => {
      const details = (params['exceptionDetails'] ?? {}) as Record<string, unknown>;
      this.traceEvents.push(
        normalizeTraceEvent({
          traceId: createTraceId('runtime'),
          ts: new Date().toISOString(),
          elapsedMs: this.elapsed(),
          channel: 'runtime',
          event: 'runtime.exception',
          severity: 'error',
          summary: String(details['text'] ?? 'Runtime exception'),
          data: details,
          url: this.startUrl,
        })
      );
    });

    // Set up network capture if listen option is enabled
    if (this.options.listen) {
      const listenOpts: RecorderListenOptions =
        typeof this.options.listen === 'boolean' ? { mode: 'all' } : this.options.listen;
      this.listenOpts = listenOpts;
      this.matchRegex = listenOpts.match ? globToRegex(listenOpts.match) : null;

      await this.cdp.send('Network.enable');
      this.setupNetworkListeners(listenOpts);
    }
  }

  /**
   * Stop recording and return aggregated output.
   *
   * Returns a RecordingOutput with steps compatible with page.batch().
   */
  async stop(): Promise<FullRecordingOutput> {
    if (!this.recording) {
      throw new Error('No recording in progress');
    }

    this.recording = false;
    const duration = Date.now() - this.startTime;

    // Remove event handler
    if (this.bindingHandler) {
      this.cdp.off('Runtime.bindingCalled', this.bindingHandler);
      this.bindingHandler = null;
    }

    // Remove network handlers
    for (const { event, handler } of this.networkHandlers) {
      this.cdp.off(event, handler);
    }
    this.networkHandlers = [];
    for (const { event, handler } of this.traceHandlers) {
      this.cdp.off(event, handler);
    }
    this.traceHandlers = [];

    // Disable network domain if listen was active
    if (this.listenOpts) {
      await this.cdp.send('Network.disable');
    }

    // Wait for any in-flight response body fetches to complete
    await Promise.allSettled(this.pendingBodies);
    this.pendingBodies = [];

    // Aggregate events into steps (pass startUrl for navigation detection)
    const steps = aggregateEvents(this.events, this.startUrl);

    const result: FullRecordingOutput = {
      recordedAt: new Date(this.startTime).toISOString(),
      startUrl: this.startUrl,
      duration,
      steps,
      traceEvents: this.traceEvents,
    };

    // Add network data if listen was enabled
    if (this.listenOpts) {
      const mode = this.listenOpts.mode ?? 'all';

      if (mode === 'http' || mode === 'all') {
        result.network = {
          requests: this.networkRequests,
          responses: this.networkResponses,
        };
      }

      if (mode === 'ws' || mode === 'all') {
        result.websockets = {
          events: this.wsEvents,
          frames: this.wsFrames,
        };
      }

      // Build merged timeline
      result.timeline = this.buildTimeline();
    }

    return result;
  }

  /**
   * Get raw recorded events (for debugging).
   */
  getEvents(): RawRecordedEvent[] {
    return [...this.events];
  }

  /**
   * Handle incoming binding call from the browser.
   */
  private handleBindingCall(payload: string): void {
    if (!this.recording) return;

    try {
      const event = JSON.parse(payload) as RawRecordedEvent;
      this.events.push(event);
      if (this.options.onEvent) {
        // Fire-and-forget — don't block recording on screenshot I/O
        Promise.resolve(this.options.onEvent(event)).catch(() => {});
      }
    } catch {
      // Invalid payload, ignore
    }
  }

  private handleTraceBindingCall(payload: string): void {
    if (!this.recording) return;

    try {
      const data = JSON.parse(payload) as {
        event: string;
        severity?: 'info' | 'warn' | 'error';
        summary?: string;
        ts?: number;
        data?: Record<string, unknown>;
      };

      this.traceEvents.push(
        normalizeTraceEvent({
          traceId: createTraceId('trace'),
          ts: data.ts ? new Date(data.ts).toISOString() : new Date().toISOString(),
          elapsedMs: this.elapsed(),
          channel: this.channelForTraceEvent(data.event),
          event: data.event,
          severity: data.severity,
          summary: data.summary ?? data.event,
          data: data.data ?? {},
          url:
            typeof data.data?.['url'] === 'string' ? (data.data['url'] as string) : this.startUrl,
        })
      );
    } catch {
      // Ignore malformed trace payloads
    }
  }

  /** Subscribe to a CDP event, tracking for cleanup. */
  private subscribeNetwork(
    event: string,
    handler: (params: Record<string, unknown>) => void
  ): void {
    this.cdp.on(event, handler);
    this.networkHandlers.push({ event, handler });
  }

  private subscribeTrace(
    event: string,
    handler: (params: Record<string, unknown>) => void
  ): void {
    this.cdp.on(event, handler);
    this.traceHandlers.push({ event, handler });
  }

  /** Check if a URL matches the configured filter. */
  private matchesUrl(url: string): boolean {
    if (!this.matchRegex) return true;
    return this.matchRegex.test(url);
  }

  /** Elapsed milliseconds since recording started. */
  private elapsed(): number {
    return Date.now() - this.startTime;
  }

  /** Format a WebSocket payload, truncating or replacing binary data. */
  private formatPayload(
    payloadData: string | undefined,
    opcode: number
  ): { payload: string; length: number } {
    const data = payloadData ?? '';
    const maxPayload = this.listenOpts?.maxPayload ?? 256;

    if (opcode === 2) {
      const byteLength = Math.floor((data.length * 3) / 4);
      return { payload: `[binary: ${byteLength} bytes]`, length: data.length };
    }

    const length = data.length;
    if (length > maxPayload) {
      return {
        payload: `${data.slice(0, maxPayload)}... [truncated, ${length} total]`,
        length,
      };
    }

    return { payload: data, length };
  }

  /** Set up CDP event listeners for network traffic capture. */
  private setupNetworkListeners(opts: RecorderListenOptions): void {
    const mode = opts.mode ?? 'all';

    if (mode === 'ws' || mode === 'all') {
      this.subscribeNetwork('Network.webSocketCreated', (params) => {
        const url = params['url'] as string;
        const requestId = params['requestId'] as string;
        if (!this.matchesUrl(url)) return;

        this.wsUrls.set(requestId, url);
        const now = Date.now();
        this.wsEvents.push({
          requestId,
          timestamp: now,
          elapsedMs: this.elapsed(),
          type: 'created',
          url,
        });
        this.traceEvents.push(
          normalizeTraceEvent({
            traceId: createTraceId('ws'),
            ts: new Date(now).toISOString(),
            elapsedMs: this.elapsed(),
            channel: 'ws',
            event: 'ws.connection.created',
            summary: `WebSocket opened ${url}`,
            data: { url },
            connectionId: requestId,
            requestId,
            url,
          })
        );
      });

      this.subscribeNetwork('Network.webSocketFrameSent', (params) => {
        const requestId = params['requestId'] as string;
        if (!this.wsUrls.has(requestId)) return;

        const response = params['response'] as { opcode: number; payloadData?: string } | undefined;
        const opcode = response?.opcode ?? 1;
        const { payload, length } = this.formatPayload(response?.payloadData, opcode);
        const now = Date.now();

        this.wsFrames.push({
          requestId,
          timestamp: now,
          elapsedMs: this.elapsed(),
          direction: 'sent',
          opcode,
          payload,
          length,
        });
        this.traceEvents.push(
          normalizeTraceEvent({
            traceId: createTraceId('ws'),
            ts: new Date(now).toISOString(),
            elapsedMs: this.elapsed(),
            channel: 'ws',
            event: 'ws.frame.sent',
            summary: `WebSocket frame sent ${requestId}`,
            data: { opcode, payload, length },
            connectionId: requestId,
            requestId,
            url: this.wsUrls.get(requestId),
          })
        );
      });

      this.subscribeNetwork('Network.webSocketFrameReceived', (params) => {
        const requestId = params['requestId'] as string;
        if (!this.wsUrls.has(requestId)) return;

        const response = params['response'] as { opcode: number; payloadData?: string } | undefined;
        const opcode = response?.opcode ?? 1;
        const { payload, length } = this.formatPayload(response?.payloadData, opcode);
        const now = Date.now();

        this.wsFrames.push({
          requestId,
          timestamp: now,
          elapsedMs: this.elapsed(),
          direction: 'received',
          opcode,
          payload,
          length,
        });
        this.traceEvents.push(
          normalizeTraceEvent({
            traceId: createTraceId('ws'),
            ts: new Date(now).toISOString(),
            elapsedMs: this.elapsed(),
            channel: 'ws',
            event: 'ws.frame.received',
            summary: `WebSocket frame received ${requestId}`,
            data: { opcode, payload, length },
            connectionId: requestId,
            requestId,
            url: this.wsUrls.get(requestId),
          })
        );
      });

      this.subscribeNetwork('Network.webSocketClosed', (params) => {
        const requestId = params['requestId'] as string;
        if (!this.wsUrls.has(requestId)) return;

        this.wsUrls.delete(requestId);
        const now = Date.now();
        this.wsEvents.push({
          requestId,
          timestamp: now,
          elapsedMs: this.elapsed(),
          type: 'closed',
        });
        this.traceEvents.push(
          normalizeTraceEvent({
            traceId: createTraceId('ws'),
            ts: new Date(now).toISOString(),
            elapsedMs: this.elapsed(),
            channel: 'ws',
            event: 'ws.connection.closed',
            severity: 'warn',
            summary: `WebSocket closed ${requestId}`,
            data: { url: this.wsUrls.get(requestId) ?? null },
            connectionId: requestId,
            requestId,
            url: this.wsUrls.get(requestId),
          })
        );
      });
    }

    if (mode === 'http' || mode === 'all') {
      this.subscribeNetwork('Network.requestWillBeSent', (params) => {
        const request = params['request'] as
          | { url: string; method: string; headers?: Record<string, string>; postData?: string }
          | undefined;
        const url = request?.url ?? '';
        const requestId = params['requestId'] as string;
        if (!this.matchesUrl(url)) return;

        this.httpUrls.set(requestId, url);
        const now = Date.now();

        this.networkRequests.push({
          requestId,
          timestamp: now,
          elapsedMs: this.elapsed(),
          method: request?.method ?? 'GET',
          url,
          headers: request?.headers,
          body: request?.postData,
        });
        this.traceEvents.push(
          normalizeTraceEvent({
            traceId: createTraceId('http'),
            ts: new Date(now).toISOString(),
            elapsedMs: this.elapsed(),
            channel: 'http',
            event: 'http.request.sent',
            summary: `${request?.method ?? 'GET'} ${url}`,
            data: {
              method: request?.method ?? 'GET',
              headers: request?.headers ?? {},
              body: request?.postData ?? null,
            },
            requestId,
            url,
          })
        );
      });

      this.subscribeNetwork('Network.responseReceived', (params) => {
        const requestId = params['requestId'] as string;
        if (!this.httpUrls.has(requestId)) return;

        const response = params['response'] as
          | {
              status: number;
              headers?: Record<string, string>;
              mimeType?: string;
            }
          | undefined;
        const now = Date.now();

        this.networkResponses.push({
          requestId,
          timestamp: now,
          elapsedMs: this.elapsed(),
          status: response?.status ?? 0,
          headers: response?.headers,
          mimeType: response?.mimeType,
        });
        this.traceEvents.push(
          normalizeTraceEvent({
            traceId: createTraceId('http'),
            ts: new Date(now).toISOString(),
            elapsedMs: this.elapsed(),
            channel: 'http',
            event: 'http.response.received',
            summary: `${response?.status ?? 0} ${this.httpUrls.get(requestId) ?? ''}`,
            data: {
              status: response?.status ?? 0,
              headers: response?.headers ?? {},
              mimeType: response?.mimeType ?? null,
            },
            requestId,
            url: this.httpUrls.get(requestId),
          })
        );

        // Optionally capture response body
        if (this.listenOpts?.captureResponseBodies) {
          const bodyPromise = this.cdp
            .send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', {
              requestId,
            })
            .then((result) => {
              const resp = this.networkResponses.find((r) => r.requestId === requestId);
              if (resp) {
                resp.body = result.base64Encoded
                  ? `[base64: ${result.body.length} chars]`
                  : result.body;
                resp.bodySize = result.body.length;
              }
            })
            .catch(() => {
              // Body not available (e.g. streaming, redirects) — ignore
            });
          this.pendingBodies.push(bodyPromise);
        }
      });

      this.subscribeNetwork('Network.loadingFailed', (params) => {
        const requestId = params['requestId'] as string;
        this.traceEvents.push(
          normalizeTraceEvent({
            traceId: createTraceId('http'),
            ts: new Date().toISOString(),
            elapsedMs: this.elapsed(),
            channel: 'http',
            event: 'http.response.failed',
            severity: 'error',
            summary: `HTTP request failed ${requestId}`,
            data: {
              errorText: params['errorText'] ?? null,
              blockedReason: params['blockedReason'] ?? null,
              canceled: params['canceled'] ?? false,
            },
            requestId,
            url: this.httpUrls.get(requestId),
          })
        );
      });
    }
  }

  private channelForTraceEvent(eventName: string): CanonicalTraceEvent['channel'] {
    if (eventName.startsWith('permission.')) return 'permission';
    if (eventName.startsWith('media.')) return 'media';
    if (eventName.startsWith('voice.')) return 'voice';
    if (eventName.startsWith('dom.')) return 'dom';
    if (eventName.startsWith('runtime.')) return 'runtime';
    return 'session';
  }

  /** Build a merged timeline from action events and network events. */
  private buildTimeline(): TimelineEntry[] {
    const entries: TimelineEntry[] = [];

    // Add DOM action events
    for (const event of this.events) {
      entries.push({
        timestamp: event.timestamp,
        elapsedMs: event.timestamp - this.startTime,
        type: 'action',
        data: { kind: event.kind, url: event.url, selectors: event.selectors, value: event.value },
      });
    }

    // Add network requests
    for (const req of this.networkRequests) {
      entries.push({
        timestamp: req.timestamp,
        elapsedMs: req.elapsedMs,
        type: 'network-request',
        data: req,
      });
    }

    // Add network responses
    for (const resp of this.networkResponses) {
      entries.push({
        timestamp: resp.timestamp,
        elapsedMs: resp.elapsedMs,
        type: 'network-response',
        data: resp,
      });
    }

    // Add WebSocket events
    for (const evt of this.wsEvents) {
      entries.push({
        timestamp: evt.timestamp,
        elapsedMs: evt.elapsedMs,
        type: 'ws-event',
        data: evt,
      });
    }

    // Add WebSocket frames
    for (const frame of this.wsFrames) {
      entries.push({
        timestamp: frame.timestamp,
        elapsedMs: frame.elapsedMs,
        type: 'ws-frame',
        data: frame,
      });
    }

    // Sort by timestamp
    entries.sort((a, b) => a.timestamp - b.timestamp);

    return entries;
  }
}

/** Convert a simple glob pattern to a RegExp. Supports * only. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withWildcards = escaped.replace(/\*/g, '.*');
  return new RegExp(`^${withWildcards}$`);
}
