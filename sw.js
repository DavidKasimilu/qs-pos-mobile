const CACHE_NAME = 'qs-pos-mobile-v2';

const CRITICAL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/mobile-theme.css',
  './css/mobile-layout.css',
  './js/config.js',
  './js/idb.js',
  './js/sync.js',
  './js/auth.js',
  './js/cart.js',
  './js/router.js',
  './js/app.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Fetch each critical asset safely so missing icons don't abort installation
      for (const url of CRITICAL_ASSETS) {
        try {
          await cache.add(url);
        } catch (err) {
          console.warn(`[SW] Precache skipped for: ${url}`, err);
        }
      }
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Never intercept cloud API traffic
  if (
    event.request.url.includes('/rest/v1/') ||
    event.request.url.includes('/auth/v1/') ||
    event.request.url.includes('workers.dev')
  ) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request).catch(() => {
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        })
      );
    })
  );
});