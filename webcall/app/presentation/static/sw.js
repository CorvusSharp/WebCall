// sw.js — простой обработчик push
self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  self.clients.claim();
});

self.addEventListener('push', (event) => {
  let data = {};
  try{ data = event.data.json(); }catch{}
  const title = data.title || 'Уведомление';
  const body = data.body || '';
  const icon = data.icon || undefined;
  event.waitUntil(self.registration.showNotification(title, { body, icon, data: data.data || {} }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const roomId = event.notification.data?.room_id;
  const url = roomId ? `/call/${encodeURIComponent(roomId)}` : '/call';
  event.waitUntil(clients.openWindow(url));
});
