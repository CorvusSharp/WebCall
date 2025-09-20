// modules/direct_chat.js
// Логика личного чата (direct messages): выбор друга, загрузка истории, отправка, приём, unread.

import { els } from './core/dom.js';
import { appState } from './core/state.js';
// Клиентское E2EE отключено для DM: сервер возвращает plaintext.

// Внешние хуки (интеграция с друзьями и логами)
let hooks = {
  log: (msg)=>{},          // (string)
  getAccountId: ()=> null, // () => account UUID (JWT sub)
};

export function initDirectChatModule(options={}){ hooks = { ...hooks, ...options }; }

function updateFriendUnreadBadge(friendId){
  const btn = document.querySelector(`button.chat-btn[data-friend-id="${friendId}"]`);
  if (!btn) return;
  const count = appState.directUnread.get(friendId) || 0;
  if (count > 0){
    btn.classList.add('has-unread');
    btn.dataset.unread = String(count);
  } else {
    btn.classList.remove('has-unread');
    delete btn.dataset.unread;
  }
}

function appendDirectMessage(m, isSelf){
  if (!els.directMessages) return;
  const div = document.createElement('div');
  div.className = 'chat-line' + (isSelf ? ' self' : '');
  const dt = new Date(m.sent_at || m.sentAt || Date.now());
  const ts = dt.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const full = dt.toLocaleString();
  const whoSpan = document.createElement('span'); whoSpan.className = 'who'; whoSpan.textContent = isSelf ? 'Я' : (m.from_user_id||m.fromUserId||'--').slice(0,6);
  const msgSpan = document.createElement('span'); msgSpan.className = 'msg'; msgSpan.textContent = m.content;
  const timeSpan = document.createElement('span'); timeSpan.className = 'time'; timeSpan.title = full; timeSpan.textContent = ts;
  timeSpan.style.marginLeft = '6px';
  div.appendChild(whoSpan); div.appendChild(msgSpan); div.appendChild(timeSpan);
  els.directMessages.appendChild(div);
}
function scrollDirectToEnd(){ try { els.directMessages.scrollTop = els.directMessages.scrollHeight; } catch {} }

// scheduleAutoRedecrypt удалён — не требуется.

export async function selectDirectFriend(friendId, label, opts={}){
  const already = appState.currentDirectFriend === friendId;
  appState.currentDirectFriend = friendId;
  if (els.directChatCard) els.directChatCard.style.display = '';
  if (els.directChatTitle) els.directChatTitle.textContent = 'Чат с: ' + (label || friendId.slice(0,8));
  // E2EE отключено — никакой ensureE2EEKeys.
  ensureDirectActions();
  if (already && !opts.force){
    if (appState.directUnread.has(friendId)) { appState.directUnread.delete(friendId); updateFriendUnreadBadge(friendId); }
    const hasAny = !!els.directMessages && els.directMessages.querySelector('.chat-line');
    const showsEmpty = !!els.directMessages && /Пусто|Загрузка|Ошибка/.test(els.directMessages.textContent||'');
    if (!hasAny || showsEmpty){ return await selectDirectFriend(friendId, label, { force: true }); }
    return;
  }
  if (appState.directUnread.has(friendId)) { appState.directUnread.delete(friendId); updateFriendUnreadBadge(friendId); }
  try {
    const t = localStorage.getItem('wc_token');
    fetch(`/api/v1/direct/${friendId}/read-ack`, { method: 'POST', headers: { 'content-type':'application/json','Authorization': `Bearer ${t}` }, body: JSON.stringify({}) }).catch(()=>{});
  } catch {}
  if (els.directMessages) els.directMessages.innerHTML = '<div class="muted">Загрузка...</div>';
  try {
    const t = localStorage.getItem('wc_token');
    const r = await fetch(`/api/v1/direct/${friendId}/messages`, { headers: { 'Authorization': `Bearer ${t}` } });
    const arr = await r.json();
    let seen = new Set();
    appState.directSeenByFriend.set(friendId, seen);
    let added = 0;
    if (Array.isArray(arr) && arr.length){
      els.directMessages.innerHTML = '';
      arr.forEach(m => {
        if (m.id) seen.add(m.id); added++;
        appendDirectMessage(m, m.from_user_id === hooks.getAccountId());
      });
  // plaintext уже
      if (added === 0) els.directMessages.innerHTML = '<div class="muted">Пусто</div>'; else scrollDirectToEnd();
    } else {
      els.directMessages.innerHTML = '<div class="muted">Пусто</div>';
      setTimeout(async ()=>{
        try {
          const t2 = localStorage.getItem('wc_token');
          const r2 = await fetch(`/api/v1/direct/${friendId}/messages`, { headers:{ 'Authorization': `Bearer ${t2}` } });
          if (r2.ok){
            const arr2 = await r2.json();
            if (Array.isArray(arr2) && arr2.length){
              els.directMessages.innerHTML='';
              let seen2 = appState.directSeenByFriend.get(friendId);
              if (!seen2){ seen2 = new Set(); appState.directSeenByFriend.set(friendId, seen2); }
              let added2 = 0;
              arr2.forEach(m => { if (m.id && !seen2.has(m.id)){ seen2.add(m.id); added2++; appendDirectMessage(m, m.from_user_id === hooks.getAccountId()); } });
              // plaintext уже
              if (added2 === 0) els.directMessages.innerHTML = '<div class="muted">Пусто</div>'; else scrollDirectToEnd();
            }
          }
        } catch {}
      }, 600);
    }
  } catch {
    try { els.directMessages.innerHTML = '<div class="muted">Ошибка загрузки</div>'; } catch {}
  }
}

