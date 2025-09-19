// modules/permissions.js
// Управление правами: микрофон и уведомления + баннер.

import { els } from './core/dom.js';

export async function requestMicIfNeeded(opts={}){
  try {
    if (navigator.permissions && navigator.permissions.query){
      const st = await navigator.permissions.query({ name:'microphone' });
      if (st.state === 'granted') return true;
    }
  } catch {}
  try {
    await navigator.mediaDevices.getUserMedia({ audio:true });
    return true;
  } catch(e){
    if (!opts.silent) alert('Нет доступа к микрофону. Разрешите в настройках браузера.');
    return false;
  }
}

export async function ensurePushPermission(opts={}){
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    const perm = await Notification.requestPermission();
    return perm === 'granted';
  } catch { return false; }
}

export function updatePermBanner(){
  if (!els.permBanner) return;
  const banner = els.permBanner;
  const msgs = [];
  (async () => {
    try {
      if (navigator.permissions && navigator.permissions.query){
        const st = await navigator.permissions.query({ name:'microphone' });
        if (st.state === 'denied') msgs.push('Доступ к микрофону запрещён. Разрешите в настройках браузера.');
        else if (st.state === 'prompt') msgs.push('Предоставьте доступ к микрофону для звонков.');
      }
    } catch {}
    try {
      if ('Notification' in window){
        if (Notification.permission === 'denied') msgs.push('Уведомления заблокированы. Разрешите их в настройках браузера.');
        else if (Notification.permission === 'default') msgs.push('Разрешите отправку уведомлений, чтобы получать оповещения о звонках.');
      }
    } catch {}
    if (msgs.length){
      banner.innerHTML = '';
      msgs.forEach(m => { const el = document.createElement('div'); el.className='warn'; el.textContent = m; banner.appendChild(el); });
      banner.style.display = '';
    } else {
      banner.innerHTML=''; banner.style.display='none';
    }
  })();
}

export async function checkAndRequestPermissionsInitial(){
  try { await requestMicIfNeeded({ silent:true }); } catch {}
  try { await ensurePushPermission({ silent:true }); } catch {}
  updatePermBanner();
}

// Глобальные функции для кнопок в HTML (если они есть)
window.__wc_requestMic = () => requestMicIfNeeded({ silent:false }).then(()=> updatePermBanner());
window.__wc_requestPush = () => ensurePushPermission({ silent:false }).then(()=> updatePermBanner());
