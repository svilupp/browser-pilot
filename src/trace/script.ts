export const TRACE_BINDING_NAME = '__bpTraceBinding';

export function createTraceScript(bindingName: string, ownerId: string): string {
  return `
(() => {
  const owner = ${JSON.stringify(ownerId)};
  const binding = globalThis[${JSON.stringify(bindingName)}];
  if (typeof binding !== 'function') return;
  if (window.__bpTraceHub) { window.__bpTraceHub.sinks.set(owner,binding); return; }
  const sinks = new Map([[owner,binding]]), cleanup = [];
  let active = true;
  const listen = (target,event,callback) => { if(!active)return; target.addEventListener(event,callback);cleanup.push(()=>target.removeEventListener(event,callback)); };
  const hub = {sinks,release(id) {
    sinks.delete(id); if(sinks.size)return;
    active=false;for(const dispose of cleanup.splice(0).reverse())try{dispose();}catch{}
    if(window.__bpTraceHub===hub){delete window.__bpTraceHub;delete window.__bpTraceInstalled;delete window.__bpTraceWebSocketInstalled;delete window.__bpTraceRecentEvents;}
  }};
  window.__bpTraceHub=hub;window.__bpTraceInstalled=true;

  const emit = (event, data = {}, severity = 'info', summary) => {
    if(!active)return;
    try {
      globalThis.__bpTraceRecentEvents = globalThis.__bpTraceRecentEvents || [];
      const payload = {
        event,
        severity,
        summary: summary || event,
        ts: Date.now(),
        data,
      };
      globalThis.__bpTraceRecentEvents.push(payload);
      if (globalThis.__bpTraceRecentEvents.length > 200) {
        globalThis.__bpTraceRecentEvents.splice(0, globalThis.__bpTraceRecentEvents.length - 200);
      }
      for(const sink of sinks.values())try{sink(JSON.stringify(payload));}catch{}
    } catch {}
  };

  const patchWebSocket = () => {
    const NativeWebSocket = window.WebSocket;
    if (typeof NativeWebSocket !== 'function' || window.__bpTraceWebSocketInstalled) return;
    window.__bpTraceWebSocketInstalled = true;

    const nextId = () => Math.random().toString(36).slice(2, 10);

    const patchInstance = (socket, urlValue) => {
      if (!socket || socket.__bpTracePatched) return socket;
      socket.__bpTracePatched = true;
      socket.__bpTraceId = socket.__bpTraceId || nextId();
      socket.__bpTraceUrl = String(urlValue || socket.url || '');
      globalThis.__bpTrackedWebSockets = globalThis.__bpTrackedWebSockets || new Set();
      globalThis.__bpTrackedWebSockets.add(socket);

      emit(
        'ws.connection.created',
        { connectionId: socket.__bpTraceId, url: socket.__bpTraceUrl },
        'info',
        'WebSocket opened ' + socket.__bpTraceUrl
      );

      const originalSend = socket.send;
      const tracedSend = function(data) {
        const payload =
          typeof data === 'string'
            ? data
            : data && typeof data.toString === 'function'
              ? data.toString()
              : '[binary]';
        emit(
          'ws.frame.sent',
          {
            connectionId: socket.__bpTraceId,
            url: socket.__bpTraceUrl,
            payload,
            length: payload.length,
          },
          'info',
          'WebSocket frame sent'
        );
        return originalSend.call(this, data);
      };

      socket.send=tracedSend;cleanup.push(()=>{if(socket.send===tracedSend)socket.send=originalSend;delete socket.__bpTracePatched;delete socket.__bpTraceId;delete socket.__bpTraceUrl;delete socket.__bpTraceClosed;globalThis.__bpTrackedWebSockets?.delete(socket);});
      listen(socket,'message', (event) => {
        if (socket.__bpOfflineNotified || socket.__bpTraceClosed) {
          return;
        }
        const data = event && 'data' in event ? event.data : '';
        const payload =
          typeof data === 'string'
            ? data
            : data && typeof data.toString === 'function'
              ? data.toString()
              : '[binary]';
        emit(
          'ws.frame.received',
          {
            connectionId: socket.__bpTraceId,
            url: socket.__bpTraceUrl,
            payload,
            length: payload.length,
          },
          'info',
          'WebSocket frame received'
        );
      });

      listen(socket,'close', (event) => {
        if (socket.__bpTraceClosed) {
          return;
        }
        socket.__bpTraceClosed = true;
        try {
          globalThis.__bpTrackedWebSockets.delete(socket);
        } catch {}
        emit(
          'ws.connection.closed',
          {
            connectionId: socket.__bpTraceId,
            url: socket.__bpTraceUrl,
            code: event.code,
            reason: event.reason,
          },
          'warn',
          'WebSocket closed'
        );
      });

      return socket;
    };

    const TracedWebSocket = function(url, protocols) {
      return arguments.length > 1
        ? patchInstance(new NativeWebSocket(url, protocols), url)
        : patchInstance(new NativeWebSocket(url), url);
    };
    TracedWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(TracedWebSocket, NativeWebSocket);
    window.WebSocket = TracedWebSocket;cleanup.push(()=>{if(window.WebSocket===TracedWebSocket)window.WebSocket=NativeWebSocket;});
  };

  listen(window,'error', (errorEvent) => {
    emit(
      'runtime.exception',
      {
        message: errorEvent.message,
        filename: errorEvent.filename,
        line: errorEvent.lineno,
        column: errorEvent.colno,
      },
      'error',
      errorEvent.message || 'Uncaught error'
    );
  });

  listen(window,'unhandledrejection', (event) => {
    const reason = event && 'reason' in event ? String(event.reason) : 'Unhandled rejection';
    emit('runtime.unhandledRejection', { reason }, 'error', reason);
  });

  const patchPermissions = async () => {
    if (!navigator.permissions || !navigator.permissions.query) return;

    const names = ['geolocation', 'microphone', 'camera', 'notifications'];
    for (const name of names) {
      try {
        const status = await navigator.permissions.query({ name });
        emit(
          'permission.state',
          { name, state: status.state },
          status.state === 'denied' ? 'warn' : 'info',
          name + ': ' + status.state
        );
        listen(status,'change', () => {
          emit(
            'permission.changed',
            { name, state: status.state },
            status.state === 'denied' ? 'warn' : 'info',
            name + ': ' + status.state
          );
        });
      } catch {}
    }
  };

  const patchMediaElement = (element) => {
    if (!active || !element || element.__bpTracePatched) return;
    element.__bpTracePatched = true;cleanup.push(()=>{delete element.__bpTracePatched;});

    listen(element,'play', () => {
      emit(
        'media.playback.started',
        { tag: element.tagName.toLowerCase(), src: element.currentSrc || element.src || null },
        'info',
        'Media playback started'
      );
    });

    const onStop = () => {
      emit(
        'media.playback.stopped',
        { tag: element.tagName.toLowerCase(), src: element.currentSrc || element.src || null },
        'warn',
        'Media playback stopped'
      );
    };

    listen(element,'pause', onStop);
    listen(element,'ended', onStop);
  };

  const patchMediaElements = () => {
    document.querySelectorAll('audio,video').forEach(patchMediaElement);
  };

  patchMediaElements();
  patchWebSocket();

  if (document.documentElement) {
    const observer = new MutationObserver(() => {
      patchMediaElements();
    });
    cleanup.push(()=>observer.disconnect());
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    const original = navigator.mediaDevices.getUserMedia;
    const tracedGetUserMedia = async (...args) => {
      emit('voice.capture.started', { constraints: args[0] || null }, 'info', 'Voice capture started');
      try {
        const stream = await original.apply(navigator.mediaDevices,args);
        const tracks = stream.getTracks();

        for (const track of tracks) {
          emit(
            'media.track.started',
            { kind: track.kind, label: track.label, readyState: track.readyState },
            'info',
            track.kind + ' track started'
          );
          listen(track,'ended', () => {
            emit(
              'media.track.ended',
              { kind: track.kind, label: track.label, readyState: track.readyState },
              'warn',
              track.kind + ' track ended'
            );
            emit(
              'voice.capture.stopped',
              { kind: track.kind, label: track.label, readyState: track.readyState },
              'warn',
              'Voice capture stopped'
            );
          });
        }

        emit(
          'voice.capture.detectedAudio',
          { trackCount: tracks.length, kinds: tracks.map((track) => track.kind) },
          'info',
          'Voice capture detected audio'
        );

        return stream;
      } catch (error) {
        emit(
          'voice.pipeline.notReady',
          { message: String(error && error.message ? error.message : error) },
          'error',
          String(error && error.message ? error.message : error)
        );
        throw error;
      }
    };
    navigator.mediaDevices.getUserMedia=tracedGetUserMedia;cleanup.push(()=>{if(navigator.mediaDevices.getUserMedia===tracedGetUserMedia)navigator.mediaDevices.getUserMedia=original;});
  }

  listen(document,'visibilitychange', () => {
    emit(
      'dom.state.changed',
      { visibilityState: document.visibilityState },
      document.visibilityState === 'hidden' ? 'warn' : 'info',
      'Visibility ' + document.visibilityState
    );
  });

  patchPermissions();
  emit('voice.pipeline.ready', { url: location.href }, 'info', 'Trace hooks ready');
})();
`;
}

export const TRACE_SCRIPT = createTraceScript(TRACE_BINDING_NAME, 'legacy');
export function traceCleanupScript(ownerId: string): string {
  return `window.__bpTraceHub?.release(${JSON.stringify(ownerId)})`;
}
