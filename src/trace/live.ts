import type { CDPClient } from '../cdp/client.ts';
import { TRACE_BINDING_NAME, TRACE_SCRIPT } from './script.ts';
import type { CanonicalTraceEvent } from './model.ts';
import { createTraceId, normalizeTraceEvent } from './model.ts';

export type ListenMode = 'ws' | 'http' | 'all';

export interface LiveTraceCollectorOptions {
  sessionId?: string;
  targetId?: string;
  mode?: ListenMode;
  match?: string;
  maxPayload?: number;
  onEvent?: (event: CanonicalTraceEvent) => void | Promise<void>;
}

type EventHandler = (params: Record<string, unknown>) => void;

export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withWildcards = escaped.replace(/\*/g, '.*');
  return new RegExp(`^${withWildcards}$`);
}

export class LiveTraceCollector {
  private readonly cdp: CDPClient;
  private readonly options: LiveTraceCollectorOptions;
  private readonly handlers: Array<{ event: string; handler: EventHandler }> = [];
  private readonly wsUrls = new Map<string, string>();
  private readonly httpUrls = new Map<string, string>();
  private readonly events: CanonicalTraceEvent[] = [];
  private readonly startTime = Date.now();
  private readonly matchRegex: RegExp | null;

  constructor(cdp: CDPClient, options: LiveTraceCollectorOptions = {}) {
    this.cdp = cdp;
    this.options = options;
    this.matchRegex = options.match ? globToRegex(options.match) : null;
  }

