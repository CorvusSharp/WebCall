// modules/friends_ui.js
// Логика отображения списка друзей, заявок, кнопок звонков и поиска.

import { els, makeBtn } from './core/dom.js';
import { appState } from './core/state.js';
import { notifyCall, acceptCall, declineCall, cancelCall, findUsers, listFriends, listFriendRequests, sendFriendRequest, acceptFriend } from '../api.js';
import { getActiveCall, getPendingIncomingInvites } from './calls.js'; // legacy (activeCall пока может использоваться)
import { startOutgoingCall as startOutgoingCallNew } from './calls_signaling.js';
import { selectDirectFriend } from './direct_chat.js';

let hooks = {
  log: (m)=>{},
  unlockAudioPlayback: ()=>{},
  connectRoom: ()=>{},           // () => void (подключение к roomId из els.roomId)
};

// ===== Онлайн статус друзей =====
// Простая эвристика: если видели активность (сообщение, сигнал звонка, вступление в звонок) < FRIEND_ONLINE_WINDOW -> online
// ===== Presence через сервер =====
const onlineUsers = new Set();
export function setOnlineSnapshot(arr){ try { onlineUsers.clear(); (arr||[]).forEach(id=> onlineUsers.add(String(id).toLowerCase())); } catch{} }
export function addOnlineUser(id){ if(!id) return; onlineUsers.add(String(id).toLowerCase()); }
export function removeOnlineUser(id){ if(!id) return; onlineUsers.delete(String(id).toLowerCase()); }
export function markFriendSeen(friendId){ /* больше не используется для presence, оставляем заглушку для совместимости */ }
export function refreshFriendStatuses(){
  try {
    document.querySelectorAll('#friendsList .list-item').forEach(li => {
      const fid = (li.getAttribute('data-friend-id')||'').toLowerCase(); if (!fid) return;
      const dot = li.querySelector('.status-dot'); if (!dot) return;
      const online = onlineUsers.has(fid);
      dot.classList.toggle('online', online);
      dot.classList.toggle('offline', !online);
      dot.title = online ? 'Онлайн' : 'Оффлайн';
    });
  } catch{}
}

export function initFriendsModule(options={}){ hooks = { ...hooks, ...options }; }

function renderUserRow(container, u, opts={}){
  const row = document.createElement('div');
  row.className = 'list-item';
  row.setAttribute('data-friend-id', u.id || u.user_id || '');
  const left = document.createElement('div'); left.className = 'grow';
  const bold = document.createElement('div'); bold.className = 'bold';
  const statusDot = document.createElement('span'); statusDot.className='status-dot offline'; statusDot.title='Оффлайн';
  bold.appendChild(statusDot);
  const nameSpan = document.createElement('span'); nameSpan.textContent = u.username; bold.appendChild(nameSpan);
  const meta = document.createElement('div'); meta.className = 'muted small'; meta.textContent = `${u.email} • ${u.id?.slice?.(0,8)||''}`;
  left.appendChild(bold); left.appendChild(meta);
  const actions = document.createElement('div'); actions.className='list-item-actions';
  row.appendChild(left); row.appendChild(actions);
  (opts.actions || []).forEach(a => actions.appendChild(a));
  if (opts.onSelectDirect){
    row.style.cursor='pointer';
    row.addEventListener('click', ()=> opts.onSelectDirect(u));
  }
  container.appendChild(row);
}

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

