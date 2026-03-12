export const TRACE_BINDING_NAME = '__bpTraceBinding';

export const TRACE_SCRIPT = `
(() => {
  if (window.__bpTraceInstalled) return;
  window.__bpTraceInstalled = true;

  const binding = globalThis.${TRACE_BINDING_NAME};
  if (typeof binding !== 'function') return;

  const emit = (event, data = {}, severity = 'info', summary) => {
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
      binding(JSON.stringify(payload));
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
      socket.send = function(data) {
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

      socket.addEventListener('message', (event) => {
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

      socket.addEventListener('close', (event) => {
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
    window.WebSocket = TracedWebSocket;
  };

  window.addEventListener('error', (errorEvent) => {
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

  window.addEventListener('unhandledrejection', (event) => {
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
        status.addEventListener('change', () => {
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
    if (!element || element.__bpTracePatched) return;
    element.__bpTracePatched = true;

    element.addEventListener('play', () => {
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

    element.addEventListener('pause', onStop);
    element.addEventListener('ended', onStop);
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
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (...args) => {
      emit('voice.capture.started', { constraints: args[0] || null }, 'info', 'Voice capture started');
      try {
        const stream = await original(...args);
        const tracks = stream.getTracks();

        for (const track of tracks) {
          emit(
            'media.track.started',
            { kind: track.kind, label: track.label, readyState: track.readyState },
            'info',
            track.kind + ' track started'
          );
          track.addEventListener('ended', () => {
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
  }

  document.addEventListener('visibilitychange', () => {
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
