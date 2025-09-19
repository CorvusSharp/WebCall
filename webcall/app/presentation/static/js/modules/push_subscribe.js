// modules/push_subscribe.js
// Инициализация push подписки и отправка subscription на сервер.

import { subscribePush } from '../api.js';
import { updatePermBanner } from './permissions.js';

export async function initPush(){
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
  if (Notification.permission === 'denied') { updatePermBanner(); return; }
  if (Notification.permission === 'default') { updatePermBanner(); return; }
  const reg = await navigator.serviceWorker.getRegistration('/static/sw.js') || await navigator.serviceWorker.register('/static/sw.js');
  const r = await fetch('/api/v1/push/vapid-public');
  const j = await r.json();
  const vapidKey = (j && j.key) ? urlBase64ToUint8Array(j.key) : null;
  const existing = await reg.pushManager.getSubscription();
  let sub = existing;
  if (!sub){
    sub = await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey: vapidKey });
  }
  const payload = { endpoint: sub.endpoint, keys: sub.toJSON().keys };
  await subscribePush(payload);
}

function urlBase64ToUint8Array(base64String){
  if (!base64String) return null;
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g,'+').replace(/_/g,'/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i=0;i<rawData.length;i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}
