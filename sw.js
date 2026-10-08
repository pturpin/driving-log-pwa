const SW_VERSION = 'v0.18';
const CACHE_PREFIX = 'drivelog-shell';
const CACHE_NAME = `${CACHE_PREFIX}-${SW_VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './version.json',
  './css/app.css',
  './js/app.js',
  './js/config.js',
  './js/utils.js',
  './js/progress.js',
  './js/dynamo.js',
  './js/sun.js',
  './js/export.js',
  './js/conflicts.js',
  './js/local-store.js',
  './js/log-repository.js',
  './js/vendor/aws-sdk.js',
  './js/vendor/MANIFEST.md',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

const IMMUTABLE_PATHS = new Set(
  SHELL_ASSETS
    .filter((asset) => asset !== './' && asset !== './index.html' && asset !== './version.json')
    .map((asset) => new URL(asset, self.location.href).pathname)
);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(SHELL_ASSETS.map((asset) => new Request(asset, { cache: 'reload' })))
    )
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request, fallbackUrl) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) ||
      (fallbackUrl ? await cache.match(fallbackUrl) : undefined) ||
      Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, './index.html'));
    return;
  }
  if (url.pathname === new URL('./version.json', self.location.href).pathname) return;
  if (IMMUTABLE_PATHS.has(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) =>
        (await cache.match(request)) || fetch(request)
      )
    );
  }
});
