import type { CDPClient } from '../cdp/client.ts';

export type StoredPermissionName =
  | 'microphone'
  | 'camera'
  | 'notifications'
  | 'geolocation';

export function normalizeStoredPermission(name: string): StoredPermissionName | null {
  const value = String(name).trim().toLowerCase();
  if (value === 'microphone' || value === 'audio' || value === 'audiocapture' || value === 'audio-capture') {
    return 'microphone';
  }
  if (value === 'camera' || value === 'videocapture' || value === 'video-capture') {
    return 'camera';
  }
  if (value === 'notifications') {
    return 'notifications';
  }
  if (value === 'geolocation') {
    return 'geolocation';
  }
  return null;
}

export function toProtocolPermission(name: string): string | null {
  const normalized = normalizeStoredPermission(name);
  if (normalized === 'microphone') return 'audioCapture';
  if (normalized === 'camera') return 'videoCapture';
  if (normalized === 'notifications') return 'notifications';
  if (normalized === 'geolocation') return 'geolocation';
  return null;
}

export function originFromUrl(url: string | undefined): string | undefined {
  try {
    const parsed = new URL(url ?? '');
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function buildPermissionOverrideScript(granted: string[]): string {
  const normalized = [...new Set(granted.map((value) => normalizeStoredPermission(value)).filter(Boolean))];
  return `
(() => {
  const granted = ${JSON.stringify(normalized)};
  globalThis.__bpGrantedPermissions = granted;

  if (!navigator.permissions || !navigator.permissions.query) {
    return;
  }

  if (!globalThis.__bpPermissionOverrideInstalled) {
    globalThis.__bpPermissionOverrideInstalled = true;
    const originalQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = function(desc) {
      const rawName = desc && desc.name ? String(desc.name) : '';
      const normalizedName =
        rawName === 'audio-capture' || rawName === 'audioCapture'
          ? 'microphone'
          : rawName === 'video-capture' || rawName === 'videoCapture'
            ? 'camera'
            : rawName;
      if (Array.isArray(globalThis.__bpGrantedPermissions) && globalThis.__bpGrantedPermissions.includes(normalizedName)) {
        return Promise.resolve({
          state: 'granted',
          onchange: null,
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() { return true; },
        });
      }
      return originalQuery(desc);
    };
  }
})();
`.trim();
}

export function buildVisibilityOverrideScript(state: 'hidden' | 'visible'): string {
  return `
(() => {
  const nextState = ${JSON.stringify(state)};

  if (!globalThis.__bpApplyVisibilityState) {
    globalThis.__bpApplyVisibilityState = function(value) {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get() { return value; },
      });
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get() { return value === 'hidden'; },
      });
      document.dispatchEvent(new Event('visibilitychange'));
    };
  }

  globalThis.__bpForcedVisibilityState = nextState;
  globalThis.__bpApplyVisibilityState(nextState);
})();
`.trim();
}

export function buildNetworkOverrideScript(
  state: { offline: boolean; latency?: number } | undefined
): string {
  const normalized = {
    offline: Boolean(state?.offline),
    latency: Math.max(0, Math.round(state?.latency ?? 0)),
  };

  return `
(() => {
  const config = ${JSON.stringify(normalized)};
  globalThis.__bpNetworkOverrideState = config;
  globalThis.__bpTrackedWebSockets = globalThis.__bpTrackedWebSockets || new Set();

  if (!globalThis.__bpNetworkOverrideInstalled) {
    globalThis.__bpNetworkOverrideInstalled = true;

    const originalFetch = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null;
    if (originalFetch) {
      globalThis.fetch = function(...args) {
        const current = globalThis.__bpNetworkOverrideState || { offline: false, latency: 0 };
        if (current.offline) {
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            originalFetch(...args).then(resolve, reject);
          }, current.latency || 0);
        });
      };
    }

    if (globalThis.XMLHttpRequest && !globalThis.__bpNetworkXhrPatched) {
      globalThis.__bpNetworkXhrPatched = true;
      const originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function(body) {
        const current = globalThis.__bpNetworkOverrideState || { offline: false, latency: 0 };
        if (current.offline) {
          setTimeout(() => {
            this.dispatchEvent(new ProgressEvent('error'));
            if (typeof this.onerror === 'function') {
              this.onerror(new ProgressEvent('error'));
            }
          }, 0);
          return;
        }
        const invoke = () => originalSend.call(this, body);
        if (current.latency > 0) {
          setTimeout(invoke, current.latency);
        } else {
          invoke();
        }
      };
    }

    if (globalThis.WebSocket && !globalThis.__bpNetworkWebSocketPatched) {
      globalThis.__bpNetworkWebSocketPatched = true;
      const NativeWebSocket = globalThis.WebSocket;
      const notifyOfflineSocket = (socket, code = 1012, reason = 'offline') => {
        if (!socket || socket.__bpOfflineNotified) {
          return;
        }
        try {
          socket.__bpOfflineNotified = true;
        } catch {}
        try {
          socket.readyState = 3;
        } catch {}
        const errorEvent = new Event('error');
        const closeEvent =
          typeof CloseEvent === 'function'
            ? new CloseEvent('close', { code, reason, wasClean: false })
            : new Event('close');
        try {
          socket.dispatchEvent(errorEvent);
        } catch {}
        try {
          if (typeof socket.onerror === 'function') {
            socket.onerror(errorEvent);
          }
        } catch {}
        try {
          socket.dispatchEvent(closeEvent);
        } catch {}
        try {
          if (typeof socket.onclose === 'function') {
            socket.onclose(closeEvent);
          }
        } catch {}
      };
      const createOfflineSocket = (url) => {
        const target = new EventTarget();
        const socket = {
          url: String(url),
          readyState: 0,
          bufferedAmount: 0,
          extensions: '',
          protocol: '',
          binaryType: 'blob',
          onopen: null,
          onerror: null,
          onclose: null,
          onmessage: null,
          addEventListener: target.addEventListener.bind(target),
          removeEventListener: target.removeEventListener.bind(target),
          dispatchEvent: target.dispatchEvent.bind(target),
          send() {
            throw new DOMException('WebSocket is offline', 'InvalidStateError');
          },
          close(code = 1012, reason = 'offline') {
            socket.readyState = 3;
            notifyOfflineSocket(socket, code, reason);
          },
        };
        setTimeout(() => {
          notifyOfflineSocket(socket, 1012, 'offline');
        }, 0);
        return socket;
      };
      const WrappedWebSocket = function(url, protocols) {
        const current = globalThis.__bpNetworkOverrideState || { offline: false };
        if (current.offline) {
          return createOfflineSocket(url);
        }
        const socket =
          arguments.length > 1 ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
        globalThis.__bpTrackedWebSockets.add(socket);
        const nativeClose = socket.close.bind(socket);
        socket.close = function(code = 1000, reason = '') {
          const current = globalThis.__bpNetworkOverrideState || { offline: false };
          if (current.offline) {
            notifyOfflineSocket(socket, code || 1012, reason || 'offline');
          }
          return nativeClose(code, reason);
        };
        const failOffline = () => {
          const current = globalThis.__bpNetworkOverrideState || { offline: false };
          if (current.offline) {
            try {
              socket.close(1012, 'offline');
            } catch {}
          }
        };
        socket.addEventListener('open', failOffline);
        socket.addEventListener('close', () => {
          try {
            globalThis.__bpTrackedWebSockets.delete(socket);
          } catch {}
        });
        setTimeout(failOffline, 25);
        return socket;
      };
      WrappedWebSocket.prototype = NativeWebSocket.prototype;
      Object.setPrototypeOf(WrappedWebSocket, NativeWebSocket);
      globalThis.WebSocket = WrappedWebSocket;
    }
  }

  if (globalThis.__bpTrackedWebSockets) {
    for (const socket of globalThis.__bpTrackedWebSockets) {
      if (socket && socket.readyState === 1 && config.offline) {
        try {
          socket.close(1012, 'offline');
        } catch {}
      }
    }
  }

  if (globalThis.navigator && typeof globalThis.navigator === 'object') {
    try {
      Object.defineProperty(globalThis.navigator, 'onLine', {
        configurable: true,
        get() { return !config.offline; },
      });
    } catch {}
  }
})();
`.trim();
}

export async function applyPermissionState(
  cdp: CDPClient,
  origin: string | undefined,
  granted: string[]
): Promise<void> {
  const protocolPermissions = [...new Set(granted.map((value) => toProtocolPermission(value)).filter(Boolean))];

  if (protocolPermissions.length > 0) {
    await cdp.send('Browser.grantPermissions', {
      permissions: protocolPermissions,
      origin: origin ?? '',
    });
  }

  const script = buildPermissionOverrideScript(granted);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: script });
  await cdp.send('Runtime.evaluate', { expression: script, awaitPromise: false });
}

export async function applyVisibilityState(
  cdp: CDPClient,
  state: 'hidden' | 'visible'
): Promise<void> {
  const script = buildVisibilityOverrideScript(state);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: script });
  await cdp.send('Runtime.evaluate', { expression: script, awaitPromise: false });
}

export async function applyNetworkOverride(
  cdp: CDPClient,
  state: { offline: boolean; latency?: number } | undefined
): Promise<void> {
  const script = buildNetworkOverrideScript(state);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: script });
  await cdp.send('Runtime.evaluate', { expression: script, awaitPromise: false });
}