  async start(): Promise<void> {
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Page.enable');
    await this.cdp.send('Network.enable');
    await this.cdp.send('Runtime.addBinding', { name: TRACE_BINDING_NAME });
    await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: TRACE_SCRIPT });
    await this.cdp.send('Runtime.evaluate', { expression: TRACE_SCRIPT, awaitPromise: false });

    if ((this.options.mode ?? 'all') !== 'http') {
      this.subscribe('Network.webSocketCreated', (params) => {
        const requestId = String(params['requestId'] ?? '');
        const url = String(params['url'] ?? '');
        if (!this.matchesUrl(url)) {
          return;
        }

        this.wsUrls.set(requestId, url);
        void this.emit({
          channel: 'ws',
          event: 'ws.connection.created',
          summary: `WebSocket opened ${url}`,
          connectionId: requestId,
          requestId,
          url,
          data: { url },
        });
      });

      this.subscribe('Network.webSocketFrameSent', (params) => {
        const requestId = String(params['requestId'] ?? '');
        const response = params['response'] as { opcode?: number; payloadData?: string } | undefined;
        const payload = this.formatPayload(response?.payloadData, response?.opcode ?? 1);
        const url = this.wsUrls.get(requestId);
        if (this.matchRegex && !this.matchRegex.test(url ?? '') && !this.matchRegex.test(payload)) {
          return;
        }
        void this.emit({
          channel: 'ws',
          event: 'ws.frame.sent',
          summary: `WebSocket frame sent ${requestId}`,
          connectionId: requestId,
          requestId,
          url,
          data: {
            opcode: response?.opcode ?? 1,
            payload,
            length: response?.payloadData?.length ?? 0,
          },
        });
      });

      this.subscribe('Network.webSocketFrameReceived', (params) => {
        const requestId = String(params['requestId'] ?? '');
        const response = params['response'] as { opcode?: number; payloadData?: string } | undefined;
        const payload = this.formatPayload(response?.payloadData, response?.opcode ?? 1);
        const url = this.wsUrls.get(requestId);
        if (this.matchRegex && !this.matchRegex.test(url ?? '') && !this.matchRegex.test(payload)) {
          return;
        }
        void this.emit({
          channel: 'ws',
          event: 'ws.frame.received',
          summary: `WebSocket frame received ${requestId}`,
          connectionId: requestId,
          requestId,
          url,
          data: {
            opcode: response?.opcode ?? 1,
            payload,
            length: response?.payloadData?.length ?? 0,
          },
        });
      });

      this.subscribe('Network.webSocketClosed', (params) => {
        const requestId = String(params['requestId'] ?? '');
        const url = this.wsUrls.get(requestId);
        this.wsUrls.delete(requestId);
        void this.emit({
          channel: 'ws',
          event: 'ws.connection.closed',
          summary: `WebSocket closed ${requestId}`,
          severity: 'warn',
          connectionId: requestId,
          requestId,
          url,
          data: { url },
        });
      });
    }

    if ((this.options.mode ?? 'all') !== 'ws') {
      this.subscribe('Network.requestWillBeSent', (params) => {
        const request = params['request'] as { url?: string; method?: string; headers?: unknown; postData?: string } | undefined;
        const requestId = String(params['requestId'] ?? '');
        const url = String(request?.url ?? '');
        if (!this.matchesUrl(url)) {
          return;
        }

        this.httpUrls.set(requestId, url);
        void this.emit({
          channel: 'http',
          event: 'http.request.sent',
          summary: `${request?.method ?? 'GET'} ${url}`,
          requestId,
          url,
          data: {
            method: request?.method ?? 'GET',
            headers: (request?.headers as Record<string, unknown> | undefined) ?? {},
            body: request?.postData ?? null,
          },
        });
      });

      this.subscribe('Network.responseReceived', (params) => {
        const requestId = String(params['requestId'] ?? '');
        if (!this.httpUrls.has(requestId)) {
          return;
        }

        const response = params['response'] as { status?: number; headers?: unknown; mimeType?: string; url?: string } | undefined;
        void this.emit({
          channel: 'http',
          event: 'http.response.received',
          summary: `${response?.status ?? 0} ${response?.url ?? this.httpUrls.get(requestId) ?? ''}`,
          requestId,
          url: response?.url ?? this.httpUrls.get(requestId),
          data: {
            status: response?.status ?? 0,
            headers: (response?.headers as Record<string, unknown> | undefined) ?? {},
            mimeType: response?.mimeType ?? null,
          },
        });
      });

      this.subscribe('Network.loadingFailed', (params) => {
        const requestId = String(params['requestId'] ?? '');
        const url = String(params['blockedReason'] ?? this.httpUrls.get(requestId) ?? '');
        void this.emit({
          channel: 'http',
          event: 'http.response.failed',
          summary: `HTTP request failed ${requestId}`,
          severity: 'error',
          requestId,
          url,
          data: {
            errorText: params['errorText'] ?? null,
            blockedReason: params['blockedReason'] ?? null,
            canceled: params['canceled'] ?? false,
          },
        });
      });
    }

    this.subscribe('Runtime.consoleAPICalled', (params) => {
      const type = String(params['type'] ?? 'log');
      if (type !== 'log' && type !== 'warn' && type !== 'error') {
        return;
      }

      const args = Array.isArray(params['args']) ? (params['args'] as Array<Record<string, unknown>>) : [];
      const text = args
        .map((entry) => String(entry['value'] ?? entry['description'] ?? ''))
        .filter(Boolean)
        .join(' ');

      void this.emit({
        channel: 'console',
        event: `console.${type}`,
        severity: type === 'error' ? 'error' : type === 'warn' ? 'warn' : 'info',
        summary: text || `console.${type}`,
        data: { args },
      });
    });

    this.subscribe('Runtime.exceptionThrown', (params) => {
      const details = (params['exceptionDetails'] ?? {}) as Record<string, unknown>;
      const text = String(details['text'] ?? 'Runtime exception');
      void this.emit({
        channel: 'runtime',
        event: 'runtime.exception',
        severity: 'error',
        summary: text,
        data: details,
      });
    });

    this.subscribe('Runtime.bindingCalled', (params) => {
      if (params['name'] !== TRACE_BINDING_NAME) {
        return;
      }

      const raw = String(params['payload'] ?? '');
      try {
        const payload = JSON.parse(raw) as {
          event: string;
          severity?: 'info' | 'warn' | 'error';
          summary?: string;
          ts?: number;
          data?: Record<string, unknown>;
        };

        const channel = this.channelForTraceEvent(payload.event);
        void this.emit({
          channel,
          event: payload.event,
          severity: payload.severity,
          summary: payload.summary ?? payload.event,
          ts: payload.ts ? new Date(payload.ts).toISOString() : undefined,
          data: payload.data ?? {},
          url:
            typeof payload.data?.['url'] === 'string' ? (payload.data['url'] as string) : undefined,
        });
      } catch {
        // ignore malformed payloads
      }
    });
  }

  async stop(): Promise<CanonicalTraceEvent[]> {
    for (const { event, handler } of this.handlers) {
      this.cdp.off(event, handler);
    }
    this.handlers.length = 0;
    return [...this.events];
  }

  getEvents(): CanonicalTraceEvent[] {
    return [...this.events];
  }

  private subscribe(event: string, handler: EventHandler): void {
    this.cdp.on(event, handler);
    this.handlers.push({ event, handler });
  }

  private matchesUrl(url: string): boolean {
    if (!this.matchRegex) {
      return true;
    }
    return this.matchRegex.test(url);
  }

  private formatPayload(payloadData: string | undefined, opcode: number): string {
    const data = payloadData ?? '';
    const maxPayload = this.options.maxPayload ?? 256;

    if (opcode === 2) {
      const byteLength = Math.floor((data.length * 3) / 4);
      return `[binary: ${byteLength} bytes]`;
    }

    if (data.length > maxPayload) {
      return `${data.slice(0, maxPayload)}... [truncated, ${data.length} total]`;
    }

    return data;
  }

  private channelForTraceEvent(eventName: string) {
    if (eventName.startsWith('ws.')) return 'ws';
    if (eventName.startsWith('http.')) return 'http';
    if (eventName.startsWith('console.')) return 'console';
    if (eventName.startsWith('permission.')) return 'permission';
    if (eventName.startsWith('media.')) return 'media';
    if (eventName.startsWith('voice.')) return 'voice';
    if (eventName.startsWith('dom.')) return 'dom';
    if (eventName.startsWith('runtime.')) return 'runtime';
    return 'session';
  }

  private async emit(
    event: Partial<CanonicalTraceEvent> & Pick<CanonicalTraceEvent, 'channel' | 'event' | 'summary'>
  ): Promise<void> {
    const normalized = normalizeTraceEvent({
      traceId: event.traceId ?? createTraceId(event.channel),
      sessionId: this.options.sessionId,
      targetId: this.options.targetId,
      elapsedMs: event.elapsedMs ?? Date.now() - this.startTime,
      ...event,
    });
    this.events.push(normalized);
    await this.options.onEvent?.(normalized);
  }
}
