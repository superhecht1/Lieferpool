// sw.js – LieferPool Service Worker (Push Notifications)

const CACHE_NAME = 'lieferpool-v1';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// Push-Nachricht empfangen
self.addEventListener('push', e => {
  if (!e.data) return;

  let data;
  try { data = e.data.json(); }
  catch { data = { title: 'LieferPool', body: e.data.text() }; }

  const options = {
    body:    data.body || '',
    icon:    data.icon  || '/icon-192.png',
    badge:   data.badge || '/icon-72.png',
    tag:     data.tag   || 'lieferpool',
    data:    data.data  || {},
    actions: data.actions || [],
    vibrate: [200, 100, 200],
    requireInteraction: true,
  };

  e.waitUntil(
    self.registration.showNotification(data.title || 'LieferPool', options)
  );
});

// Notification angeklickt
self.addEventListener('notificationclick', e => {
  e.notification.close();

  const url = e.notification.data?.url || '/fahrer';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
