// Minimal app-shell service worker.
// Caches only the static shell (HTML/CSS/JS/icons/manifest) so the app can
// launch offline. It deliberately does NOT cache anything else — drive data
// must always come from a live network request to DynamoDB, never from a
// stale cache.
//
// Cache name is derived from version.json at install time rather than a
// hardcoded constant here — version.json is the single source of truth for
// "what's the latest published release." Bump it there and this worker
// automatically busts its cache on the next install, with no other file to
// remember to edit.

const CACHE_PREFIX = 'drivelog-shell';
const FALLBACK_VERSION = 'unknown';
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

async function resolveCacheName() {
  try {
    const res = await fetch('./version.json', { cache: 'no-store' });
    const payload = await res.json();
    const version = String(payload?.version || '').trim();
    return `${CACHE_PREFIX}-${version || FALLBACK_VERSION}`;
  } catch {
    return `${CACHE_PREFIX}-${FALLBACK_VERSION}`;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    resolveCacheName().then((cacheName) =>
      caches.open(cacheName).then((cache) => cache.addAll(SHELL_ASSETS))
    )
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    resolveCacheName().then((currentCacheName) =>
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith(CACHE_PREFIX) && k !== currentCacheName)
            .map((k) => caches.delete(k))
        )
      )
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
