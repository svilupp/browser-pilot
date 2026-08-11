/**
 * Emit - inject messages into a page's own message flow.
 *
 * The inverse of `bp listen`: where listen observes frames, emit produces them.
 * Currently supports the `ws` channel, sending on a WebSocket the page itself
 * opened, so the message travels the app's real connection with its real
 * headers, cookies, and session token.
 *
 * Sockets are located by sweeping the JS heap for live `WebSocket` instances
 * (`Runtime.queryObjects`) rather than by patching `WebSocket.prototype.send`.
 * Patching only catches sockets created after injection, and apps that bind
 * `send` at construction bypass the patch entirely; a heap sweep sees both, and
 * needs no page reload (which would destroy the session under test).
 */

import type { CDPClient } from '../cdp/client.ts';
import { globToRegex } from '../utils/strings.ts';

/** Where a socket lives, relative to the page. */
export type EmitRealmKind = 'main' | 'frame' | 'worker';

/**
 * A CDP session to sweep for sockets. Same-origin frames inside it are
 * discovered automatically, so callers only supply session roots: the page
 * itself, its OOPIF child sessions, and its workers.
 */
export interface EmitRealm {
  kind: EmitRealmKind;
  /** Flat CDP session for OOPIFs and workers (omitted = page session). */
  sessionId?: string;
  /** Human-readable realm label for diagnostics. */
  label?: string;
}

/** A live WebSocket discovered in the page. */
export interface SocketCandidate {
  url: string;
  /** 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED */
  readyState: number;
  realm: EmitRealmKind;
  /** Realm label, e.g. "worker:blob:https://..." */
  realmLabel?: string;
}

/** Outcome of an emit. */
export interface EmitResult {
  /**
   * True only when the dispatched frame was confirmed by a
   * `Network.webSocketFrameSent` event. A WebSocket `send()` on a closed socket
   * does NOT throw - it silently discards the data - so a normal return is not
   * evidence of delivery.
   */
  delivered: boolean;
  /** URL of the socket the frame was dispatched on. */
  socketUrl: string;
  realm: EmitRealmKind;
  /** Set when `delivered` is false, explaining what is uncertain. */
  reason?: 'dispatched-unconfirmed';
  /** Every socket seen during resolution, for diagnostics. */
  candidates: SocketCandidate[];
  /** Correlated reply, when `awaitReply` was requested. */
  reply?: EmitReply;
}

/** A frame received after an emit, matched by `awaitReply`. */
export interface EmitReply {
  payload: string;
  /** Milliseconds between dispatch and the matching reply. */
  latencyMs: number;
}

/** How to match a reply frame. */
export interface AwaitReplyOptions {
  /** Glob matched against the frame payload (default: everything). */
  match?: string;
  /** Field equality, dot paths against the parsed JSON payload. */
  where?: Record<string, unknown>;
  /** Milliseconds to wait before giving up (default 10000). */
  timeout?: number;
}

export interface EmitWsOptions {
  /** URL glob selecting the socket when the page has more than one. */
  match?: string;
  /** Treat the payload as base64 and send it as a binary frame. */
  base64?: boolean;
  /** Wait for a correlated reply frame. */
  awaitReply?: AwaitReplyOptions;
  /** Milliseconds to wait for send confirmation (default 1000). */
  confirmTimeout?: number;
}

/** Raised when socket resolution cannot pick exactly one target. */
export class EmitTargetError extends Error {
  constructor(
    message: string,
    public readonly candidates: SocketCandidate[]
  ) {
    super(message);
    this.name = 'EmitTargetError';
  }
}

const DEFAULT_CONFIRM_TIMEOUT = 1000;
const DEFAULT_REPLY_TIMEOUT = 10_000;

/** One JS realm's live sockets, with the handle needed to send on them. */
interface SweptRealm {
  arrayObjectId: string;
  kind: EmitRealmKind;
  label: string;
  sessionId?: string;
  candidates: SocketCandidate[];
}

/**
 * `Runtime.queryObjects` searches the heap of the context that OWNS the
 * prototype object id - not the realm the prototype logically belongs to. A
 * prototype reached from the parent (`window[0].WebSocket.prototype`) is owned
 * by the parent context and finds none of the frame's sockets, so each realm's
 * prototype must be obtained from an object that realm itself owns.
 */
