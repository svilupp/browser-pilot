import type { Transport } from './transport.ts';

/** Structural socket contract shared by constructor and upgraded WebSockets. */
export interface MessageSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

/** Decode binary CDP messages in arrival order, including asynchronous Blobs. */
export function transportFromSocket(socket: MessageSocket): Transport {
  const messages = new Set<(message: string) => void>();
  const closes = new Set<() => void>();
  const errors = new Set<(error: Error) => void>();
  const queue: Array<string | Promise<string>> = [];
  let decoding = false;
  let terminated = false;
  const invalidPayload = () => {
    for (const handler of errors) handler(new Error('Invalid CDP message payload'));
  };
  const deliver = (text: string) => {
    if (!terminated) for (const handler of messages) handler(text);
  };
  const drain = () => {
    if (decoding || terminated) return;
    while (queue.length) {
      const next = queue.shift()!;
      if (typeof next === 'string') deliver(next);
      else {
        decoding = true;
        void next.then(deliver, invalidPayload).finally(() => {
          decoding = false;
          drain();
        });
        return;
      }
    }
  };
  const onMessage = (event: unknown) => {
    // Decode synchronous payloads immediately; queue Blobs without reordering.
    const data = (event as { data: unknown }).data;
    if (typeof data === 'string') queue.push(data);
    else if (data instanceof ArrayBuffer) queue.push(new TextDecoder().decode(data));
    else if (ArrayBuffer.isView(data)) queue.push(new TextDecoder().decode(data));
    else if (data instanceof Blob) queue.push(data.text());
    else {
      invalidPayload();
      return;
    }
    drain();
  };
  const onClose = () => {
    if (terminated) return;
    terminated = true;
    for (const handler of closes) handler();
    socket.removeEventListener('message', onMessage);
    socket.removeEventListener('close', onClose);
    socket.removeEventListener('error', onError);
    queue.length = 0;
    messages.clear();
    closes.clear();
    errors.clear();
  };
  const onError = () => {
    for (const handler of errors) handler(new Error('CDP socket error'));
  };
  socket.addEventListener('message', onMessage);
  socket.addEventListener('close', onClose);
  socket.addEventListener('error', onError);
  return {
    send(message) {
      if (terminated || socket.readyState !== 1) throw new Error('CDP socket is closed');
      socket.send(message);
    },
    async close() {
      try {
        socket.close();
      } finally {
        onClose();
      }
    },
    onMessage(handler) {
      messages.add(handler);
      return () => messages.delete(handler);
    },
    onClose(handler) {
      closes.add(handler);
      return () => closes.delete(handler);
    },
    onError(handler) {
      errors.add(handler);
      return () => errors.delete(handler);
    },
  };
}

/** Wait for a constructor socket once, disposing admission listeners on every path. */
export async function openSocket(
  socket: MessageSocket,
  options: { timeout?: number; signal?: AbortSignal }
): Promise<Transport> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onError);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Some constructor sockets finish an in-flight handshake after close().
      // Keep a bounded guard until terminal close so a late open cannot escape.
      const disposeGuard = () => {
        clearTimeout(guardTimer);
        socket.removeEventListener('open', lateOpen);
        socket.removeEventListener('close', disposeGuard);
      };
      const lateOpen = () => {
        try {
          socket.close();
        } finally {
          disposeGuard();
        }
      };
      const guardTimer = setTimeout(disposeGuard, 1000);
      socket.addEventListener('open', lateOpen);
      socket.addEventListener('close', disposeGuard);
      try {
        socket.close();
      } catch {}
      reject(error);
    };
    const onOpen = () => {
      if (settled) {
        socket.close();
        return;
      }
      settled = true;
      cleanup();
      resolve(transportFromSocket(socket));
    };
    const onError = () => fail(new Error('WebSocket closed before connection opened'));
    const onAbort = () => fail(new Error('WebSocket connection aborted'));
    const timer = setTimeout(
      () => fail(new Error('WebSocket connection timeout')),
      options.timeout ?? 30000
    );
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onError);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    else if (socket.readyState === 1) onOpen();
  });
}
