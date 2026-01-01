/**
 * Execution tracing and logging
 */

export type TraceLevel = 'debug' | 'info' | 'warn' | 'error';
export type TraceCategory = 'cdp' | 'action' | 'wait' | 'navigation' | 'batch';

export interface TraceEvent {
  /** Event timestamp */
  timestamp: string;
  /** Log level */
  level: TraceLevel;
  /** Event category */
  category: TraceCategory;
  /** Action being performed */
  action?: string;
  /** Target selector(s) */
  selector?: string | string[];
  /** Selector that was actually used */
  selectorUsed?: string;
  /** Duration in ms */
  durationMs?: number;
  /** Whether action succeeded */
  success?: boolean;
  /** Error message if failed */
  error?: string;
  /** Selectors that failed before success */
  failedSelectors?: Array<{ selector: string; reason: string }>;
  /** Current page URL */
  url?: string;
  /** Additional data */
  data?: Record<string, unknown>;
}

export type TraceOutput = 'console' | 'callback' | 'silent';

export interface TracerOptions {
  /** Whether tracing is enabled */
  enabled: boolean;
  /** Output destination */
  output: TraceOutput;
  /** Custom callback for trace events */
  callback?: (event: TraceEvent) => void;
  /** Minimum level to log */
  level?: TraceLevel;
  /** Include timing information */
  includeTimings?: boolean;
}

const LEVEL_ORDER: Record<TraceLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Tracer {
  private options: TracerOptions;

  constructor(options: Partial<TracerOptions> = {}) {
    this.options = {
      enabled: options.enabled ?? false,
      output: options.output ?? 'console',
      callback: options.callback,
      level: options.level ?? 'info',
      includeTimings: options.includeTimings ?? true,
    };
  }

  /**
   * Emit a trace event
   */
  emit(event: Omit<TraceEvent, 'timestamp'>): void {
    if (!this.options.enabled) return;

    // Check log level
    if (LEVEL_ORDER[event.level] < LEVEL_ORDER[this.options.level!]) {
      return;
    }

    const fullEvent: TraceEvent = {
      ...event,
      timestamp: new Date().toISOString(),
    };

    switch (this.options.output) {
      case 'console':
        this.logToConsole(fullEvent);
        break;

      case 'callback':
        this.options.callback?.(fullEvent);
        break;

      case 'silent':
        // Do nothing
        break;
    }
  }

  /**
   * Log event to console
   */
  private logToConsole(event: TraceEvent): void {
    const { level, category, action, selectorUsed, success, durationMs, error } = event;

    const icon = success === true ? '✓' : success === false ? '✗' : '○';
    const timing =
      this.options.includeTimings && durationMs !== undefined ? ` (${durationMs}ms)` : '';
    const selector = selectorUsed ? ` ${selectorUsed}` : '';
    const errorStr = error ? ` - ${error}` : '';

    const message = `[${level.toUpperCase()}] [${category}] ${icon} ${action}${selector}${timing}${errorStr}`;

    switch (level) {
      case 'debug':
        console.debug(message);
        break;
      case 'info':
        console.info(message);
        break;
      case 'warn':
        console.warn(message);
        break;
      case 'error':
        console.error(message);
        break;
    }
  }

  /**
   * Create a child tracer with modified options
   */
  child(options: Partial<TracerOptions>): Tracer {
    return new Tracer({ ...this.options, ...options });
  }

  /**
   * Enable tracing
   */
  enable(): void {
    this.options.enabled = true;
  }

  /**
   * Disable tracing
   */
  disable(): void {
    this.options.enabled = false;
  }

  /**
   * Check if tracing is enabled
   */
  get isEnabled(): boolean {
    return this.options.enabled;
  }
}

// Global tracer instance
let globalTracer: Tracer | null = null;

/**
 * Get the global tracer instance
 */
export function getTracer(): Tracer {
  if (!globalTracer) {
    globalTracer = new Tracer({ enabled: false });
  }
  return globalTracer;
}

/**
 * Enable global tracing
 */
export function enableTracing(options: Partial<Omit<TracerOptions, 'enabled'>> = {}): Tracer {
  globalTracer = new Tracer({ ...options, enabled: true });
  return globalTracer;
}

/**
 * Disable global tracing
 */
export function disableTracing(): void {
  if (globalTracer) {
    globalTracer.disable();
  }
}
