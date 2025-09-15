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
  const data = event.notification.data || {};
  const from = data.from;
  const url = '/call';
  event.waitUntil((async () => {
    // Пытаемся фокусировать открытую вкладку
    const winClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (winClients && winClients.length){
      const client = winClients[0];
      try { await client.focus(); } catch {}
      if (from){
        try { client.postMessage({ type: 'openDirect', userId: from }); } catch {}
      }
      return;
    }
    // Иначе открываем новую вкладку
    const newClient = await clients.openWindow(url);
    if (newClient && from){
      try { newClient.postMessage({ type: 'openDirect', userId: from }); } catch {}
    }
  })());
});
