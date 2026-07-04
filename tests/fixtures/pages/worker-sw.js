// Minimal service worker for the worker-hang proof fixture (worker-page.html).
// A service worker is a child target that also attaches PAUSED under the engine's
// global auto-attach (waitForDebuggerOnStart). It must be released for `activate`
// to fire and `navigator.serviceWorker.ready` to resolve.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