export async function loadFriends(){
  if (!els.friendsList || !els.friendRequests) return;
  const prevDirect = appState.currentDirectFriend;
  els.friendsList.innerHTML = '<div class="muted">Загрузка...</div>';
  els.friendRequests.innerHTML = '<div class="muted">Загрузка...</div>';
  try {
    const startedAt = Date.now();
    let friends, reqs;
    try {
      [friends, reqs] = await Promise.all([listFriends(), listFriendRequests()]);
    } catch(e){
      console.warn('[friends_ui] Ошибка загрузки списков друзей/заявок:', e);
      throw e; // пробрасываем дальше в общий catch
    }
    if (!Array.isArray(friends)) { console.warn('[friends_ui] Неверный формат friends', friends); friends = []; }
    if (!Array.isArray(reqs)) { console.warn('[friends_ui] Неверный формат friend requests', reqs); reqs = []; }
    els.friendsList.innerHTML = '';
    if (!friends.length) els.friendsList.innerHTML = '<div class="muted">Нет друзей</div>';
    const activeCall = getActiveCall();
    const pendingInvites = getPendingIncomingInvites();
    friends.forEach(f => {
      if (typeof f.unread === 'number'){
        if (f.unread > 0) appState.directUnread.set(f.user_id, f.unread); else appState.directUnread.delete(f.user_id);
      }
      const callControls = [];
      const isActiveWith = activeCall && activeCall.withUserId === f.user_id && activeCall.status !== 'ended';
      if (!isActiveWith){
        const btnCall = makeBtn('Позвонить','btn primary', async (ev)=>{
          ev?.stopPropagation?.();
          startOutgoingCallNew(f);
        });
        callControls.push(btnCall);
      } else {
        if (activeCall.direction === 'outgoing' && activeCall.status === 'invited'){
          const span = document.createElement('span'); span.className='muted small'; span.textContent='Ожидание...';
          const btnCancel = makeBtn('Отменить','btn ghost', async (ev)=>{
            ev?.stopPropagation?.();
            try { if (activeCall.withUserId && activeCall.roomId) await cancelCall(activeCall.withUserId, activeCall.roomId); }
            catch { try { if (activeCall.withUserId && activeCall.roomId) await declineCall(activeCall.withUserId, activeCall.roomId); } catch {} }
            // Сброс будет инициирован через модуль calls внешне
            // markCallDeclined(activeCall.roomId); оставим логику централизованной
          });
          callControls.push(span, btnCancel);
        } else if (activeCall.status === 'accepted'){
          const span = document.createElement('span'); span.className='muted small'; span.textContent='В звонке'; callControls.push(span);
        } else if (activeCall.status === 'declined'){
          const span = document.createElement('span'); span.className='muted small'; span.textContent='Отклонён'; callControls.push(span);
        }
      }
      const btnChat = makeBtn('Чат','btn chat-btn', ()=> selectDirectFriend(f.user_id, f.username || f.user_id));
      btnChat.addEventListener('click', e=> e.stopPropagation());
      btnChat.dataset.friendId = f.user_id;
      const btnDel = makeBtn('Удалить','btn danger ghost', async (ev)=>{
        ev?.stopPropagation?.();
        if (!confirm('Удалить этого друга?')) return;
        try {
          const t = localStorage.getItem('wc_token');
          const resp = await fetch(`/api/v1/friends/${f.user_id}`, { method:'DELETE', headers:{ 'Authorization': `Bearer ${t}` } });
          if (resp.ok){
            if (appState.currentDirectFriend === f.user_id){
              appState.currentDirectFriend = null;
              if (els.directChatTitle) els.directChatTitle.textContent = 'Личный чат';
              if (els.directMessages) els.directMessages.innerHTML = '<div class="muted">Выберите друга</div>';
            }
            appState.directSeenByFriend.delete(f.user_id);
            appState.directUnread.delete(f.user_id);
            await loadFriends();
          } else alert('Не удалось удалить');
        } catch(e){ alert('Ошибка: '+e); }
      });
      renderUserRow(els.friendsList, { id:f.user_id, username:f.username||f.user_id, email:f.email||'' }, {
        actions: [...callControls, btnChat, btnDel],
        onSelectDirect: (user)=> selectDirectFriend(user.id, user.username || user.id)
      });
      updateFriendUnreadBadge(f.user_id);
    });
    if (prevDirect && friends.some(fr => fr.user_id === prevDirect)){
      const fr = friends.find(fr => fr.user_id === prevDirect);
      if (fr && els.directChatTitle && appState.currentDirectFriend === prevDirect){
        els.directChatTitle.textContent = 'Чат с: ' + (fr.username || prevDirect.slice(0,8));
      }
    }
    // Requests
    els.friendRequests.innerHTML='';
    if (!reqs.length) els.friendRequests.innerHTML = '<div class="muted">Нет заявок</div>';
    reqs.forEach(r => {
      const btnAccept = makeBtn('Принять','btn success', async ()=>{ try { await acceptFriend(r.user_id); await loadFriends(); } catch(e){ alert(String(e)); } });
      renderUserRow(els.friendRequests, { id:r.user_id, username:r.username || r.user_id, email:r.email || '' }, { actions:[btnAccept] });
    });
    // Обновим статусы после полной перерисовки
    refreshFriendStatuses();
  } catch(e){
    const msg = (e && e.message) ? e.message : 'Ошибка';
    const needsUsernameFix = /Username must be 3-32 chars/.test(msg);
    const extra = needsUsernameFix ? `<div class="small" style="margin-top:6px;">
      Требуется валидный username. <button class="btn btn-sm" id="btnGoProfile">Исправить профиль</button>
    </div>` : '';
    const html = `<div class="muted">Ошибка загрузки: ${msg}</div>${extra}`;
    els.friendsList.innerHTML = html;
    els.friendRequests.innerHTML = html;
    if (needsUsernameFix){
      setTimeout(()=>{
        const b = document.getElementById('btnGoProfile');
        if (b){
          b.addEventListener('click', ()=>{ try { location.href='/profile.html'; } catch {} });
        }
      }, 30);
    }
  }
}

