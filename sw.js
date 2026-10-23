const CACHE_NAME = 'qs-pos-mobile-direct-v1';

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
      for (const url of CRITICAL_ASSETS) {
        try {
          await cache.add(url);
        } catch (err) {
          console.warn(`[SW] Precache skipped for: ${url}`);
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
  const url = event.request.url;

  // STRICT BYPASS: Never intercept Supabase network calls or CDN dependencies
  if (
    url.includes('supabase.co') ||
    url.includes('/rest/v1/') ||
    url.includes('/auth/v1/') ||
    url.includes('jsdelivr.net') ||
    url.includes('unpkg.com')
  ) {
    return;
  }

  // Handle local shell navigation and cached static assets
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
