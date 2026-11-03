self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('push', e => {
  const d = e.data ? e.data.json() : { title: 'Pesanan siap', body: '' };
  e.waitUntil(self.registration.showNotification(d.title, { body: d.body, vibrate: [200, 100, 200], requireInteraction: true, data: { url: d.url } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data.url || '/'));
});
