// Minimal app-shell service worker.
// Caches only the static shell (HTML/CSS/JS/icons/manifest) so the app can
// launch offline. It deliberately does NOT cache anything else — drive data
// must always come from a live network request to DynamoDB, never from a
// stale cache.

const CACHE_NAME = 'drivelog-shell-v2';
const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/app.js',
  './js/config.js',
  './js/utils.js',
  './js/dynamo.js',
  './js/sun.js',
  './js/export.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only intercept same-origin GET requests for shell assets.
  // Everything else (AWS SDK CDN imports, DynamoDB/Cognito calls) passes
  // straight through to the network, uncached.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
