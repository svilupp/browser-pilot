import { now as clockNow } from '../runtime/clock.ts';
import { randomId } from '../runtime/id.ts';
import {
  decodeObject,
  jsonArray,
  jsonNumber,
  jsonRecord,
  jsonString,
  jsonTraceSeverity,
  optionalJson,
  parseJson,
} from '../utils/json.ts';
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
  | 'http'
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
  executionId?: string;
  attempt?: number;
  stepIndex?: number;
  requestId?: string;
  connectionId?: string;
  selector?: string | string[];
  selectorUsed?: string;
  url?: string;
}

export function createTraceId(prefix = 'evt'): string {
  const random = randomId();
  return `${prefix}-${clockNow().toString(36)}-${random}`;
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

/** Decode persisted trace events before exposing them to consumers. */
export function parseTraceEvent(text: string): CanonicalTraceEvent {
  return decodeObject(parseJson(text), {
    traceId: jsonString,
    sessionId: optionalJson(jsonString),
    targetId: optionalJson(jsonString),
    ts: jsonString,
    elapsedMs: jsonNumber,
    channel: (value) => {
      const channel = jsonString(value);
      switch (channel) {
        case 'action':
        case 'http':
        case 'ws':
        case 'console':
        case 'runtime':
        case 'permission':
        case 'media':
        case 'voice':
        case 'dom':
        case 'session':
          return channel;
        default:
          throw new Error('Invalid trace channel');
      }
    },
    event: jsonString,
    severity: jsonTraceSeverity,
    summary: jsonString,
    data: jsonRecord,
    actionId: optionalJson(jsonString),
    executionId: optionalJson(jsonString),
    attempt: optionalJson(jsonNumber),
    stepIndex: optionalJson(jsonNumber),
    requestId: optionalJson(jsonString),
    connectionId: optionalJson(jsonString),
    selector: optionalJson((value) =>
      typeof value === 'string' ? value : jsonArray(jsonString)(value)
    ),
    selectorUsed: optionalJson(jsonString),
    url: optionalJson(jsonString),
  });
}
