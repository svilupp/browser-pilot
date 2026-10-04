/**
 * Recorder class for capturing browser interactions via CDP
 *
 * The Recorder connects to a browser via CDP, injects a recording script,
 * and captures user interactions. Events are aggregated into Step[] for
 * replay via page.batch().
 */

import type { CDPClient } from '../cdp/client.ts';
import { PageScript } from '../cdp/page-script.ts';
import { createExecutionId } from '../runtime/id.ts';
import { type CanonicalTraceEvent, createTraceId, normalizeTraceEvent } from '../trace/model.ts';
import { createTraceScript, traceCleanupScript } from '../trace/script.ts';
import { formatConsoleArg, globToRegex, readString, readStringOr } from '../utils/strings.ts';
import { aggregateEvents } from './aggregator.ts';
import { REDACTED_VALUE, redactRecordingURL, redactValueForRecording } from './redaction.ts';
import { createRecorderScript, recorderCleanupScript } from './script.ts';
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
export interface RecorderEventContext {
  sequence: number;
  signal: AbortSignal;
}
export interface RecorderMarker {
  label: string;
  sequence: number;
  elapsedMs: number;
  at: string;
}
export interface RecorderCaptureStatus {
  scheduled: number;
  completed: number;
  failed: number;
  skipped: number;
  pending: number;
  drainTimedOut: boolean;
  cleanupErrors: string[];
}
export interface RecorderOptions {
  /** Optional page-side fail-safe lease; call heartbeat() before this interval expires. */
  maxIdleMs?: number;
  /** Deadline for pending event/screenshot callbacks at stop (default 5 seconds). */
  drainTimeoutMs?: number;
  /** Bound retained DOM/runtime evidence, excluding host-owned image bytes. */
  maxBytes?: number;
  /** Metadata omits all field values, request bodies/headers, console arguments and WS contents. */
  privacy?: 'standard' | 'metadata';
  /** Current-document capture never registers future-document injection. */
  navigation?: 'all' | 'current-document';
  /** Enable network traffic capture alongside DOM recording. */
  listen?: boolean | RecorderListenOptions;
  /** Called after each captured event. Use for live screenshot capture. */
  onEvent?: (event: RawRecordedEvent, context: RecorderEventContext) => void | Promise<void>;
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
  readonly id = createExecutionId('recording');
  readonly bindingName = `__recorder_${this.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  private readonly traceBinding = `__bpTrace_${this.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  private scripts: PageScript[] = [];
  private pendingEvents = new Set<Promise<void>>();
  private eventTail: Promise<void> = Promise.resolve();
  private abort = new AbortController();
  private capture: RecorderCaptureStatus = {
    scheduled: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    pending: 0,
    drainTimedOut: false,
    cleanupErrors: [],
  };
  private stopping?: Promise<FullRecordingOutput>;
  private state: 'idle' | 'starting' | 'ready' | 'stopping' | 'complete' | 'failed' = 'idle';
  private monoStart = 0;
  private retainedBytes = 0;
  private limited = false;
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
    if (this.recording || this.state === 'stopping') {
      throw new Error('Recording already in progress');
    }

    this.retainedBytes = 0;
    this.limited = false;
    this.state = 'starting';
    this.stopping = undefined;
    this.abort = new AbortController();
    this.pendingEvents = new Set();
    this.eventTail = Promise.resolve();
    this.capture = {
      scheduled: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      pending: 0,
      drainTimedOut: false,
      cleanupErrors: [],
    };
    this.networkRequests = [];
    this.networkResponses = [];
    this.wsEvents = [];
    this.wsFrames = [];
    this.wsUrls.clear();
    this.httpUrls.clear();
    this.pendingBodies = [];
    this.listenOpts = null;
    this.monoStart = performance.now();
    this.events = [];
    this.traceEvents = [];
    this.startTime = Date.now();
    this.recording = true;

    try {
      // Enable required CDP domains
      await this.cdp.send('Runtime.enable');
      await this.cdp.send('Page.enable');

      // Get current URL for start state
      try {
        const result = await this.cdp.send<{ result: { value: string } }>('Runtime.evaluate', {
          expression: 'location.href',
          returnByValue: true,
        });
        this.startUrl = this.cleanURL(result.result.value);
      } catch {
        this.startUrl = '';
      }

      // Listen for binding calls
      this.bindingHandler = (params: Record<string, unknown>) => {
        const payload = readString(params['payload']);
        if (!payload) {
          return;
        }

        if (params['name'] === this.bindingName) {
          this.handleBindingCall(payload);
        } else if (params['name'] === this.traceBinding) {
          this.handleTraceBindingCall(payload);
        }
      };
      this.cdp.on('Runtime.bindingCalled', this.bindingHandler);
      const future = this.options.navigation !== 'current-document';
      this.scripts = [
        new PageScript(
          this.cdp,
          this.bindingName,
          createRecorderScript(this.bindingName, this.id, this.options.maxIdleMs),
          recorderCleanupScript(this.id),
          future
        ),
        new PageScript(
          this.cdp,
          this.traceBinding,
          createTraceScript(this.traceBinding, this.id),
          traceCleanupScript(this.id),
          future
        ),
      ];
      for (const script of this.scripts) await script.install();

      this.subscribeTrace('Runtime.consoleAPICalled', (params) => {
        const type = readStringOr(params['type'], 'log');
        if (type !== 'log' && type !== 'warn' && type !== 'error') {
          return;
        }

        const args = Array.isArray(params['args'])
          ? (params['args'] as Array<Record<string, unknown>>)
          : [];
        const text =
          this.options.privacy === 'metadata'
            ? '[console arguments omitted]'
            : args.map(formatConsoleArg).filter(Boolean).join(' ').slice(0, 4096);

        this.appendTrace(
          normalizeTraceEvent({
            traceId: createTraceId('console'),
            sessionId: '',
            ts: new Date().toISOString(),
            elapsedMs: this.elapsed(),
            channel: 'console',
            event: `console.${type}`,
            severity: type === 'error' ? 'error' : type === 'warn' ? 'warn' : 'info',
            summary: text || `console.${type}`,
            data: this.options.privacy === 'metadata' ? {} : { args },
            url: this.startUrl,
          })
        );
      });

      this.subscribeTrace('Runtime.exceptionThrown', (params) => {
        const details = (params['exceptionDetails'] ?? {}) as Record<string, unknown>;
        this.appendTrace(
          normalizeTraceEvent({
            traceId: createTraceId('runtime'),
            ts: new Date().toISOString(),
            elapsedMs: this.elapsed(),
            channel: 'runtime',
            event: 'runtime.exception',
            severity: 'error',
            summary:
              this.options.privacy === 'metadata'
                ? 'Runtime exception'
                : (readString(details['text']) ?? 'Runtime exception'),
            data: this.options.privacy === 'metadata' ? {} : details,
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
      this.startUrl = this.cleanURL(this.startUrl);
      this.state = 'ready';
    } catch (error) {
      this.recording = false;
      this.state = 'failed';
      await this.cleanup();
      throw error;
    }
  }

  /**
   * Stop recording and return aggregated output.
   *
   * Returns a RecordingOutput with steps compatible with page.batch().
   */
  stop(): Promise<FullRecordingOutput> {
    if (this.stopping) return this.stopping;
    if (!this.recording) return Promise.reject(new Error('No recording in progress'));
    this.stopping = this.finalize();
    return this.stopping;
  }
  private async cleanup(): Promise<void> {
    if (this.bindingHandler) {
      this.cdp.off('Runtime.bindingCalled', this.bindingHandler);
      this.bindingHandler = null;
    }
    for (const { event, handler } of [...this.networkHandlers, ...this.traceHandlers])
      this.cdp.off(event, handler);
    this.networkHandlers = [];
    this.traceHandlers = [];
    for (const script of this.scripts) this.capture.cleanupErrors.push(...(await script.dispose()));
    this.scripts = [];
    // Never disable domains shared with an unrelated consumer on this CDP session.
  }
  async dispose(): Promise<void> {
    if (this.recording) await this.stop();
    else await this.cleanup();
  }
  async heartbeat(): Promise<void> {
    if (!this.recording) return;
    await this.cdp.send(
      'Runtime.evaluate',
      {
        expression: `if(window.__bpRecorderLeases?.[${JSON.stringify(this.id)}])window.__bpRecorderLeases[${JSON.stringify(this.id)}]=Date.now()`,
        returnByValue: true,
      },
      undefined,
      { timeout: 2000 }
    );
  }
  get status(): string {
    return this.state;
  }
  marker(label: string): RecorderMarker {
    if (!this.recording || this.state !== 'ready') throw new Error('Recording is not ready');
    const marker = {
      label: label.slice(0, 256),
      sequence: this.events.length,
      elapsedMs: Math.max(0, performance.now() - this.monoStart),
      at: new Date().toISOString(),
    };
    this.appendTrace(
      normalizeTraceEvent({
        traceId: createTraceId('marker'),
        ts: marker.at,
        elapsedMs: marker.elapsedMs,
        channel: 'session',
        event: 'recording.marker',
        summary: this.options.privacy === 'metadata' ? 'Recording marker' : marker.label,
        data: marker,
      })
    );
    return marker;
  }
  private async finalize(): Promise<FullRecordingOutput> {
    this.recording = false;
    this.state = 'stopping';
    const duration = Date.now() - this.startTime;
    await this.cleanup();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = this.options.drainTimeoutMs ?? 5000;
    await Promise.race([
      Promise.allSettled([...this.pendingEvents, ...this.pendingBodies]),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          this.capture.drainTimedOut = true;
          this.abort.abort();
          resolve();
        }, deadline);
      }),
    ]);
    if (timer) clearTimeout(timer);
    this.capture.pending = this.pendingEvents.size;
    this.pendingBodies = [];
    this.state = 'complete';
    // Aggregate events into steps (pass startUrl for navigation detection)
    const steps = aggregateEvents(this.events, this.startUrl);

    const result: FullRecordingOutput = {
      recordedAt: new Date(this.startTime).toISOString(),
      startUrl: this.startUrl,
      duration,
      steps,
      traceEvents: [...this.traceEvents],
      capture: { ...this.capture, cleanupErrors: [...this.capture.cleanupErrors] },
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
    if (!this.recording || this.limited) return;

    try {
      if (payload.length > 65536) return;
      const event = JSON.parse(payload) as RawRecordedEvent;
      if (
        !['click', 'dblclick', 'input', 'change', 'keydown', 'submit', 'navigation'].includes(
          event.kind
        ) ||
        !Number.isFinite(event.timestamp) ||
        typeof event.url !== 'string' ||
        !Array.isArray(event.selectors)
      )
        return;
      event.url = this.cleanURL(event.url);
      event.value =
        this.options.privacy === 'metadata' && event.value !== undefined
          ? REDACTED_VALUE
          : redactValueForRecording(event.value, {
              tagName: event.element?.tag,
              inputType: event.element?.type ?? undefined,
              autocomplete: event.element?.autocomplete,
              sensitiveValue: event.element?.private,
            });
      if (this.options.privacy === 'metadata') {
        event.selectors = event.selectors.filter((s) =>
          ['id', 'testid', 'css-path', 'name-attr'].includes(s.quality)
        );
        if (event.element)
          event.element = {
            tag: event.element.tag,
            id: event.element.id,
            name: event.element.name,
            type: event.element.type,
            role: event.element.role,
            ariaLabel: null,
            testid: event.element.testid,
            text: null,
          };
      }
      if (!this.reserve(event)) return;
      this.events.push(event);
      if (this.options.onEvent) {
        const sequence = this.events.length,
          signal = this.abort.signal,
          capture = this.capture;
        capture.scheduled++;
        const task = this.eventTail.then(async () => {
          if (signal.aborted) {
            capture.skipped++;
            return;
          }
          try {
            await this.options.onEvent?.(event, { sequence, signal });
            capture.completed++;
          } catch {
            capture.failed++;
          }
        });
        this.eventTail = task;
        this.pendingEvents.add(task);
        void task.finally(() => this.pendingEvents.delete(task));
      }
    } catch {
      // Invalid payload, ignore
    }
  }

  private handleTraceBindingCall(payload: string): void {
    if (!this.recording || this.limited) return;

    try {
      const data = JSON.parse(payload) as {
        event: string;
        severity?: 'info' | 'warn' | 'error';
        summary?: string;
        ts?: number;
        data?: Record<string, unknown>;
      };

      this.appendTrace(
        normalizeTraceEvent({
          traceId: createTraceId('trace'),
          ts: data.ts ? new Date(data.ts).toISOString() : new Date().toISOString(),
          elapsedMs: this.elapsed(),
          channel: this.channelForTraceEvent(data.event),
          event: data.event,
          severity: data.severity,
          summary:
            this.options.privacy === 'metadata'
              ? data.event
              : (data.summary ?? data.event).slice(0, 4096),
          data: this.options.privacy === 'metadata' ? {} : (data.data ?? {}),
          url: this.cleanURL(
            typeof data.data?.['url'] === 'string' ? data.data['url'] : this.startUrl
          ),
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
    const guarded = (params: Record<string, unknown>) => {
      if (!this.limited && this.recording && this.reserve(params)) handler(params);
    };
    this.cdp.on(event, guarded);
    this.networkHandlers.push({ event, handler: guarded });
  }

  private subscribeTrace(event: string, handler: (params: Record<string, unknown>) => void): void {
    const guarded = (params: Record<string, unknown>) => {
      if (!this.limited && this.recording && this.reserve(params)) handler(params);
    };
    this.cdp.on(event, guarded);
    this.traceHandlers.push({ event, handler: guarded });
  }

  /** Check if a URL matches the configured filter. */
  get byteCount(): number {
    return this.retainedBytes;
  }
  get limitReached(): boolean {
    return this.limited;
  }
  private reserve(value: unknown): boolean {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    if (this.retainedBytes + bytes > (this.options.maxBytes ?? Infinity)) {
      this.limited = true;
      return false;
    }
    this.retainedBytes += bytes;
    return true;
  }
  private appendTrace(event: CanonicalTraceEvent): void {
    if (this.reserve(event)) this.traceEvents.push(event);
  }
  private cleanURL(url: string): string {
    return this.options.privacy === 'metadata' ? redactRecordingURL(url) : url;
  }

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
    if (this.options.privacy === 'metadata')
      return { payload: REDACTED_VALUE, length: data.length };
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
        const url = this.cleanURL(params['url'] as string);
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
        this.appendTrace(
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
        this.appendTrace(
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
        this.appendTrace(
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

        const url = this.wsUrls.get(requestId);
        this.wsUrls.delete(requestId);
        const now = Date.now();
        this.wsEvents.push({
          requestId,
          timestamp: now,
          elapsedMs: this.elapsed(),
          type: 'closed',
        });
        this.appendTrace(
          normalizeTraceEvent({
            traceId: createTraceId('ws'),
            ts: new Date(now).toISOString(),
            elapsedMs: this.elapsed(),
            channel: 'ws',
            event: 'ws.connection.closed',
            severity: 'warn',
            summary: `WebSocket closed ${requestId}`,
            data: { url: url ?? null },
            connectionId: requestId,
            requestId,
            url,
          })
        );
      });
    }

    if (mode === 'http' || mode === 'all') {
      this.subscribeNetwork('Network.requestWillBeSent', (params) => {
        const request = params['request'] as
          | { url: string; method: string; headers?: Record<string, string>; postData?: string }
          | undefined;
        const url = this.cleanURL(request?.url ?? '');
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
          headers: this.options.privacy === 'metadata' ? undefined : request?.headers,
          body: this.options.privacy === 'metadata' ? undefined : request?.postData,
        });
        this.appendTrace(
          normalizeTraceEvent({
            traceId: createTraceId('http'),
            ts: new Date(now).toISOString(),
            elapsedMs: this.elapsed(),
            channel: 'http',
            event: 'http.request.sent',
            summary: `${request?.method ?? 'GET'} ${url}`,
            data: {
              method: request?.method ?? 'GET',
              headers: this.options.privacy === 'metadata' ? {} : (request?.headers ?? {}),
              body: this.options.privacy === 'metadata' ? null : (request?.postData ?? null),
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
          headers: this.options.privacy === 'metadata' ? undefined : response?.headers,
          mimeType: response?.mimeType,
        });
        this.appendTrace(
          normalizeTraceEvent({
            traceId: createTraceId('http'),
            ts: new Date(now).toISOString(),
            elapsedMs: this.elapsed(),
            channel: 'http',
            event: 'http.response.received',
            summary: `${response?.status ?? 0} ${this.httpUrls.get(requestId) ?? ''}`,
            data: {
              status: response?.status ?? 0,
              headers: this.options.privacy === 'metadata' ? {} : (response?.headers ?? {}),
              mimeType: response?.mimeType ?? null,
            },
            requestId,
            url: this.httpUrls.get(requestId),
          })
        );

        // Optionally capture response body
        if (this.listenOpts?.captureResponseBodies && this.options.privacy !== 'metadata') {
          const bodyPromise = this.cdp
            .send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', {
              requestId,
            })
            .then((result) => {
              const resp = this.networkResponses.find((r) => r.requestId === requestId);
              if (resp && !this.abort.signal.aborted && this.reserve(result.body)) {
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
        this.appendTrace(
          normalizeTraceEvent({
            traceId: createTraceId('http'),
            ts: new Date().toISOString(),
            elapsedMs: this.elapsed(),
            channel: 'http',
            event: 'http.response.failed',
            severity: 'error',
            summary: `HTTP request failed ${requestId}`,
            data: {
              errorText: this.options.privacy === 'metadata' ? null : (params['errorText'] ?? null),
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
