// modules/visited_rooms.js
// Управление историей посещённых комнат.

import { els } from './core/dom.js';
import { appState } from './core/state.js';
import { bus } from './core/event_bus.js';

export async function loadVisitedRooms(){
  if (!els.visitedRooms) return;
  try {
    const rawToken = localStorage.getItem('wc_token');
    if (!rawToken) { els.visitedRooms.innerHTML = '<div class="muted">Войдите, чтобы увидеть историю комнат</div>'; return; }
    const r = await fetch('/api/v1/rooms/visited', { headers: { 'Authorization': `Bearer ${rawToken}` } });
    if (!r.ok){ els.visitedRooms.innerHTML = '<div class="muted">Не удалось загрузить историю</div>'; return; }
    const items = await r.json();
    let arr = Array.isArray(items) ? items : [];
    // Фильтруем эфемерные (call-*)
    arr = arr.filter(it => !(it.room_id || '').startsWith('call-'));
    if (!arr.length){ els.visitedRooms.innerHTML = '<div class="muted">История пуста</div>'; return; }
    els.visitedRooms.innerHTML = '';
    for (const it of arr){
      const div = document.createElement('div');
      div.className = 'list-item';
      const title = it.name || it.room_id;
      const when = new Date(it.last_seen).toLocaleString();
      const left = document.createElement('div'); left.className = 'grow';
      const b = document.createElement('div'); b.className = 'bold'; b.textContent = title;
      const meta = document.createElement('div'); meta.className = 'muted small'; meta.textContent = `${it.room_id} • ${when}`;
      left.appendChild(b); left.appendChild(meta);
      const right = document.createElement('div'); right.setAttribute('style','display:flex; gap:8px;');
      const btnJoin = document.createElement('button'); btnJoin.className = 'btn'; btnJoin.dataset.room = it.room_id; btnJoin.textContent = 'Войти';
      const btnDel = document.createElement('button'); btnDel.className = 'btn ghost danger'; btnDel.dataset.del = it.room_id; btnDel.title = 'Удалить из истории'; btnDel.textContent = 'Удалить';
      right.appendChild(btnJoin); right.appendChild(btnDel);
      div.appendChild(left); div.appendChild(right);
      btnJoin.addEventListener('click', ()=>{
        if (els.roomId) els.roomId.value = it.room_id;
        // Через внутреннюю шину событий
        bus.emit('join-room', { roomId: it.room_id });
      });
      btnDel.addEventListener('click', async ()=>{
        try {
          const resp = await fetch(`/api/v1/rooms/visited/${encodeURIComponent(it.room_id)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${rawToken}` }
          });
          if (resp.ok){
            div.remove();
            if (!els.visitedRooms.children.length){
              els.visitedRooms.innerHTML = '<div class="muted">История пуста</div>';
            }
          }
        } catch {}
      });
      els.visitedRooms.appendChild(div);
    }
  } catch (e) {
    try { els.visitedRooms.innerHTML = '<div class="muted">Ошибка загрузки</div>'; } catch {}
  }
}
