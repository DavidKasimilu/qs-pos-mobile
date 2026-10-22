const CACHE_NAME = 'qs-pos-cache-v1';
const ASSETS_TO_CACHE = [
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
  './js/app.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm',
  'https://unpkg.com/lucide@latest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
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
  // Avoid caching Supabase API network requests in service worker cache (IndexedDB handles this)
  if (event.request.url.includes('/rest/v1/') || event.request.url.includes('/auth/v1/')) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    })
  );
});