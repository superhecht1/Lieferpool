/**
 * Service Worker – FrischKette Caterer
 * Nur same-origin Requests werden gecacht.
 */
const CACHE     = 'frischkette-erzeuger-v2';
const API_CACHE = 'frischkette-erzeuger-api-v2';

const STATIC = [
  '/erzeuger',
  '/erzeuger.html',
  '/api.js',
  '/app.js',
  '/style.css',
  '/login',
  '/login.html',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE && k !== API_CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Nur http/https + nur same-origin cachen
  if (!url.protocol.startsWith('http')) return;
  if (url.origin !== self.location.origin) return;

  // Kein Caching für Downloads und non-GET
  if (e.request.method !== 'GET') return;
  if (url.search.includes('download=1')) return;

  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request.clone())
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(API_CACHE).then(c => c.put(e.request, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(e.request).then(r => r || Response.error()))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request.clone()).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match('/erzeuger.html').then(r => r || Response.error()));
    })
  );
});

self.addEventListener('push', e => {
  const data  = e.data?.json() || {};
  const title = data.title || 'FrischKette';
  e.waitUntil(
    self.registration.showNotification(title, {
      body:    data.body || '',
      icon:    '/icon-192.png',
      badge:   '/icon-192.png',
      tag:     data.tag || 'frischkette-erzeuger',
      data:    data.url ? { url: data.url } : {},
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/erzeuger';
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(wins => {
      const w = wins.find(w => w.url.includes('/erzeuger'));
      if (w) { w.focus(); w.navigate(url); }
      else clients.openWindow(url);
    })
  );
});
