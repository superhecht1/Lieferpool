/**
 * Service Worker für FrischKette Erzeuger-App
 * Offline-Modus + Cache-Strategie
 */
const CACHE     = 'frischkette-erzeuger-v1';
const API_CACHE = 'frischkette-erzeuger-api-v1';

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

  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request.clone())
        .then(res => {
          if (e.request.method === 'GET' && res.ok) {
            const clone = res.clone();
            caches.open(API_CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request.clone()).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match('/erzeuger') || new Response('Offline', { status: 503 }));
    })
  );
});

self.addEventListener('push', e => {
  const data  = e.data?.json() || {};
  const title = data.title || 'FrischKette Erzeuger';
  const body  = data.body  || 'Neue Nachricht';
  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:    '/favicon.ico',
      badge:   '/favicon.ico',
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
      const match = wins.find(w => w.url.includes('/erzeuger'));
      if (match) { match.focus(); match.navigate(url); }
      else clients.openWindow(url);
    })
  );
});