async function collectFromPrototype(
  cdp: CDPClient,
  realm: EmitRealm,
  prototypeObjectId: string,
  kind: EmitRealmKind,
  label: string
): Promise<SweptRealm | undefined> {
  const objects = await cdp.send<{ objects?: { objectId?: string } }>(
    'Runtime.queryObjects',
    { prototypeObjectId },
    realm.sessionId
  );
  if (!objects.objects?.objectId) return undefined;

  const listed = await cdp.send<{ result: { value?: string } }>(
    'Runtime.callFunctionOn',
    {
      objectId: objects.objects.objectId,
      functionDeclaration:
        'function () { return JSON.stringify(this.map((s) => ({ url: s.url, readyState: s.readyState }))) }',
      returnByValue: true,
    },
    realm.sessionId
  );

  const raw = JSON.parse(listed.result?.value ?? '[]') as Array<{
    url: string;
    readyState: number;
  }>;

  return {
    arrayObjectId: objects.objects.objectId,
    kind,
    label,
    ...(realm.sessionId ? { sessionId: realm.sessionId } : {}),
    candidates: raw.map((s) => ({
      url: s.url,
      readyState: s.readyState,
      realm: kind,
      realmLabel: label,
    })),
  };
}

/** Every frame in this session except the root, depth-first. */
async function listChildFrames(
  cdp: CDPClient,
  sessionId?: string
): Promise<Array<{ id: string; url: string }>> {
  interface FrameNode {
    frame: { id: string; url: string };
    childFrames?: FrameNode[];
  }
  try {
    const tree = await cdp.send<{ frameTree: FrameNode }>('Page.getFrameTree', {}, sessionId);
    const frames: Array<{ id: string; url: string }> = [];
    const walk = (node: FrameNode) => {
      for (const child of node.childFrames ?? []) {
        frames.push({ id: child.frame.id, url: child.frame.url });
        walk(child);
      }
    };
    walk(tree.frameTree);
    return frames;
  } catch {
    // Workers have no frame tree.
    return [];
  }
}

/**
 * Get a same-origin frame's `WebSocket.prototype` through its own document.
 *
 * `DOM.resolveNode` on the frame's contentDocument returns an object owned by
 * the FRAME's context, which is what makes the subsequent queryObjects search
 * the frame's heap. Frames are found through the frame tree rather than
 * execution-context events, because Chrome replays those only on a
 * connection's first `Runtime.enable` - a long-lived daemon connection
 * attaching to an already-loaded page would otherwise see no frames at all.
 */
async function frameWebSocketPrototype(
  cdp: CDPClient,
  frameId: string,
  sessionId?: string
): Promise<string | undefined> {
  try {
    const owner = await cdp.send<{ backendNodeId?: number }>(
      'DOM.getFrameOwner',
      { frameId },
      sessionId
    );
    if (!owner.backendNodeId) return undefined;

    const described = await cdp.send<{
      node?: { contentDocument?: { backendNodeId?: number } };
    }>(
      'DOM.describeNode',
      { backendNodeId: owner.backendNodeId, depth: 1, pierce: true },
      sessionId
    );

    // Cross-origin frames expose no contentDocument here; they are swept
    // through their own OOPIF session instead.
    const documentNodeId = described.node?.contentDocument?.backendNodeId;
    if (!documentNodeId) return undefined;

    const resolved = await cdp.send<{ object?: { objectId?: string } }>(
      'DOM.resolveNode',
      { backendNodeId: documentNodeId },
      sessionId
    );
    if (!resolved.object?.objectId) return undefined;

    const proto = await cdp.send<{ result: { objectId?: string } }>(
      'Runtime.callFunctionOn',
      {
        objectId: resolved.object.objectId,
        functionDeclaration:
          'function () { return this.defaultView ? this.defaultView.WebSocket.prototype : null }',
      },
      sessionId
    );
    return proto.result?.objectId;
  } catch {
    return undefined;
  }
}