export function handleIncomingDirect(msg){
  const acc = hooks.getAccountId();
  const other = msg.fromUserId === acc ? msg.toUserId : msg.fromUserId;
  const show = appState.currentDirectFriend && other === appState.currentDirectFriend;
  if (show){
    const mid = msg.messageId || msg.id;
    let seen = appState.directSeenByFriend.get(appState.currentDirectFriend);
    if (!seen){ seen = new Set(); appState.directSeenByFriend.set(appState.currentDirectFriend, seen); }
    if (mid && seen.has(mid)) return;
    if (mid) seen.add(mid);
    (async ()=>{
      appendDirectMessage({ id: mid, from_user_id: msg.fromUserId, content: msg.content, sent_at: msg.sentAt }, msg.fromUserId === acc);
      scrollDirectToEnd();
    })();
  } else {
    if (acc && msg.fromUserId !== acc){
      const prev = appState.directUnread.get(other) || 0;
      appState.directUnread.set(other, prev + 1);
      updateFriendUnreadBadge(other);
      // Уведомление на каждое 10-е непросмотренное сообщение (10,20,30 ...)
      try {
        const unreadNow = prev + 1;
        if (unreadNow % 10 === 0 && Notification && Notification.permission === 'granted'){
            new Notification('Новые сообщения', { body: `Еще ${unreadNow} непрочитанных от собеседника` });
        }
      } catch {}
    }
  }
}

export function handleDirectCleared(msg){
  if (!appState.currentDirectFriend) return;
  const acc = hooks.getAccountId(); if (!acc) return;
  const ids = msg.userIds || [];
  if (ids.includes(acc) && ids.includes(appState.currentDirectFriend)){
    if (els.directMessages) els.directMessages.innerHTML = '<div class="muted">Пусто</div>';
    appState.directSeenByFriend.set(appState.currentDirectFriend, new Set());
    appState.directUnread.delete(appState.currentDirectFriend);
    updateFriendUnreadBadge(appState.currentDirectFriend);
  }
}

function ensureDirectActions(){
  if (!els.directActions) return;
  if (!els.directActions.querySelector('[data-act="clear"]')){
    const btn = document.createElement('button');
    btn.className = 'btn danger ghost';
    btn.textContent = 'Очистить чат';
    btn.dataset.act = 'clear';
    btn.addEventListener('click', async ()=>{
      if (!appState.currentDirectFriend) return;
      if (!confirm('Удалить всю переписку?')) return;
      try {
        const t = localStorage.getItem('wc_token');
        const r = await fetch(`/api/v1/direct/${appState.currentDirectFriend}/messages`, { method:'DELETE', headers:{ 'Authorization': `Bearer ${t}` } });
        if (r.ok){
          const j = await r.json();
          if (els.directMessages) els.directMessages.innerHTML = '<div class="muted">Пусто</div>';
          appState.directSeenByFriend.set(appState.currentDirectFriend, new Set());
          hooks.log && hooks.log(`Переписка удалена (${j.removed||0})`);
        }
      } catch {}
    });
    els.directActions.appendChild(btn);
  }
}

export function bindSendDirect(){
  if (!els.btnDirectSend) return;
  els.btnDirectSend.addEventListener('click', async ()=>{
    if (!appState.currentDirectFriend) return;
    const text = (els.directInput?.value || '').trim();
    if (!text) return;
    try {
      const ct = text; // отправляем plaintext
      const t = localStorage.getItem('wc_token');
      const r = await fetch(`/api/v1/direct/${appState.currentDirectFriend}/messages`, { method:'POST', headers:{ 'content-type':'application/json','Authorization': `Bearer ${t}` }, body: JSON.stringify({ content: ct }) });
      if (r.ok){
        const m = await r.json();
        let seen = appState.directSeenByFriend.get(appState.currentDirectFriend);
        if (!seen){ seen = new Set(); appState.directSeenByFriend.set(appState.currentDirectFriend, seen); }
        if (m.id && !seen.has(m.id)){
          seen.add(m.id);
          appendDirectMessage({ id: m.id, from_user_id: hooks.getAccountId(), content: text, sent_at: m.sent_at || new Date().toISOString() }, true);
          scrollDirectToEnd();
        }
      }
    } catch (e){ console.error('send direct failed', e); }
    els.directInput.value='';
  });
  els.directInput?.addEventListener('keydown', e=>{ if (e.key==='Enter') els.btnDirectSend.click(); });
}
