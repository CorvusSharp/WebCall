// modules/friends_ui.js
// Логика отображения списка друзей, заявок, кнопок звонков и поиска.

import { els, makeBtn } from './core/dom.js';
import { appState } from './core/state.js';
import { notifyCall, acceptCall, declineCall, cancelCall, findUsers, listFriends, listFriendRequests, sendFriendRequest, acceptFriend } from '../api.js';
import { setActiveOutgoingCall, markCallAccepted, markCallDeclined, getActiveCall, getPendingIncomingInvites } from './calls.js';
import { selectDirectFriend } from './direct_chat.js';

let hooks = {
  log: (m)=>{},
  unlockAudioPlayback: ()=>{},
  connectRoom: ()=>{},           // () => void (подключение к roomId из els.roomId)
};

export function initFriendsModule(options={}){ hooks = { ...hooks, ...options }; }

function renderUserRow(container, u, opts={}){
  const row = document.createElement('div');
  row.className = 'list-item';
  const left = document.createElement('div'); left.className = 'grow';
  const bold = document.createElement('div'); bold.className = 'bold'; bold.textContent = u.username;
  const meta = document.createElement('div'); meta.className = 'muted small'; meta.textContent = `${u.email} • ${u.id?.slice?.(0,8)||''}`;
  left.appendChild(bold); left.appendChild(meta);
  const actions = document.createElement('div'); actions.setAttribute('style','display:flex; gap:8px;');
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
    const [friends, reqs] = await Promise.all([listFriends(), listFriendRequests()]);
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
          if (getActiveCall()) return;
          const rnd = crypto.randomUUID().slice(0,8);
          const friendTag = (f.username || f.user_id).replace(/[^a-zA-Z0-9]+/g,'').slice(0,6) || 'user';
          const room = `call-${rnd}-${friendTag}`;
          if (els.roomId) els.roomId.value = room;
          setActiveOutgoingCall(f, room);
          try { notifyCall(f.user_id, room).catch(()=>{}); } catch {}
          hooks.unlockAudioPlayback(); hooks.connectRoom();
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
  } catch(e){
    els.friendsList.innerHTML = '<div class="muted">Ошибка</div>';
    els.friendRequests.innerHTML = '<div class="muted">Ошибка</div>';
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
      const arr = await findUsers(q);
      els.friendSearchResults.innerHTML='';
      if (!arr.length) els.friendSearchResults.innerHTML = '<div class="muted">Ничего не найдено</div>';
      arr.forEach(u => {
        const btnAdd = makeBtn('Добавить','btn', async ()=>{
          try { await sendFriendRequest(u.id); alert('Заявка отправлена'); await loadFriends(); }
          catch(e){ alert(String(e)); }
        });
        renderUserRow(els.friendSearchResults, u, { actions:[btnAdd] });
      });
    } catch { els.friendSearchResults.innerHTML = '<div class="muted">Ошибка поиска</div>'; }
  });
  // Поиск по Enter
  els.friendSearch?.addEventListener('keydown', (e)=>{
    if (e.key === 'Enter') {
      e.preventDefault();
      els.btnFriendSearch?.click();
    }
  });
}