/** Sweep one CDP session: its own global, then each same-origin frame in it. */
async function sweepSession(cdp: CDPClient, realm: EmitRealm): Promise<SweptRealm[]> {
  const swept: SweptRealm[] = [];

  try {
    const proto = await cdp.send<{ result: { objectId?: string } }>(
      'Runtime.evaluate',
      { expression: 'typeof WebSocket === "function" ? WebSocket.prototype : null' },
      realm.sessionId
    );
    if (proto.result?.objectId) {
      const own = await collectFromPrototype(
        cdp,
        realm,
        proto.result.objectId,
        realm.kind,
        realm.label ?? realm.kind
      );
      if (own) swept.push(own);
    }
  } catch {
    // A session can die mid-sweep (navigation, worker exit). It contributes
    // nothing rather than failing the whole command.
  }

  for (const frame of await listChildFrames(cdp, realm.sessionId)) {
    const prototypeObjectId = await frameWebSocketPrototype(cdp, frame.id, realm.sessionId);
    if (!prototypeObjectId) continue;
    try {
      const collected = await collectFromPrototype(
        cdp,
        realm,
        prototypeObjectId,
        'frame',
        `frame:${frame.url}`
      );
      if (collected) swept.push(collected);
    } catch {
      // Skip frames that navigate away mid-sweep.
    }
  }

  return swept;
}

/** Enumerate every live socket the page can reach, across all realms. */
export async function listSockets(cdp: CDPClient, realms: EmitRealm[]): Promise<SocketCandidate[]> {
  const all: SocketCandidate[] = [];
  for (const realm of realms) {
    for (const swept of await sweepSession(cdp, realm)) {
      all.push(...swept.candidates);
    }
  }
  return all;
}

function selectSocket(candidates: SocketCandidate[], match: string | undefined): SocketCandidate {
  const open = candidates.filter((c) => c.readyState === 1);
  const regex = match ? globToRegex(match.includes('*') ? match : `*${match}*`) : undefined;
  const matched = regex ? open.filter((c) => regex.test(c.url)) : open;

  if (matched.length === 1) return matched[0]!;

  if (matched.length === 0) {
    const detail = candidates.length
      ? `Found ${candidates.length} socket(s), none open and matching: ${describe(candidates)}`
      : 'The page has no WebSocket connections.';
    throw new EmitTargetError(`No open WebSocket to emit on. ${detail}`, candidates);
  }

  throw new EmitTargetError(
    `Ambiguous emit target: ${matched.length} open sockets match. ` +
      `Narrow it with --match. Candidates: ${describe(matched)}`,
    candidates
  );
}

function describe(candidates: SocketCandidate[]): string {
  return candidates
    .map((c) => `${c.url} (readyState=${c.readyState}, realm=${c.realmLabel ?? c.realm})`)
    .join('; ');
}

/**
 * Send a message on a socket the page already owns.
 *
 * Delivery is confirmed against `Network.webSocketFrameSent` rather than
 * inferred from a clean return - see {@link EmitResult.delivered}.
 */