let _friendsReloadTimer = null;
export function scheduleFriendsReload(){
  if (_friendsReloadTimer) clearTimeout(_friendsReloadTimer);
  _friendsReloadTimer = setTimeout(()=>{ loadFriends(); }, 300);
}

export function initFriendsUI(){
  if (!els.friendsCard) return;
  els.btnFriendSearch?.addEventListener('click', async ()=>{
    const q = (els.friendSearch?.value || '').trim();
    if (!q) return;
    els.friendSearchResults.innerHTML = '<div class="muted">Поиск...</div>';
    try {
      const t0 = performance.now();
      const arr = await findUsers(q);
      const dt = (performance.now()-t0).toFixed(0);
      els.friendSearchResults.innerHTML='';
      if (!Array.isArray(arr)) {
        console.warn('[friends_ui] findUsers: ожидался массив, получено', arr);
        els.friendSearchResults.innerHTML = '<div class="muted">Неверный ответ сервера</div>';
        return;
      }
      if (!arr.length) {
        els.friendSearchResults.innerHTML = '<div class="muted">Ничего не найдено</div>';
        return;
      }
      arr.forEach(u => {
        const btnAdd = makeBtn('Добавить','btn', async ()=>{
          try { await sendFriendRequest(u.id); alert('Заявка отправлена'); await loadFriends(); }
          catch(e){ alert('Ошибка отправки: '+ String(e?.message||e)); }
        });
        renderUserRow(els.friendSearchResults, u, { actions:[btnAdd] });
      });
      console.debug(`[friends_ui] Поиск "${q}" -> ${arr.length} (за ${dt}мс)`);
    } catch(e) {
      console.warn('[friends_ui] Ошибка поиска пользователей:', e);
      els.friendSearchResults.innerHTML = `<div class="muted">Ошибка поиска: ${e?.message||e}</div>`;
    }
  });
  // Поиск по Enter
  els.friendSearch?.addEventListener('keydown', (e)=>{
    if (e.key === 'Enter') {
      e.preventDefault();
      els.btnFriendSearch?.click();
    }
  });
}
