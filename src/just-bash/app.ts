/**
 * Portable core of the `bp` just-bash command.
 *
 * Pure Web-standard APIs only: no node:*, no console, no timers, no
 * process.env. Credentials never enter this module — the trusted host's
 * SessionOwner resolves handles to WebSocket URLs per invocation, and error
 * messages are sanitized so a wsUrl can never leak to shell output.
 */

import type { ActionOptions, ActionReceipt, DispatchState } from '../browser/types.ts';
import type { ProviderReleaseResult } from '../providers/types.ts';
import { intFlag, type ParsedArgs, parseArgs } from './args.ts';
import { helpText } from './help.ts';
import { CapabilityError, type ExecutionContext, type SessionHandle } from './ports.ts';
import {
  type BpBrowser,
  BpError,
  type BpPage,
  type BpRunResult,
  type BrowserPilotCapabilities,
  type BrowserPilotJustBashPorts,
  EXIT,
  type JsonValue,
  usageError,
} from './types.ts';

export interface BpIo {
  /** Decoded UTF-8 stdin. */
  stdin: string;
  /** Read a UTF-8 text file from the shell VFS. */
  readFile(path: string): Promise<string>;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_MAX_ARTIFACT_BYTES = 10_485_760;
const PROVIDERS = ['browserbase', 'browserless', 'browser-use', 'generic'] as const;

const FLAGS = [
  '--handle-file',
  '--target',
  '--format',
  '--provider',
  '--width',
  '--height',
  '--out',
  '--img-format',
  '--input',
  '--origin',
  '--from-origins',
];
const SWITCHES = ['--help', '--json', '--full-page', '--confirm-mutation'];

const encoder = new TextEncoder();

function jsonLine(value: JsonValue | unknown): string {
  return `${JSON.stringify(value ?? null)}\n`;
}

/** Never let a resolved WebSocket URL (which may embed credentials) leak. */
function sanitize(message: string): string {
  return message
    .replace(/wss?:\/\/[^\s"'<>)\]]+/gi, '[redacted-ws-url]')
    .replace(/(api[-_]?key|token|secret|signature|sig)=[^\s&"']+/gi, '$1=[redacted]');
}

function errMsg(error: unknown): string {
  return sanitize(error instanceof Error ? error.message : String(error));
}

function requireCapability(
  capabilities: BrowserPilotCapabilities,
  capability: keyof BrowserPilotCapabilities
): void {
  if (!capabilities[capability]) {
    throw new BpError(
      'capability_denied',
      `Capability '${capability}' is not granted.`,
      EXIT.capability,
      {
        capability,
      }
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseHandle(text: string): SessionHandle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    usageError('Session handle must be valid JSON. Pass the exact output of `bp session open`.');
  }
  if (!isRecord(raw)) {
    usageError('Session handle is malformed. Pass the exact output of `bp session open`.');
  }
  const id = raw['id'];
  const generation = raw['generation'];
  const provider = raw['provider'];
  const leaseExpiresAt = raw['leaseExpiresAt'];
  const sessionId = raw['sessionId'];
  const MAX_FIELD_LEN = 256;
  if (
    typeof id !== 'string' ||
    typeof generation !== 'string' ||
    typeof provider !== 'string' ||
    (leaseExpiresAt !== undefined && typeof leaseExpiresAt !== 'number') ||
    (sessionId !== undefined && typeof sessionId !== 'string') ||
    id.length > MAX_FIELD_LEN ||
    generation.length > MAX_FIELD_LEN ||
    provider.length > MAX_FIELD_LEN ||
    (sessionId !== undefined && sessionId.length > MAX_FIELD_LEN)
  ) {
    usageError('Session handle is malformed. Pass the exact output of `bp session open`.');
  }

  return {
    id,
    generation,
    provider,
    ...(leaseExpiresAt !== undefined ? { leaseExpiresAt } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

/** Whitelist serialization: never let a host-supplied release result print
 * arbitrary/unsanitized fields (or a stray wsUrl/credential) to stdout. */
function releaseJson(released: ProviderReleaseResult): string {
  return jsonLine({
    status: released.status,
    sessionId: sanitize(released.sessionId),
    ...(released.providerStatus !== undefined
      ? { providerStatus: sanitize(released.providerStatus) }
      : {}),
    ...(released.error !== undefined ? { error: sanitize(released.error) } : {}),
  });
}

/** Whitelist serialization: a handle printed to stdout has only these fields. */
function handleJson(handle: SessionHandle): string {
  return jsonLine({
    id: handle.id,
    generation: handle.generation,
    provider: handle.provider,
    ...(handle.leaseExpiresAt !== undefined ? { leaseExpiresAt: handle.leaseExpiresAt } : {}),
    ...(handle.sessionId !== undefined ? { sessionId: handle.sessionId } : {}),
  });
}

async function handleFromArgs(
  parsed: ParsedArgs,
  positionals: string[],
  io: BpIo
): Promise<SessionHandle> {
  const file = parsed.flags.get('--handle-file');
  if (file !== undefined) {
    const text = file === '-' ? io.stdin : await readHandleFile(io, file);
    return parseHandle(text.trim());
  }
  const inline = positionals.shift();
  if (inline === undefined) {
    usageError('Missing session handle. Pass the handle JSON or --handle-file FILE.');
  }
  return parseHandle(inline);
}

function targetFromArgs(parsed: ParsedArgs): string | undefined {
  const target = parsed.flags.get('--target');
  if (target !== undefined && target.length === 0) {
    usageError('--target requires a non-empty target ID.');
  }
  return target;
}

async function readHandleFile(io: BpIo, path: string): Promise<string> {
  try {
    return await io.readFile(path);
  } catch {
    throw new BpError('input_file', `Cannot read handle file '${path}'.`, EXIT.usage);
  }
}

interface ContextCheckOptions {
  /** Session cleanup may be requested after its informational lease expires. */
  allowExpiredLease?: boolean;
  /** Cleanup may be allowed to run after the command deadline. */
  allowDeadline?: boolean;
  /** Cleanup may be allowed after cancellation so the owner can release state. */
  allowCancellation?: boolean;
}

function checkContext(
  ctx: ExecutionContext,
  handle?: SessionHandle,
  options: ContextCheckOptions = {}
): void {
  if (handle && handle.generation !== ctx.generation) {
    throw new BpError(
      'stale_generation',
      'Session handle belongs to a previous generation. Open a new session.',
      EXIT.usage,
      { capability: 'session', handleGeneration: handle.generation }
    );
  }
  if (
    !options.allowExpiredLease &&
    handle?.leaseExpiresAt !== undefined &&
    handle.leaseExpiresAt <= ctx.clock.now()
  ) {
    throw new BpError(
      'lease_expired',
      'Session lease has expired. Open a new session.',
      EXIT.usage,
      {
        capability: 'session',
        leaseExpiresAt: handle.leaseExpiresAt,
      }
    );
  }
  if (!options.allowDeadline && ctx.deadline !== undefined && ctx.clock.now() >= ctx.deadline) {
    throw new BpError(
      'deadline_exceeded',
      'Execution deadline exceeded before dispatch.',
      EXIT.deadline
    );
  }
  if (!options.allowCancellation && ctx.signal.aborted) {
    throw new BpError('cancelled', 'Cancelled before dispatch.', EXIT.cancelled, {
      dispatchState: 'not_dispatched',
    });
  }
}

async function withBrowser<T>(
  ports: BrowserPilotJustBashPorts,
  connect: (wsUrl: string, ctx: ExecutionContext) => Promise<BpBrowser>,
  handle: SessionHandle,
  ctx: ExecutionContext,
  targetId: string | undefined,
  fn: (browser: BpBrowser, page: () => Promise<BpPage>) => Promise<T>,
  completion: 'check' | 'preserve-receipt' = 'check'
): Promise<T> {
  let wsUrl: string;
  try {
    ({ wsUrl } = await ports.sessionOwner.resolve(handle, ctx));
  } catch (error) {
    // A host resolver may take long enough for the command to expire. Report
    // the admission failure rather than proceeding with a later connection or
    // action based on an already-expired context.
    checkContext(ctx, handle);
    throw toBpError(error, 'resolve_failed', 'Session resolve failed');
  }
  checkContext(ctx, handle);

  let browser: BpBrowser;
  try {
    browser = await connect(wsUrl, ctx);
  } catch (error) {
    checkContext(ctx, handle);
    throw toBpError(error, 'connect_failed', 'Browser connect failed');
  }
  try {
    // Custom connect functions are extension points and may not inspect the
    // context themselves, so admit the connected browser before any lookup.
    checkContext(ctx, handle);
    let page: BpPage | undefined;
    const result = await fn(browser, async () => {
      if (page === undefined) {
        checkContext(ctx, handle);
        page = await browser.page(targetId === undefined ? undefined : { targetId });
        checkContext(ctx, handle);
      }
      return page;
    });
    if (completion === 'check') checkCompletion(ctx);
    return result;
  } catch (error) {
    if (completion === 'check') checkCompletion(ctx);
    throw error;
  } finally {
    // Disconnect only. Closing would release the provider session, which is
    // exclusively the SessionOwner's job via `bp session close`.
    await browser.disconnect().catch(() => {});
  }
}

function toBpError(error: unknown, code: string, prefix?: string): BpError {
  if (error instanceof BpError) return error;
  if (error instanceof CapabilityError) {
    if (error.capability === 'stale_handle' || error.capability === 'lease_expired') {
      return new BpError(error.capability, errMsg(error), EXIT.usage);
    }
    if (error.capability === 'deadline') {
      return new BpError('deadline_exceeded', errMsg(error), EXIT.deadline);
    }
    return new BpError('capability_denied', errMsg(error), EXIT.capability, {
      capability: error.capability,
    });
  }
  return new BpError(code, prefix ? `${prefix}: ${errMsg(error)}` : errMsg(error), EXIT.runtime);
}

interface ActionOutcome {
  action: string;
  target: string;
  result?: unknown;
  receipt?: ActionReceipt;
  dispatchState?: DispatchState;
  retrySafe?: boolean;
  urlBefore?: string;
  urlAfter?: string;
  [k: string]: unknown;
}

/**
 * Keep the action adapter at the Page boundary. Page owns the dispatch
 * protocol and records an ActionReceipt; the shell only serializes that
 * receipt and the boolean return value. URL reads are diagnostics and never
 * participate in dispatch classification.
 */
async function runPageAction(
  page: BpPage,
  ctx: ExecutionContext,
  action: string,
  target: string,
  fn: () => Promise<unknown>
): Promise<ActionOutcome> {
  assertActionAdmission(ctx, action, target);
  page.resetLastActionReceipt?.();
  const urlBefore = await page.url().catch(() => undefined);
  // URL lookup above is best-effort metadata only. Re-admit immediately before
  // invoking the public action so a deadline/cancellation during the lookup
  // cannot cross the effect boundary.
  assertActionAdmission(ctx, action, target);

  try {
    const result = await fn();
    const receipt = getActionReceipt(page);
    const fallback = fallbackActionState(result, ctx);
    const dispatchState = receipt?.dispatchState ?? fallback.dispatchState;
    const retrySafe = receipt?.retrySafe ?? fallback.retrySafe;
    const outcome: ActionOutcome = {
      action,
      target,
      ...(result !== undefined ? { result } : {}),
      ...(receipt ? { receipt } : {}),
      dispatchState,
      retrySafe,
      ...(urlBefore !== undefined ? { urlBefore } : {}),
    };

    // Do not perform post-action reads once cancellation/deadline has fired.
    // The receipt remains the source of truth even when URL observation is
    // unavailable.
    if (!contextExpired(ctx)) {
      const urlAfter = await page.url().catch(() => undefined);
      if (urlAfter !== undefined) outcome.urlAfter = urlAfter;
    }
    return outcome;
  } catch (error) {
    const receipt = getActionReceipt(page);
    const fallback = { dispatchState: 'uncertain' as const, retrySafe: false };
    const dispatchState = receipt?.dispatchState ?? fallback.dispatchState;
    const details: Record<string, JsonValue> = { action, target };
    if (dispatchState !== undefined) details['dispatchState'] = dispatchState;
    if (receipt) {
      // `ActionReceipt`'s optional fields (e.g. a function-valued
      // `ReadyCondition.predicate` nested under `staleRecovery`) aren't
      // structurally JsonValue-compatible even though every field we
      // actually populate here is JSON-safe at runtime; a double cast
      // documents that gap rather than hiding a real type error.
      details['receipt'] = receipt as unknown as JsonValue;
      details['retrySafe'] = receipt.retrySafe;
    } else {
      details['retrySafe'] = fallback.retrySafe;
    }
    if (urlBefore !== undefined) details['urlBefore'] = urlBefore;
    const cancelled = ctx.signal.aborted;
    const deadline = !cancelled && deadlineElapsed(ctx);
    throw new BpError(
      cancelled ? 'cancelled' : deadline ? 'deadline_exceeded' : 'action_failed',
      cancelled
        ? 'Cancelled after dispatch; outcome is reported by the Page receipt. Not retried.'
        : deadline
          ? 'Execution deadline exceeded after dispatch. Outcome is reported by the Page receipt.'
          : errMsg(error),
      cancelled ? EXIT.cancelled : deadline ? EXIT.deadline : EXIT.runtime,
      details
    );
  }
}

function fallbackActionState(
  result: unknown,
  ctx: ExecutionContext
): { dispatchState: DispatchState; retrySafe: boolean } {
  if (result === false) return { dispatchState: 'not_dispatched', retrySafe: true };
  if (contextExpired(ctx)) return { dispatchState: 'uncertain', retrySafe: false };
  return { dispatchState: 'dispatched', retrySafe: false };
}

function deadlineElapsed(ctx: ExecutionContext): boolean {
  return ctx.deadline !== undefined && ctx.clock.now() >= ctx.deadline;
}

function contextExpired(ctx: ExecutionContext): boolean {
  return ctx.signal.aborted || deadlineElapsed(ctx);
}

/** Preserve Page defaults when there is no host deadline. */
function actionOptions(ctx: ExecutionContext): ActionOptions {
  return ctx.deadline === undefined ? {} : { timeout: Math.max(1, ctx.deadline - ctx.clock.now()) };
}

/** A completed call may have had effects; never describe it as undispatched. */
function checkCompletion(ctx: ExecutionContext): void {
  if (ctx.signal.aborted) {
    throw new BpError('cancelled', 'Cancelled before command completion.', EXIT.cancelled, {
      retrySafe: false,
    });
  }
  if (deadlineElapsed(ctx)) {
    throw new BpError(
      'deadline_exceeded',
      'Execution deadline exceeded before command completion.',
      EXIT.deadline,
      { retrySafe: false }
    );
  }
}

function getActionReceipt(page: BpPage): ActionReceipt | undefined {
  try {
    return page.getLastActionReceipt?.();
  } catch {
    return undefined;
  }
}

/** Admission check used at the final boundary before a Page effect. */
function assertActionAdmission(ctx: ExecutionContext, action: string, target: string): void {
  if (ctx.signal.aborted) {
    throw new BpError('cancelled', 'Cancelled before dispatch.', EXIT.cancelled, {
      action,
      target,
      dispatchState: 'not_dispatched',
    });
  }
  if (deadlineElapsed(ctx)) {
    throw new BpError(
      'deadline_exceeded',
      'Execution deadline exceeded before dispatch.',
      EXIT.deadline,
      { action, target, dispatchState: 'not_dispatched' }
    );
  }
}

/** Keep shell streams intact. A hard cap is an error, never a partial JSON result. */
function limitOutput(result: BpRunResult, maxBytes: number): BpRunResult {
  if (
    encoder.encode(result.stdout).byteLength <= maxBytes &&
    encoder.encode(result.stderr).byteLength <= maxBytes
  )
    return result;
  return {
    stdout: '',
    stderr: jsonLine({ error: 'output_limit' }),
    exitCode: result.exitCode || EXIT.runtime,
  };
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function runBp(
  argv: string[],
  io: BpIo,
  ports: BrowserPilotJustBashPorts,
  connect: (wsUrl: string, ctx: ExecutionContext) => Promise<BpBrowser>
): Promise<BpRunResult> {
  const maxOutput = ports.limits?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutput) || maxOutput < 32) {
    throw new RangeError('limits.maxOutputBytes must be an integer of at least 32 bytes.');
  }
  try {
    return limitOutput(await dispatch(argv, io, ports, connect), maxOutput);
  } catch (error) {
    const failure = toBpError(error, 'runtime_error');
    return limitOutput(
      {
        stdout: '',
        stderr: jsonLine({ error: failure.code, message: failure.message, ...failure.details }),
        exitCode: failure.exitCode,
      },
      maxOutput
    );
  }
}

async function dispatch(
  argv: string[],
  io: BpIo,
  ports: BrowserPilotJustBashPorts,
  connect: (wsUrl: string, ctx: ExecutionContext) => Promise<BpBrowser>
): Promise<BpRunResult> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    const topic = argv[0] === 'help' ? argv.slice(1).join(' ') : '';
    return { stdout: helpText(topic || undefined), stderr: '', exitCode: EXIT.ok };
  }

  let command = argv[0] ?? '';
  let rest = argv.slice(1);
  if (
    (command === 'session' || command === 'webmcp') &&
    rest.length > 0 &&
    !rest[0]?.startsWith('-')
  ) {
    command = `${command} ${rest[0]}`;
    rest = rest.slice(1);
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    return { stdout: helpText(command), stderr: '', exitCode: EXIT.ok };
  }

  const parsed = parseArgs(rest, { flags: FLAGS, switches: SWITCHES });
  const format = parsed.flags.get('--format') ?? 'json';
  if (format !== 'json' && format !== 'text') usageError("--format must be 'json' or 'text'.");
  const positionals = [...parsed.positionals];
  const caps = ports.capabilities;

  switch (command) {
    case 'session open': {
      requireCapability(caps, 'read');
      const provider = parsed.flags.get('--provider') ?? 'browserbase';
      if (!(PROVIDERS as readonly string[]).includes(provider)) {
        usageError(`--provider must be one of: ${PROVIDERS.join(', ')}.`);
      }
      const width = intFlag(parsed.flags.get('--width'), 0, '--width', 0, 10_000);
      const height = intFlag(parsed.flags.get('--height'), 0, '--height', 0, 10_000);
      const ctx = ports.createContext();
      checkContext(ctx);
      const handle = await ports.sessionOwner
        .open(
          {
            provider: provider as (typeof PROVIDERS)[number],
            ...(width || height
              ? { session: { ...(width ? { width } : {}), ...(height ? { height } : {}) } }
              : {}),
          },
          ctx
        )
        .catch((error: unknown) => {
          throw toBpError(error, 'open_failed', 'Session open failed');
        });
      return { stdout: handleJson(handle), stderr: '', exitCode: EXIT.ok };
    }

    case 'session close': {
      requireCapability(caps, 'read');
      const handle = await handleFromArgs(parsed, positionals, io);
      const ctx = ports.createContext();
      // Lease expiry is informational for cleanup. Keep generation fencing,
      // then let the SessionOwner decide whether release is still valid.
      checkContext(ctx, handle, {
        allowExpiredLease: true,
        allowDeadline: true,
        allowCancellation: true,
      });
      const released = await ports.sessionOwner.release(handle, ctx).catch((error: unknown) => {
        throw toBpError(error, 'release_failed', 'Session release failed');
      });
      return {
        stdout: releaseJson(released),
        stderr: '',
        exitCode: released.status === 'cleanup_pending' ? EXIT.runtime : EXIT.ok,
      };
    }

    case 'session touch': {
      requireCapability(caps, 'read');
      const handle = await handleFromArgs(parsed, positionals, io);
      const ctx = ports.createContext();
      checkContext(ctx, handle);
      const touch = ports.sessionOwner.touch?.bind(ports.sessionOwner);
      if (!touch) {
        throw new BpError('unsupported', 'This host does not support session touch.', EXIT.runtime);
      }
      const refreshed = await touch(handle, ctx).catch((error: unknown) => {
        throw toBpError(error, 'touch_failed', 'Session touch failed');
      });
      return { stdout: handleJson(refreshed), stderr: '', exitCode: EXIT.ok };
    }

    case 'goto': {
      requireCapability(caps, 'read');
      const handle = await handleFromArgs(parsed, positionals, io);
      const url = positionals.shift();
      if (!url) usageError('Usage: bp goto <handle> <url>');
      const targetId = targetFromArgs(parsed);
      const ctx = ports.createContext();
      checkContext(ctx, handle);
      const out = await withBrowser(
        ports,
        connect,
        handle,
        ctx,
        targetId,
        async (_browser, getPage) => {
          const page = await getPage();
          checkContext(ctx, handle);
          await page.goto(url, actionOptions(ctx));
          checkCompletion(ctx);
          const [finalUrl, title] = await Promise.all([page.url(), page.title()]);
          return { ok: true, url: finalUrl, title };
        }
      );
      return { stdout: jsonLine(out), stderr: '', exitCode: EXIT.ok };
    }

    case 'tabs': {
      requireCapability(caps, 'read');
      const handle = await handleFromArgs(parsed, positionals, io);
      const ctx = ports.createContext();
      checkContext(ctx, handle);
      const targets = await withBrowser(ports, connect, handle, ctx, undefined, async (browser) => {
        checkContext(ctx, handle);
        return browser.listTargets();
      });
      if (format === 'text') {
        const lines = targets.map((t) => `${t.targetId}\t${t.type}\t${t.url}\t${t.title}`);
        return {
          stdout: lines.length ? `${lines.join('\n')}\n` : '',
          stderr: '',
          exitCode: EXIT.ok,
        };
      }
      return { stdout: jsonLine({ targets }), stderr: '', exitCode: EXIT.ok };
    }

    case 'inspect': {
      requireCapability(caps, 'read');
      const handle = await handleFromArgs(parsed, positionals, io);
      const targetId = targetFromArgs(parsed);
      const ctx = ports.createContext();
      checkContext(ctx, handle);
      const snapshot = await withBrowser(
        ports,
        connect,
        handle,
        ctx,
        targetId,
        async (_browser, getPage) => {
          const page = await getPage();
          checkContext(ctx, handle);
          return page.snapshot();
        }
      );
      return { stdout: jsonLine(snapshot), stderr: '', exitCode: EXIT.ok };
    }

    case 'text': {
      requireCapability(caps, 'read');
      const handle = await handleFromArgs(parsed, positionals, io);
      const selector = positionals.shift();
      const targetId = targetFromArgs(parsed);
      const ctx = ports.createContext();
      checkContext(ctx, handle);
      const text = await withBrowser(
        ports,
        connect,
        handle,
        ctx,
        targetId,
        async (_browser, getPage) => {
          const page = await getPage();
          checkContext(ctx, handle);
          return page.text(selector);
        }
      );
      if (format === 'text') {
        return { stdout: text.endsWith('\n') ? text : `${text}\n`, stderr: '', exitCode: EXIT.ok };
      }
      return { stdout: jsonLine({ text }), stderr: '', exitCode: EXIT.ok };
    }

    case 'screenshot': {
      requireCapability(caps, 'read');
      const sink = ports.artifacts;
      if (!sink) {
        throw new BpError(
          'capability_denied',
          'No artifact sink is configured; screenshot output is unavailable.',
          EXIT.capability,
          { capability: 'artifacts' }
        );
      }
      const handle = await handleFromArgs(parsed, positionals, io);
      const out = parsed.flags.get('--out');
      if (!out) usageError('screenshot requires --out PATH. Binary output cannot go to stdout.');
      const imgFormat = parsed.flags.get('--img-format') ?? 'png';
      if (!['png', 'jpeg', 'webp'].includes(imgFormat)) {
        usageError('--img-format must be png, jpeg, or webp.');
      }
      const targetId = targetFromArgs(parsed);
      const ctx = ports.createContext();
      checkContext(ctx, handle);
      const receipt = await withBrowser(
        ports,
        connect,
        handle,
        ctx,
        targetId,
        async (_browser, getPage) => {
          const page = await getPage();
          checkContext(ctx, handle);
          const base64 = await page.screenshot({
            format: imgFormat as 'png' | 'jpeg' | 'webp',
            fullPage: parsed.switches.has('--full-page'),
          });
          checkContext(ctx, handle);
          const bytes = base64ToBytes(base64);
          const maxArtifact = ports.limits?.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
          if (bytes.byteLength > maxArtifact) {
            throw new BpError(
              'artifact_too_large',
              `Screenshot is ${bytes.byteLength} bytes; the limit is ${maxArtifact}. No artifact was saved.`,
              EXIT.runtime
            );
          }
          const type = `image/${imgFormat}`;
          checkContext(ctx, handle);
          const result = await sink.put(bytes, { path: out, type, ctx });
          if (result.status === 'written') {
            return {
              status: result.status,
              ref: result.ref,
              hash: result.hash,
              size: result.size,
              path: result.path,
              type,
            };
          }
          if (result.status === 'write_pending_after_deadline') {
            return {
              status: result.status,
              ref: result.ref,
              path: result.path,
              size: bytes.byteLength,
              error: sanitize(result.error),
            };
          }
          return {
            status: result.status,
            path: result.path,
            size: bytes.byteLength,
            dispatched: result.dispatched,
            error: sanitize(result.error),
          };
        },
        'preserve-receipt'
      );
      const exitCode =
        receipt.status === 'write_pending_after_deadline'
          ? ctx.signal.aborted
            ? EXIT.cancelled
            : EXIT.deadline
          : receipt.status === 'failed'
            ? EXIT.runtime
            : EXIT.ok;
      return { stdout: jsonLine(receipt), stderr: '', exitCode };
    }

    case 'eval': {
      requireCapability(caps, 'evaluate');
      const handle = await handleFromArgs(parsed, positionals, io);
      const expression = positionals.join(' ');
      if (!expression) usageError('Usage: bp eval <handle> <js-expression>');
      const targetId = targetFromArgs(parsed);
      const ctx = ports.createContext();
      checkContext(ctx, handle);
      const result = await withBrowser(
        ports,
        connect,
        handle,
        ctx,
        targetId,
        async (_browser, getPage) => {
          const page = await getPage();
          checkContext(ctx, handle);
          return page.evaluate(expression);
        }
      );
      return {
        stdout: jsonLine({ result: result === undefined ? null : result }),
        stderr: '',
        exitCode: EXIT.ok,
      };
    }

    case 'click':
    case 'type':
    case 'press': {
      requireCapability(caps, 'action');
      const handle = await handleFromArgs(parsed, positionals, io);
      const targetId = targetFromArgs(parsed);
      const ctx = ports.createContext();
      checkContext(ctx, handle);
      const outcome = await withBrowser(
        ports,
        connect,
        handle,
        ctx,
        targetId,
        async (_browser, getPage) => {
          const page = await getPage();
          if (command === 'click') {
            const selector = positionals.shift();
            if (!selector) usageError('Usage: bp click <handle> <selector>');
            return runPageAction(page, ctx, 'click', selector, () =>
              page.click(selector, actionOptions(ctx))
            );
          }
          if (command === 'type') {
            const selector = positionals.shift();
            const textArg = positionals.shift();
            if (!selector || textArg === undefined)
              usageError('Usage: bp type <handle> <selector> <text>');
            return runPageAction(page, ctx, 'type', selector, () =>
              page.type(selector, textArg, actionOptions(ctx))
            );
          }
          const key = positionals.shift();
          if (!key) usageError('Usage: bp press <handle> <key>');
          return runPageAction(page, ctx, 'press', key, () => page.press(key));
        },
        'preserve-receipt'
      );
      const exitCode = ctx.signal.aborted
        ? EXIT.cancelled
        : deadlineElapsed(ctx)
          ? EXIT.deadline
          : outcome.result === false ||
              outcome.dispatchState === 'uncertain' ||
              outcome.dispatchState === 'not_dispatched'
            ? EXIT.runtime
            : EXIT.ok;
      return { stdout: jsonLine(outcome), stderr: '', exitCode };
    }

    case 'webmcp list': {
      requireCapability(caps, 'webmcp');
      const handle = await handleFromArgs(parsed, positionals, io);
      const targetId = targetFromArgs(parsed);
      const fromOrigins = (parsed.flags.get('--from-origins') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const ctx = ports.createContext();
      checkContext(ctx, handle);
      const listed = await withBrowser(
        ports,
        connect,
        handle,
        ctx,
        targetId,
        async (_browser, getPage) => {
          const page = await getPage();
          checkContext(ctx, handle);
          return page.webmcpList(fromOrigins);
        }
      );
      return { stdout: jsonLine(listed), stderr: '', exitCode: EXIT.ok };
    }

    case 'webmcp call': {
      requireCapability(caps, 'webmcp');
      const handle = await handleFromArgs(parsed, positionals, io);
      const tool = positionals.shift();
      if (!tool) usageError('Usage: bp webmcp call <handle> <tool> [--input JSON|-]');
      const targetId = targetFromArgs(parsed);
      const inputFlag = parsed.flags.get('--input');
      let input: unknown;
      if (inputFlag !== undefined) {
        const text = inputFlag === '-' ? io.stdin : inputFlag;
        try {
          input = JSON.parse(text);
        } catch {
          usageError('--input must be valid JSON (or - to read JSON from stdin).');
        }
      }
      const ctx = ports.createContext();
      checkContext(ctx, handle);
      const result = await withBrowser(
        ports,
        connect,
        handle,
        ctx,
        targetId,
        async (_browser, getPage) => {
          const page = await getPage();
          checkContext(ctx, handle);
          return page.webmcpCall(tool, input, {
            origin: parsed.flags.get('--origin'),
            allowMutation: parsed.switches.has('--confirm-mutation'),
            signal: ctx.signal,
          });
        }
      );
      return { stdout: jsonLine({ tool, result }), stderr: '', exitCode: EXIT.ok };
    }

    default:
      usageError(`Unknown bp command '${command}'. Run bp --help to list commands.`);
  }
}
