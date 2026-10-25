// sw.js
const CACHE_NAME = 'quicksell-pos-v2';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/mobile-layout.css',
  '/css/mobile-theme.css',
  '/js/config.js',
  '/js/idb.js',
  '/js/sync.js',
  '/js/auth.js',
  '/js/cart.js',
  '/js/app.js',
  '/js/router.js',
  '/assets/icon-192.png',
  '/assets/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
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
  const url = new URL(event.request.url);

  // Network-only for Supabase REST endpoints, WebSocket channels, and external APIs
  if (
    url.hostname.includes('supabase.co') ||
    url.pathname.includes('/rest/v1/') ||
    url.pathname.includes('/realtime/v1/') ||
    event.request.method !== 'GET'
  ) {
    return event.respondWith(fetch(event.request));
  }

  // Cache-First strategy with network fallback for local static assets
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return (
        cachedResponse ||
        fetch(event.request).then((networkResponse) => {
          return caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, networkResponse.clone());
            return networkResponse;
          });
        })
      );
    })
  );
});