export async function emitWsMessage(
  cdp: CDPClient,
  realms: EmitRealm[],
  payload: string,
  options: EmitWsOptions = {}
): Promise<EmitResult> {
  // Never cache a sweep: object ids are invalidated by navigation, and a
  // socket's readyState can change between two commands.
  const sweeps: SweptRealm[] = [];
  for (const realm of realms) {
    sweeps.push(...(await sweepSession(cdp, realm)));
  }
  const candidates = sweeps.flatMap((s) => s.candidates);
  const target = selectSocket(candidates, options.match);
  const owner = sweeps.find((s) =>
    s.candidates.some((c) => c.url === target.url && c.readyState === 1)
  );
  if (!owner) {
    throw new EmitTargetError('Socket vanished between discovery and send.', candidates);
  }

  await cdp.send('Network.enable', {}, owner.sessionId).catch(() => undefined);

  // Frame events for a worker or OOPIF socket are delivered on that target's
  // own session, so the watchers must listen where the socket actually lives.
  const confirmation = watchForSentFrame(cdp, payload, options.base64 === true, owner.sessionId);
  const replyWatch = options.awaitReply
    ? watchForReply(cdp, options.awaitReply, owner.sessionId)
    : undefined;

  const dispatch = await cdp.send<{
    result: { value?: string };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  }>(
    'Runtime.callFunctionOn',
    {
      objectId: owner.arrayObjectId,
      // readyState is re-checked inside the page, atomically with the send:
      // between our sweep and this call the socket may have closed, and a send
      // on a closed socket is silently discarded rather than throwing.
      functionDeclaration: `function (payload, url, isBinary) {
        const socket = this.find((s) => s.url === url && s.readyState === 1);
        if (!socket) return JSON.stringify({ ok: false, reason: 'closed-before-send' });
        const body = isBinary
          ? Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
          : payload;
        socket.send(body);
        return JSON.stringify({ ok: true, bufferedAmount: socket.bufferedAmount });
      }`,
      arguments: [{ value: payload }, { value: target.url }, { value: options.base64 === true }],
      returnByValue: true,
    },
    owner.sessionId
  );

  if (dispatch.exceptionDetails) {
    confirmation.cancel();
    replyWatch?.cancel();
    const description =
      dispatch.exceptionDetails.exception?.description ??
      dispatch.exceptionDetails.text ??
      'unknown error';
    throw new Error(`WebSocket send failed: ${description}`);
  }

  const outcome = JSON.parse(dispatch.result?.value ?? '{}') as {
    ok?: boolean;
    reason?: string;
  };
  if (!outcome.ok) {
    confirmation.cancel();
    replyWatch?.cancel();
    throw new EmitTargetError(
      `Socket closed before the frame could be sent (${outcome.reason ?? 'unknown'}).`,
      candidates
    );
  }

  const sentOutcome = await confirmation.settled(options.confirmTimeout ?? DEFAULT_CONFIRM_TIMEOUT);
  const delivered = sentOutcome.seen;
  const result: EmitResult = {
    delivered,
    socketUrl: target.url,
    realm: target.realm,
    candidates,
    ...(delivered ? {} : { reason: 'dispatched-unconfirmed' as const }),
  };

  if (replyWatch) {
    // Only a frame carrying the confirmed frame's own CDP requestId - i.e.
    // from the exact connection we sent on - can satisfy the wait. Without a
    // confirmed requestId (unconfirmed send) there is nothing to correlate
    // against, so no reply can be attributed to this emit.
    let reply: EmitReply | undefined;
    if (sentOutcome.requestId) {
      reply = await replyWatch.settled(
        options.awaitReply?.timeout ?? DEFAULT_REPLY_TIMEOUT,
        sentOutcome.requestId
      );
    } else {
      replyWatch.cancel();
    }
    if (reply) result.reply = reply;
  }

  return result;
}

/**
 * Subscribe to a CDP event where the socket lives: the page's default session,
 * or a flat child session for workers and OOPIFs.
 */
function subscribeWhereSocketLives(
  cdp: CDPClient,
  sessionId: string | undefined,
  event: string,
  handler: (params: Record<string, unknown>) => void
): () => void {
  if (sessionId) {
    return cdp.onSessionEvent(sessionId, event, handler);
  }
  cdp.on(event, handler);
  return () => cdp.off(event, handler);
}

/** WebSocket opcode for a binary frame (RFC 6455 / CDP `Network.WebSocketFrame.opcode`). */
const OPCODE_BINARY = 2;

/** Decode a base64 string into raw bytes, without assuming a Node-only API. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Exact byte-for-byte equality - never a substring/prefix match. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Watch for our own frame on the wire. Subscribed BEFORE dispatch so the
 * confirmation cannot be missed by a fast round trip.
 *
 * Text frames are compared for exact string equality. Binary frames are
 * decoded from Chrome's base64-encoded `payloadData` and compared byte-for-
 * byte against the bytes we handed the socket, with the frame's opcode
 * checked so a text frame that happens to look like our base64 cannot be
 * mistaken for confirmation.
 */
