const CACHE_NAME = 'qs-pos-mobile-direct-v3';

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
  const req = event.request;
  const url = req.url;

  // STRICT BYPASS: Non-GET mutations must bypass cache immediately
  if (req.method !== 'GET') {
    return;
  }

  // STRICT BYPASS: Never intercept Supabase REST/Realtime/Auth/Storage network calls or CDNs
  if (
    url.includes('supabase.co') ||
    url.includes('/rest/v1/') ||
    url.includes('/auth/v1/') ||
    url.includes('/realtime/v1/') ||
    url.includes('/storage/v1/') ||
    url.includes('jsdelivr.net') ||
    url.includes('unpkg.com')
  ) {
    return;
  }

  // Cache-First with Network Fallback & Runtime Cache update for local assets
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(req)
        .then((networkResponse) => {
          // Cache valid same-origin assets
          if (
            networkResponse &&
            networkResponse.status === 200 &&
            networkResponse.type === 'basic'
          ) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(req, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          // SPA offline navigation fallback
          if (req.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
    })
  );
});
