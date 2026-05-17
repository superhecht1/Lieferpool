/**
 * Service Worker für FrischKette Fahrer-App
 * Offline-Modus + Cache-Strategie
 */
const CACHE     = 'frischkette-fahrer-v1';
const API_CACHE = 'frischkette-api-v1';

const STATIC = [
  '/fahrer',
  '/fahrer.html',
  '/api.js',
  '/app.js',
  '/style.css',
  '/login',
  '/login.html',
];

// Install: statische Assets cachen
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC).catch(() => {}))
  );
  self.skipWaiting();
});

// Activate: alte Caches löschen
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE && k !== API_CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: Cache-First für statische, Network-First für API
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API-Calls: Network-First, bei Fehler aus Cache
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request.clone())
        .then(res => {
          // GET-Responses cachen (nicht POST/PUT/DELETE)
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

  // Statische Assets: Cache-First
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => caches.match('/fahrer') || new Response('Offline', { status: 503 }));
    })
  );
});

// Push-Notification empfangen
self.addEventListener('push', e => {
  const data = e.data?.json() || {};
  const title = data.title || 'FrischKette';
  const body  = data.body  || 'Neue Nachricht';
  const icon  = '/favicon.ico';

  e.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge: icon,
      tag:   data.tag || 'frischkette',
      data:  data.url ? { url: data.url } : {},
      actions: data.actions || [],
      vibrate: [200, 100, 200],
    })
  );
});

// Notification-Klick → App öffnen
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/fahrer';
  e.waitUntil(
    clients.matchAll({ type: 'window' }).then(wins => {
      const match = wins.find(w => w.url.includes('/fahrer'));
      if (match) { match.focus(); match.navigate(url); }
      else clients.openWindow(url);
    })
  );
});

// Background Sync: Bestätigungen offline speichern + später senden
self.addEventListener('sync', e => {
  if (e.tag === 'sync-confirmations') {
    e.waitUntil(syncPendingConfirmations());
  }
});

async function syncPendingConfirmations() {
  const cache = await caches.open('pending-confirmations');
  const keys  = await cache.keys();
  for (const req of keys) {
    try {
      const body = await (await cache.match(req)).json();
      await fetch(req.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': body._token },
        body: JSON.stringify(body),
      });
      await cache.delete(req);
    } catch {}
  }
}
