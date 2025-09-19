// core/dom.js
// Сбор ссылок на DOM и простые утилиты для текстов, логов, кнопок.

export const els = {
  roomId: document.getElementById('roomId'),
  btnConnect: document.getElementById('btnConnect'),
  btnLeave: document.getElementById('btnLeave'),
  btnCopyLink: document.getElementById('btnCopyLink'),
  btnSend: document.getElementById('btnSend'),
  chatInput: document.getElementById('chatInput'),
  connStatus: document.getElementById('connStatus'),
  callContext: document.getElementById('callContext'),
  logs: document.getElementById('logs'),
  chat: document.getElementById('chat'),
  btnToggleMic: document.getElementById('btnToggleMic'),
  localVideo: document.getElementById('localVideo'),
  peersGrid: document.getElementById('peersGrid'),
  stats: document.getElementById('stats'),
  micSel: document.getElementById('micSel'),
  camSel: document.getElementById('camSel'),
  spkSel: document.getElementById('spkSel'),
  btnDiag: document.getElementById('btnDiag'),
  btnToggleTheme: document.getElementById('btnToggleTheme'),
  btnLogout: document.getElementById('btnLogout'),
  currentUserBadge: document.getElementById('currentUserBadge'),
  currentUsername: document.getElementById('currentUsername'),
  membersList: document.getElementById('membersList'),
  visitedRooms: document.getElementById('visitedRooms'),
  friendsCard: document.getElementById('friendsCard'),
  friendsList: document.getElementById('friendsList'),
  friendRequests: document.getElementById('friendRequests'),
  friendSearch: document.getElementById('friendSearch'),
  btnFriendSearch: document.getElementById('btnFriendSearch'),
  friendSearchResults: document.getElementById('friendSearchResults'),
  preJoinControls: document.getElementById('preJoinControls'),
  inCallControls: document.getElementById('inCallControls'),
  inCallSection: document.getElementById('inCallSection'),
  visitedCard: document.getElementById('visitedCard'),
  statusCard: document.getElementById('statusCard'),
  directChatCard: document.getElementById('directChatCard'),
  directChatTitle: document.getElementById('directChatTitle'),
  directMessages: document.getElementById('directMessages'),
  directInput: document.getElementById('directInput'),
  btnDirectSend: document.getElementById('btnDirectSend'),
  directActions: document.getElementById('directActions'),
  permBanner: document.getElementById('permBanner'),
  toastRegion: document.getElementById('toastRegion'),
};

export function setText(el, text){ if (el) el.textContent = text; }
export function setEnabled(btn, enabled){ if (btn) btn.disabled = !enabled; }
export function appendLog(container, msg){
  if (!container) return;
  const line = document.createElement('div');
  line.className = 'log-line';
  const t = document.createElement('span'); t.className = 'time'; t.textContent = new Date().toLocaleTimeString();
  const m = document.createElement('span'); m.className = 'msg'; m.textContent = msg;
  line.appendChild(t); line.appendChild(m);
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}
export function appendChat(container, who, content, opts={}){
  if (!container) return;
  const div = document.createElement('div'); div.className = 'chat-line' + (opts.self ? ' self' : '');
  const w = document.createElement('span'); w.className = 'who'; w.textContent = who;
  const c = document.createElement('span'); c.className = 'msg'; c.textContent = content;
  const tm = document.createElement('span'); tm.className = 'time'; tm.textContent = new Date().toLocaleTimeString();
  div.appendChild(w); div.appendChild(c); div.appendChild(tm);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}
export function bind(el, evt, fn){ if (el) el.addEventListener(evt, fn); }

export function makeBtn(label, cls='btn', onClick){
  const b = document.createElement('button'); b.className = cls; b.textContent = label; b.addEventListener('click', onClick); return b;
}

// ===== Toast / уведомления =====
/**
 * Показ краткого toast сообщения поверх интерфейса.
 * Автоматически создаёт контейнер если отсутствует.
 * @param {string} message
 * @param {{ type?: 'info'|'success'|'error', timeoutMs?: number }} [opts]
 */
export function showToast(message, opts={}){
  const { type='info', timeoutMs = 3500 } = opts;
  let region = els.toastRegion;
  if (!region){
    region = document.createElement('div');
    region.id = 'toastRegion';
    region.setAttribute('role','status');
    region.setAttribute('aria-live','polite');
    region.style.position='fixed';
    region.style.top='14px';
    region.style.right='14px';
    region.style.display='flex';
    region.style.flexDirection='column';
    region.style.gap='10px';
    region.style.zIndex='400';
    document.body.appendChild(region);
    els.toastRegion = region;
  }
  const item = document.createElement('div');
  item.className = `wc-toast wc-toast-${type}`;
  item.textContent = message;
  item.style.cursor='pointer';
  item.addEventListener('click', ()=>{ try { region.removeChild(item); } catch {} });
  region.appendChild(item);
  setTimeout(()=>{ try { item.classList.add('leaving'); } catch {}; setTimeout(()=>{ try { region.removeChild(item); } catch {}; }, 320); }, timeoutMs);
}

