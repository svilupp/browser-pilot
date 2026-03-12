export type TraceSeverity = 'info' | 'warn' | 'error';

export type TraceChannel =
  | 'action'
  | 'http'
  | 'ws'
  | 'console'
  | 'runtime'
  | 'permission'
  | 'media'
  | 'voice'
  | 'dom'
  | 'session';

export type TraceView =
  | 'ws'
  | 'voice'
  | 'console'
  | 'permissions'
  | 'media'
  | 'ui'
  | 'session';

export interface CanonicalTraceEvent {
  traceId: string;
  sessionId?: string;
  targetId?: string;
  ts: string;
  elapsedMs: number;
  channel: TraceChannel;
  event: string;
  severity: TraceSeverity;
  summary: string;
  data: Record<string, unknown>;
  actionId?: string;
  stepIndex?: number;
  requestId?: string;
  connectionId?: string;
  selector?: string | string[];
  selectorUsed?: string;
  url?: string;
}

export function createTraceId(prefix = 'evt'): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function normalizeTraceEvent(
  event: Partial<CanonicalTraceEvent> & Pick<CanonicalTraceEvent, 'channel' | 'event' | 'summary'>
): CanonicalTraceEvent {
  return {
    traceId: event.traceId ?? createTraceId(event.channel),
    ts: event.ts ?? new Date().toISOString(),
    elapsedMs: event.elapsedMs ?? 0,
    severity: event.severity ?? inferSeverity(event.event),
    data: event.data ?? {},
    ...event,
  };
}

export function inferSeverity(eventName: string): TraceSeverity {
  if (
    eventName.includes('.failed') ||
    eventName.includes('.error') ||
    eventName.includes('exception') ||
    eventName.includes('notReady')
  ) {
    return 'error';
  }

  if (
    eventName.includes('.closed') ||
    eventName.includes('.warn') ||
    eventName.includes('.changed')
  ) {
    return 'warn';
  }

  return 'info';
}
