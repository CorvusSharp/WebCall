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
  // Идемпотентность: вычисляем fingerprint на основе endpoint + ключей и сравниваем с сохранённым.
  try {
    const keys = payload.keys || {};
    const fpSource = payload.endpoint + '|' + (keys.p256dh || '') + '|' + (keys.auth || '');
    const enc = new TextEncoder();
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(fpSource));
    const fpArr = Array.from(new Uint8Array(digest));
    const fingerprint = fpArr.map(b=>b.toString(16).padStart(2,'0')).join('');
    const stored = localStorage.getItem('pushSubFingerprint');
    const tsRaw = localStorage.getItem('pushSubFingerprintTs');
    let expired = true;
    try { const ts = Number(tsRaw); if (ts && (Date.now() - ts) < 1000*60*60*12) expired = false; } catch {}
    if (stored === fingerprint && !expired) {
      // Ничего не изменилось и TTL (12h) ещё не истёк — не дергаем сервер заново.
      return;
    }
    await subscribePush(payload); // upsert на бэкенде
    localStorage.setItem('pushSubFingerprint', fingerprint);
    localStorage.setItem('pushSubFingerprintTs', String(Date.now()));
    try { console.debug('[push] subscription sent (updated or new)'); } catch {}
  } catch(e){
    // В случае ошибки fallback на прежнее поведение
    await subscribePush(payload);
  }
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
