/**
 * BrowserBase provider implementation
 * https://docs.browserbase.com/
 */

import type { Clock } from '../core/ports.ts';
import { now } from '../runtime/clock.ts';
import { isRecord } from '../utils/json.ts';
import type {
  CreateSessionOptions,
  Provider,
  ProviderReleaseResult,
  ProviderSession,
} from './types.ts';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RELEASE_TIMEOUT_MS = 10_000;
const RELEASE_POLL_INTERVAL_MS = 500;
const ERROR_EXCERPT_MAX_CHARS = 300;
const TERMINAL_STATUSES = new Set(['COMPLETED', 'ERROR', 'TIMED_OUT']);

/**
 * Injectable time source so tests can control polling deterministically.
 *
 * @deprecated Use the `Clock` port from `browser-pilot/core` instead; this
 * alias is kept for backward compatibility.
 */
export type BrowserBaseClock = Clock;

const defaultClock: Clock = {
  now,
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface BrowserBaseOptions {
  apiKey: string;
  /** Browserbase project ID. When omitted, resolved via `GET /v1/projects` (must be exactly one). */
  projectId?: string;
  baseUrl?: string;
  /** Per-request timeout, including response body consumption, in ms (default 30_000). */
  requestTimeoutMs?: number;
  /** Total release and polling budget in ms (default 10_000). */
  releaseTimeoutMs?: number;
  /** Time source; override in tests for deterministic polling. */
  clock?: Clock;
}

interface BrowserBaseSession {
  id: string;
  projectId: string;
  status: string;
  createdAt: string;
  connectUrl?: string;
  debugUrl?: string;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function excerpt(text: string, max = ERROR_EXCERPT_MAX_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\u2026` : text;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function validateCreateOptions(options: CreateSessionOptions): void {
  const hasWidth = options.width !== undefined;
  const hasHeight = options.height !== undefined;
  if (hasWidth && !isPositiveInt(options.width)) {
    throw new Error(
      `BrowserBase createSession: width must be a positive integer, got ${String(options.width)}`
    );
  }
  if (hasHeight && !isPositiveInt(options.height)) {
    throw new Error(
      `BrowserBase createSession: height must be a positive integer, got ${String(options.height)}`
    );
  }
  if (hasWidth !== hasHeight) {
    throw new Error('BrowserBase createSession: width and height must both be provided together');
  }
}

/** Preserve provider-specific fields; normalize the portable session aliases. */
function buildCreateBody(options: CreateSessionOptions): Record<string, unknown> {
  validateCreateOptions(options);
  const body: Record<string, unknown> = { ...options };
  for (const key of ['width', 'height', 'recording', 'proxy', 'sessionId', 'projectId']) {
    delete body[key];
  }

  const rawSettings = options['browserSettings'];
  if (rawSettings !== undefined && !isRecord(rawSettings)) {
    throw new Error('BrowserBase createSession: browserSettings must be an object');
  }
  const settings = { ...(rawSettings ?? {}) };
  if (options.width !== undefined && options.height !== undefined) {
    settings['viewport'] = { width: options.width, height: options.height };
  }
  if (settings['viewport'] !== undefined) {
    const viewport = settings['viewport'];
    if (
      !isRecord(viewport) ||
      !isPositiveInt(viewport['width']) ||
      !isPositiveInt(viewport['height'])
    ) {
      throw new Error(
        'BrowserBase createSession: viewport width and height must be positive integers'
      );
    }
  }
  if (options.recording !== undefined) {
    if (typeof options.recording !== 'boolean') {
      throw new Error('BrowserBase createSession: recording must be a boolean');
    }
    settings['recordSession'] = options.recording;
  }
  if (rawSettings !== undefined || Object.keys(settings).length > 0) {
    body['browserSettings'] = settings;
  }
  if (options.proxy !== undefined) {
    if (options['proxies'] !== undefined) {
      throw new Error('BrowserBase createSession: specify either proxy or proxies, not both');
    }
    if (
      !isRecord(options.proxy) ||
      typeof options.proxy.server !== 'string' ||
      !options.proxy.server
    ) {
      throw new Error('BrowserBase createSession: proxy must include a server URL');
    }
    body['proxies'] = [{ ...options.proxy, type: 'external' }];
  }

  const keepAlive = options['keepAlive'];
  if (keepAlive !== undefined && typeof keepAlive !== 'boolean') {
    throw new Error('BrowserBase createSession: keepAlive must be a boolean');
  }
  const region = options['region'];
  if (region !== undefined && (typeof region !== 'string' || region.trim().length === 0)) {
    throw new Error('BrowserBase createSession: region must be a non-empty string');
  }
  const timeout = options['timeout'];
  if (timeout !== undefined && (!isPositiveInt(timeout) || timeout < 60 || timeout > 21_600)) {
    throw new Error(
      'BrowserBase createSession: timeout must be an integer from 60 to 21600 seconds'
    );
  }
  return body;
}

interface HttpResponse {
  ok: boolean;
  status: number;
  body: string;
}

/** Bound the whole request, even when an injected fetch ignores abort. */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<HttpResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`request timeout after ${timeoutMs}ms`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { ...init, signal: controller.signal });
        const body = await response.text();
        return { ok: response.ok, status: response.status, body };
      })(),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(response: HttpResponse): unknown {
  try {
    return JSON.parse(response.body);
  } catch {
    // JSON parser diagnostics can include raw response contents.
    throw new Error('BrowserBase returned invalid JSON');
  }
}

function parseSession(response: HttpResponse): BrowserBaseSession {
  const data = parseJson(response);
  if (
    !isRecord(data) ||
    typeof data['id'] !== 'string' ||
    !data['id'] ||
    typeof data['status'] !== 'string'
  ) {
    throw new Error('BrowserBase returned an invalid session response');
  }
  const projectId = data['projectId'];
  const createdAt = data['createdAt'];
  const connectUrl = data['connectUrl'];
  const debugUrl = data['debugUrl'];
  return {
    id: data['id'],
    projectId: typeof projectId === 'string' ? projectId : '',
    status: data['status'],
    createdAt: typeof createdAt === 'string' ? createdAt : '',
    ...(typeof connectUrl === 'string' ? { connectUrl } : {}),
    ...(typeof debugUrl === 'string' ? { debugUrl } : {}),
  };
}

export class BrowserBaseProvider implements Provider {
  readonly name = 'browserbase';
  private readonly apiKey: string;
  private projectId: string | undefined;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly releaseTimeoutMs: number;
  private readonly clock: Clock;
  private projectIdPromise: Promise<string> | null = null;
  private readonly releaseResults = new Map<string, Promise<ProviderReleaseResult>>();

  constructor(options: BrowserBaseOptions) {
    if (!options.apiKey) {
      throw new Error('BrowserBase provider requires apiKey');
    }
    this.apiKey = options.apiKey;
    this.projectId = options.projectId;
    this.baseUrl = options.baseUrl ?? 'https://api.browserbase.com';
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.releaseTimeoutMs = options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
    this.clock = options.clock ?? defaultClock;
    for (const [name, value] of Object.entries({
      requestTimeoutMs: this.requestTimeoutMs,
      releaseTimeoutMs: this.releaseTimeoutMs,
    })) {
      if (!isPositiveInt(value) || value > 2_147_483_647) {
        throw new Error(
          `BrowserBase ${name} must be a positive integer no greater than 2147483647`
        );
      }
    }
  }

  async createSession(options: CreateSessionOptions = {}): Promise<ProviderSession> {
    const body = buildCreateBody(options);
    const projectId = await this.resolveProjectId();
    body['projectId'] = projectId;

    let response: HttpResponse;
    try {
      response = await fetchWithTimeout(
        `${this.baseUrl}/v1/sessions`,
        { method: 'POST', headers: this.headers(true), body: JSON.stringify(body) },
        this.requestTimeoutMs
      );
    } catch (error) {
      throw new Error(
        `BrowserBase createSession failed: network error (${this.errorMessage(error)})`
      );
    }

    if (!response.ok) {
      throw this.httpError('BrowserBase createSession failed', response);
    }

    const session = parseSession(response);

    try {
      const details = session.connectUrl ? session : await this.fetchSessionDetails(session.id);
      if (typeof details.connectUrl !== 'string' || !details.connectUrl) {
        throw new Error('BrowserBase session does not have a connectUrl');
      }
      return this.buildProviderSession(session.id, details.connectUrl, {
        debugUrl: details.debugUrl,
        projectId,
        status: details.status,
      });
    } catch (error) {
      const cleanup = await this.release(session.id, projectId);
      throw new Error(
        `BrowserBase session setup failed: ${this.errorMessage(error)} (session ${session.id}; cleanup: ${cleanup.status}${cleanup.error ? `; ${cleanup.error}` : ''})`
      );
    }
  }

  async resumeSession(sessionId: string): Promise<ProviderSession> {
    const details = await this.fetchSessionDetails(sessionId);
    if (
      details.status !== 'RUNNING' ||
      typeof details.connectUrl !== 'string' ||
      !details.connectUrl
    ) {
      throw new Error(
        `BrowserBase session is not active or does not have a connectUrl (status: ${this.errorMessage(details.status)})`
      );
    }
    const projectId = details.projectId;
    if (typeof projectId !== 'string' || !projectId) {
      throw new Error('BrowserBase session response is missing projectId');
    }
    return this.buildProviderSession(details.id, details.connectUrl, {
      debugUrl: details.debugUrl,
      projectId,
      status: details.status,
    });
  }

  /** Release a session by ID without opening a CDP connection; pending cleanup can be retried. */
  async releaseSession(sessionId: string): Promise<ProviderReleaseResult> {
    return this.release(sessionId, await this.resolveProjectId());
  }

  private buildProviderSession(
    sessionId: string,
    wsUrl: string,
    metadata: { debugUrl?: string; projectId: string; status?: string }
  ): ProviderSession {
    return {
      wsUrl,
      sessionId,
      metadata,
      close: () => this.release(sessionId, metadata.projectId),
    };
  }

  private headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = { 'X-BB-API-Key': this.apiKey };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
  }

  private errorMessage(error: unknown): string {
    // Redact before truncation so even a key crossing the excerpt boundary is removed.
    let message = errMsg(error);
    for (const secret of new Set([this.apiKey, encodeURIComponent(this.apiKey)])) {
      message = message.split(secret).join('[REDACTED]');
    }
    return excerpt(message);
  }

  private httpError(prefix: string, response: HttpResponse): Error {
    return new Error(`${prefix}: ${response.status} ${this.errorMessage(response.body)}`.trimEnd());
  }

  private async getWithRetry(url: string): Promise<HttpResponse> {
    try {
      return await fetchWithTimeout(url, { headers: this.headers(false) }, this.requestTimeoutMs);
    } catch {
      try {
        return await fetchWithTimeout(url, { headers: this.headers(false) }, this.requestTimeoutMs);
      } catch (error) {
        throw new Error(`BrowserBase request failed: network error (${this.errorMessage(error)})`);
      }
    }
  }

  private async fetchSessionDetails(sessionId: string): Promise<BrowserBaseSession> {
    const response = await this.getWithRetry(
      `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`
    );
    if (!response.ok) {
      throw this.httpError('BrowserBase getSession failed', response);
    }
    const session = parseSession(response);
    if (session.id !== sessionId) throw new Error('BrowserBase returned a different session ID');
    return session;
  }

  private async resolveProjectId(): Promise<string> {
    if (this.projectId) return this.projectId;
    if (!this.projectIdPromise) {
      this.projectIdPromise = this.fetchSingleProjectId()
        .then((id) => {
          this.projectId = id;
          return id;
        })
        .catch((error: unknown) => {
          this.projectIdPromise = null;
          throw error;
        });
    }
    return this.projectIdPromise;
  }

  private async fetchSingleProjectId(): Promise<string> {
    let response: HttpResponse;
    try {
      response = await fetchWithTimeout(
        `${this.baseUrl}/v1/projects`,
        { headers: this.headers(false) },
        this.requestTimeoutMs
      );
    } catch (error) {
      throw new Error(
        `BrowserBase listProjects failed: network error (${this.errorMessage(error)})`
      );
    }
    if (!response.ok) {
      throw this.httpError('BrowserBase listProjects failed', response);
    }
    const data = parseJson(response);
    if (!Array.isArray(data)) {
      throw new Error('BrowserBase listProjects: unexpected response shape');
    }
    const ids = data
      .filter(isRecord)
      .map((project) => project['id'])
      .filter((id): id is string => typeof id === 'string');
    if (ids.length === 0) {
      throw new Error(
        'BrowserBase: no projects found for this API key; specify projectId explicitly'
      );
    }
    if (ids.length > 1) {
      throw new Error(
        `BrowserBase: found ${ids.length} projects for this API key; specify projectId explicitly`
      );
    }
    const id = ids[0];
    if (!id) {
      throw new Error(
        'BrowserBase: no projects found for this API key; specify projectId explicitly'
      );
    }
    return id;
  }

  private release(sessionId: string, projectId: string): Promise<ProviderReleaseResult> {
    let pending = this.releaseResults.get(sessionId);
    if (!pending) {
      pending = this.doRelease(sessionId, projectId)
        .catch(
          (error: unknown): ProviderReleaseResult => ({
            status: 'cleanup_pending',
            sessionId,
            error: this.errorMessage(error),
          })
        )
        .then((result) => {
          if (result.status === 'cleanup_pending') this.releaseResults.delete(sessionId);
          return result;
        });
      this.releaseResults.set(sessionId, pending);
    }
    return pending;
  }

  private async doRelease(sessionId: string, projectId: string): Promise<ProviderReleaseResult> {
    const deadline = this.clock.now() + this.releaseTimeoutMs;
    const releaseResponse = await fetchWithTimeout(
      `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ projectId, status: 'REQUEST_RELEASE' }),
      },
      Math.min(this.requestTimeoutMs, this.releaseTimeoutMs)
    );
    if (this.clock.now() >= deadline) return { status: 'cleanup_pending', sessionId };
    if (releaseResponse.status === 404 || releaseResponse.status === 410) {
      return { status: 'already_released', sessionId };
    }
    if (!releaseResponse.ok) throw this.httpError('BrowserBase release failed', releaseResponse);
    return this.pollUntilTerminal(sessionId, deadline);
  }

  private async pollUntilTerminal(
    sessionId: string,
    deadline: number
  ): Promise<ProviderReleaseResult> {
    let providerStatus: string | undefined;
    for (;;) {
      const requestBudget = deadline - this.clock.now();
      if (requestBudget <= 0) break;
      const response = await fetchWithTimeout(
        `${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`,
        { headers: this.headers(false) },
        Math.min(this.requestTimeoutMs, requestBudget)
      );
      if (this.clock.now() >= deadline) break;
      if (response.status === 404 || response.status === 410) {
        return { status: 'already_released', sessionId };
      }
      if (!response.ok) throw this.httpError('BrowserBase release poll failed', response);
      const details = parseSession(response);
      if (this.clock.now() >= deadline) break;
      if (details.id !== sessionId) throw new Error('BrowserBase returned a different session ID');
      providerStatus = details.status;
      if (TERMINAL_STATUSES.has(providerStatus)) {
        return { status: 'released', sessionId, providerStatus };
      }
      const remaining = deadline - this.clock.now();
      if (remaining <= 0) break;
      await this.clock.sleep(Math.min(RELEASE_POLL_INTERVAL_MS, remaining));
    }
    return { status: 'cleanup_pending', sessionId, ...(providerStatus ? { providerStatus } : {}) };
  }
}