function watchForSentFrame(
  cdp: CDPClient,
  payload: string,
  isBinary: boolean,
  sessionId?: string
): {
  settled(timeout: number): Promise<{ seen: boolean; requestId?: string }>;
  cancel(): void;
} {
  let seen = false;
  let requestId: string | undefined;
  let resolveNow: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expectedBytes = isBinary ? base64ToBytes(payload) : undefined;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const handler = (params: Record<string, unknown>) => {
    if (seen) return;
    const response = params['response'] as { payloadData?: string; opcode?: number } | undefined;
    const data = response?.payloadData ?? '';
    const matches = isBinary
      ? response?.opcode === OPCODE_BINARY &&
        expectedBytes !== undefined &&
        (() => {
          try {
            return bytesEqual(base64ToBytes(data), expectedBytes);
          } catch {
            return false;
          }
        })()
      : data === payload;
    if (!matches) return;
    seen = true;
    requestId = typeof params['requestId'] === 'string' ? params['requestId'] : undefined;
    clearTimer();
    resolveNow?.();
  };
  const unsubscribe = subscribeWhereSocketLives(
    cdp,
    sessionId,
    'Network.webSocketFrameSent',
    handler
  );

  return {
    async settled(timeout: number) {
      if (!seen) {
        await new Promise<void>((resolve) => {
          resolveNow = resolve;
          timer = setTimeout(resolve, timeout);
        });
      }
      clearTimer();
      unsubscribe();
      return { seen, ...(requestId !== undefined ? { requestId } : {}) };
    },
    cancel() {
      clearTimer();
      unsubscribe();
    },
  };
}

/**
 * Watch for a reply. Subscribed before dispatch so only frames that arrive
 * after the emit can match - matching against previously buffered frames would
 * make the reply worthless as evidence.
 *
 * Frames are additionally correlated by CDP `requestId` - the id Chrome
 * assigns to the WebSocket connection itself - against the id captured from
 * our own confirmed `Network.webSocketFrameSent` event. This is what stops a
 * reply arriving on an unrelated, competing socket (same session, same event
 * stream) from being mistaken for our own reply: `requestId` is passed into
 * `settled()` once the send is confirmed, since it cannot be known before
 * dispatch. Frames that arrive on other requestIds are ignored outright, not
 * buffered - they are not candidates for this emit's reply.
 */
function watchForReply(
  cdp: CDPClient,
  options: AwaitReplyOptions,
  sessionId?: string
): {
  settled(timeout: number, expectedRequestId: string): Promise<EmitReply | undefined>;
  cancel(): void;
} {
  const startedAt = Date.now();
  const regex = options.match ? globToRegex(options.match) : undefined;
  let found: EmitReply | undefined;
  let resolveNow: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expectedRequestId: string | undefined;
  // Frames can arrive on the wire before the send is confirmed (before
  // `expectedRequestId` is known), so they are buffered and re-checked once
  // it is set, rather than dropped - a fast round trip must not lose a reply.
  const pending: Record<string, unknown>[] = [];

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const tryMatch = (params: Record<string, unknown>): boolean => {
    if (found || expectedRequestId === undefined) return false;
    const requestId = typeof params['requestId'] === 'string' ? params['requestId'] : undefined;
    if (requestId !== expectedRequestId) return false;
    const response = params['response'] as { payloadData?: string } | undefined;
    const payload = response?.payloadData ?? '';
    if (regex && !regex.test(payload)) return false;
    if (options.where && !matchesWhere(payload, options.where)) return false;
    found = { payload, latencyMs: Date.now() - startedAt };
    clearTimer();
    resolveNow?.();
    return true;
  };

  const handler = (params: Record<string, unknown>) => {
    if (found) return;
    if (expectedRequestId === undefined) {
      pending.push(params);
      return;
    }
    tryMatch(params);
  };
  const unsubscribe = subscribeWhereSocketLives(
    cdp,
    sessionId,
    'Network.webSocketFrameReceived',
    handler
  );

  return {
    async settled(timeout: number, requestId: string) {
      expectedRequestId = requestId;
      const queued = pending.splice(0);
      for (const params of queued) {
        if (tryMatch(params)) break;
      }
      if (!found) {
        await new Promise<void>((resolve) => {
          resolveNow = resolve;
          timer = setTimeout(resolve, timeout);
        });
      }
      clearTimer();
      unsubscribe();
      return found;
    },
    cancel() {
      clearTimer();
      unsubscribe();
    },
  };
}

/** Dot-path field equality against a JSON frame payload. */
export function matchesWhere(payload: string, where: Record<string, unknown>): boolean {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    return Object.entries(where).every(([key, expected]) => {
      const actual = key.split('.').reduce<unknown>((current, part) => {
        if (!current || typeof current !== 'object') return undefined;
        return (current as Record<string, unknown>)[part];
      }, parsed);
      return actual === expected;
    });
  } catch {
    return false;
  }
}
