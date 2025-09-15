// main.js — вход (исправлено: логируем адрес WS, кнопка диагностики, стабильные presence/инициация)
import { buildWs, subscribePush, findUsers, listFriends, listFriendRequests, sendFriendRequest, acceptFriend, notifyCall, acceptCall, declineCall } from './api.js?v=2';

// ===== RUNTIME AUTH GUARD =====
// Если пользователь не авторизован (нет валидного JWT в localStorage) —
// сразу редиректим на страницу авторизации, прокидывая redirect обратно на текущий путь.
// Это предотвращает «первый заход без регистрации» в интерфейс звонка.
try {
  const rawToken = localStorage.getItem('wc_token');
  let needAuth = !rawToken;
  if (rawToken) {
    try {
      const payload = JSON.parse(atob(rawToken.split('.')[1]));
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && now >= payload.exp) needAuth = true;
    } catch { needAuth = true; }
  }
  if (needAuth) {
    const redirectTarget = location.pathname + location.search;
    const params = new URLSearchParams({ redirect: redirectTarget.startsWith('/') ? redirectTarget : '/call' });
    // Если есть параметр room в URL — передадим его отдельно, чтобы после логина сразу войти
    try {
      const url = new URL(location.href);
      const room = url.searchParams.get('room');
      if (room) params.set('room', room);
    } catch {}
    location.replace(`/auth?${params.toString()}`);
    // Прерываем дальнейшее выполнение скрипта
    throw new Error('__halt_main_init');
  }
} catch (e) {
  if (e && e.message === '__halt_main_init') { /* silent stop */ }
  else { /* не блокируем работу если что-то пошло совсем не так */ }
}
import * as signal from './signal.js';
import { WebRTCManager } from './webrtc.js';
import { bind, setText, setEnabled, appendLog, appendChat } from './ui.js';

let token = null;
let ws = null;
let rtc = null;
// connId — уникальный идентификатор соединения в комнате (UUID v4)
let userId = null;
// accountId — идентификатор аккаунта из JWT (для будущих нужд/отображения)
let accountId = null;
let reconnectTimeout = null;
let isManuallyDisconnected = false;
let pingTimer = null;
let isReconnecting = false;
let selected = { mic: null, cam: null, spk: null };
let audioUnlocked = false;
let globalAudioCtx = null;
let latestUserNames = {}; // { connId: displayName }
let friendsWs = null;
let currentDirectFriend = null; // UUID друга выбранного в личном чате
// Пер-друг кэш id сообщений чтобы не дублировать (Map<friendId, Set<msgId>>)
const directSeenByFriend = new Map();
// Количество непрочитанных per друг
const directUnread = new Map();

// ===== Call state (эфемерные звонки) =====
// activeCall: { roomId, withUserId, direction: 'outgoing'|'incoming', status: 'invited'|'accepted'|'declined'|'ended' }
let activeCall = null;
// pendingIncomingInvites: Map<fromUserId, { roomId, username }>
const pendingIncomingInvites = new Map();

function resetActiveCall(reason){
  if (activeCall){
    // Попытаемся восстановить подпись
    if (els.callContext) els.callContext.textContent = '';
  }
  activeCall = null;
  // Перерисовать друзей (вернёт кнопку Позвонить)
  try { loadFriends(); } catch {}
}

function setActiveOutgoingCall(friend, roomId){
  activeCall = { roomId, withUserId: friend.user_id, direction: 'outgoing', status: 'invited' };
  if (els.callContext) els.callContext.textContent = `Исходящий звонок: ${friend.username || friend.user_id}`;
  // обновим список друзей чтобы скрыть кнопку Позвонить и показать статус
  loadFriends();
}

function setActiveIncomingCall(fromUserId, username, roomId){
  activeCall = { roomId, withUserId: fromUserId, direction: 'incoming', status: 'invited' };
  if (els.callContext) els.callContext.textContent = `Входящий звонок от: ${username || fromUserId}`;
  pendingIncomingInvites.set(fromUserId, { roomId, username });
  loadFriends();
}

function markCallAccepted(roomId){
  if (activeCall && activeCall.roomId === roomId){
    activeCall.status = 'accepted';
    if (els.callContext) els.callContext.textContent = `Звонок с: ${activeCall.withUserId}`;
  }
  loadFriends();
}

function markCallDeclined(roomId){
  if (activeCall && activeCall.roomId === roomId){
    activeCall.status = 'declined';
    setTimeout(()=> resetActiveCall('declined'), 1500);
  }
  loadFriends();
}

function updateFriendUnreadBadge(friendId){
  // Находим кнопку чата по data-friend-id
  const btn = document.querySelector(`button.chat-btn[data-friend-id="${friendId}"]`);
  if (!btn) return;
  const count = directUnread.get(friendId) || 0;
  if (count > 0){
    btn.classList.add('has-unread');
    btn.dataset.unread = String(count);
  } else {
    btn.classList.remove('has-unread');
    delete btn.dataset.unread;
  }
}

const els = {
  roomId: document.getElementById('roomId'),
  btnConnect: document.getElementById('btnConnect'),
  btnLeave: document.getElementById('btnLeave'),
  btnCopyLink: document.getElementById('btnCopyLink'),
  btnSend: document.getElementById('btnSend'),
  chatInput: document.getElementById('chatInput'),
  connStatus: document.getElementById('connStatus'),
  callContext: document.getElementById('callContext'), // новый элемент для подписи активного эфемерного звонка
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
  membersList: document.getElementById('membersList'),
  visitedRooms: document.getElementById('visitedRooms'),
  // Friends UI
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
  // Direct chat
  directChatCard: document.getElementById('directChatCard'),
  directChatTitle: document.getElementById('directChatTitle'),
  directMessages: document.getElementById('directMessages'),
  directInput: document.getElementById('directInput'),
  btnDirectSend: document.getElementById('btnDirectSend'),
  directActions: document.getElementById('directActions'),
  permBanner: document.getElementById('permBanner'),
};

function showPreJoin(){
  if (els.inCallControls) els.inCallControls.style.display = 'none';
  if (els.inCallSection) els.inCallSection.style.display = 'none';
  if (els.visitedCard) els.visitedCard.style.display = '';
  if (els.statusCard) els.statusCard.style.display = 'none';
}
function showInCall(){
  if (els.inCallControls) els.inCallControls.style.display = '';
  if (els.inCallSection) els.inCallSection.style.display = '';
  if (els.visitedCard) els.visitedCard.style.display = 'none';
  if (els.statusCard) els.statusCard.style.display = '';
}

// Безопасный пинг: используем экспорт из signal.js, либо локальный fallback
const sendPingSafe = signal.sendPing ?? ((ws) => {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  } catch {}
});

function log(msg){ appendLog(els.logs, msg); }
function stat(line){ els.stats && appendLog(els.stats, line); }

function setConnectingState(isConnecting) {
  setText(els.connStatus, isConnecting ? 'Подключение...' : 'Не подключено');
  setEnabled(els.btnConnect, !isConnecting);
  setEnabled(els.btnLeave, false);
  setEnabled(els.btnSend, false);
  setEnabled(els.btnToggleMic, false);
}

function setConnectedState(connected){
  setText(els.connStatus, connected ? 'Подключено' : 'Не подключено');
  setEnabled(els.btnConnect, !connected);
  setEnabled(els.btnSend, connected);
  setEnabled(els.btnLeave, connected);
  setEnabled(els.btnToggleMic, connected);
  // toggle stateful UI
  if (connected) showInCall(); else showPreJoin();
  if (!connected && els.callContext){ els.callContext.textContent = ''; }
}

function ensureToken(){
  token = localStorage.getItem('wc_token');
  if (!token){
    const params = new URLSearchParams({ redirect: '/call' });
    if (els.roomId.value) params.set('room', els.roomId.value);
    location.href = `/auth?${params.toString()}`;
    return false;
  }
  try{
    const payload = JSON.parse(atob(token.split('.')[1]));
    // Используем из токена только идентификатор аккаунта, но не для сигналинга
    accountId = payload.sub;
    const now = Math.floor(Date.now()/1000);
    if (payload.exp && now >= payload.exp) {
      localStorage.removeItem('wc_token');
      const params = new URLSearchParams({ redirect: '/call' });
      if (els.roomId.value) params.set('room', els.roomId.value);
      location.href = `/auth?${params.toString()}`;
      return false;
    }
  }catch{}
  return true;
}

function getStableConnId(){
  try{
    let id = sessionStorage.getItem('wc_connid');
    if (!id){ id = crypto.randomUUID(); sessionStorage.setItem('wc_connid', id); }
    return id;
  }catch{ return crypto.randomUUID(); }
}

// ===== Устройства
async function refreshDevices(){
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devs = await navigator.mediaDevices.enumerateDevices();
  const mics = devs.filter(d => d.kind === 'audioinput');
  const cams = devs.filter(d => d.kind === 'videoinput');
  const spks = devs.filter(d => d.kind === 'audiooutput');

  const fill = (sel, list, picked) => {
    if (!sel) return;
    sel.innerHTML = '';
    list.forEach(d => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Unknown ${d.kind}`;
      if (picked && picked === d.deviceId) o.selected = true;
      sel.appendChild(o);
    });
  };

  fill(els.micSel, mics, selected.mic);
  fill(els.camSel, cams, selected.cam);
  fill(els.spkSel, spks, selected.spk);

  const summary = devs.map(d => `${d.kind}:${d.label||'(no)'}:${(d.deviceId||'').slice(0,6)}`).join(' | ');
  stat(`Devices: ${summary}`);
}

[els.micSel, els.camSel, els.spkSel].forEach(sel => sel?.addEventListener('change', async ()=>{
  selected.mic = els.micSel?.value || null;
  selected.cam = els.camSel?.value || null;
  selected.spk = els.spkSel?.value || null;
  if (rtc) rtc.setPreferredDevices({ mic: selected.mic, cam: selected.cam, spk: selected.spk });
}));

// ===== Подключение
async function connect(){
  if (ws) return;
  isManuallyDisconnected = false;

  await ensureToken();
  if (!token) { log('Нет токена, нужна авторизация'); return; }

  const roomId = els.roomId.value.trim();
  if (!roomId) { log('Нужен ID комнаты'); return; }

  log(`Подключение к комнате ${roomId}...`);
  setConnectingState(true);

  ws = buildWs(roomId, token);
  userId = getStableConnId();
  log(`Мой connId: ${userId}`);
  log(`Адрес WS: ${ws.__debug_url}`);

  rtc = new WebRTCManager({
    localVideo: els.localVideo,
    outputDeviceId: selected.spk,
    onLog: log,
    onPeerState: (peerId, key, value) => {
      const tile = document.querySelector(`.tile[data-peer="${peerId}"]`);
      if (tile) tile.dataset[key] = value;
    }
  });

  ws.onopen = async () => {
    isReconnecting = false;
    log('WS открыт');
    setConnectedState(true);
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(()=> sendPingSafe(ws), 30000);

    // Сообщаем серверу о подключении (presence)
    try {
      const storedUname = localStorage.getItem('wc_username') || undefined;
      ws.send(JSON.stringify({ type: 'join', fromUserId: userId, username: storedUname }));
    } catch {}

    await rtc.init(ws, userId, { micId: selected.mic, camId: selected.cam });
    try{
      const hasVideo = !!(rtc.localStream && rtc.localStream.getVideoTracks()[0] && rtc.localStream.getVideoTracks()[0].enabled);
      const card = document.getElementById('localCard');
      if (card) card.style.display = hasVideo ? '' : 'none';
    }catch{}
    // после удачного коннекта обновим историю без перезагрузки
    try { await loadVisitedRooms(); } catch {}
  };

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === 'signal'){
      await rtc.handleSignal(msg, bindPeerMedia);
    }
    else if (msg.type === 'presence'){
      latestUserNames = msg.userNames || {};
      const readable = msg.users.map(u => latestUserNames[u] || u.slice(0,6));
      log(`В комнате: ${readable.join(', ')}`);
  // (membersList removed)
      // обновим подписи на уже созданных тайлах
      document.querySelectorAll('.tile').forEach(tile => {
        const pid = tile.getAttribute('data-peer');
        const nm = tile.querySelector('.name');
        if (pid && nm) nm.textContent = latestUserNames[pid] || `user-${pid.slice(0,6)}`;
      });
      const myId = getStableConnId();
      // Удаляем пиров, которых больше нет в комнате (по presence)
      const allowed = new Set(msg.users.filter(u => u !== myId));
      // 1) чистим плитки
      document.querySelectorAll('.tile').forEach(tile => {
        const pid = tile.getAttribute('data-peer');
        if (pid && !allowed.has(pid)){
          try{ const a = tile.querySelector('audio'); if (a){ a.pause?.(); a.srcObject = null; } }catch{}
          try{ const v = tile.querySelector('video'); if (v){ v.srcObject = null; } }catch{}
          tile.remove();
        }
      });
      // 2) закрываем RTCPeerConnection и удаляем из RTC
      if (rtc && rtc.peers){
        for (const [pid, st] of Array.from(rtc.peers.entries())){
          if (!allowed.has(pid)){
            try{ st.pc.onicecandidate = null; st.pc.close(); }catch{}
            try{ if (st.level?.raf) cancelAnimationFrame(st.level.raf); }catch{}
            rtc.peers.delete(pid);
          }
        }
      }
      for (const peerId of msg.users){
        if (peerId !== myId) {
          log(`Обнаружен пир ${peerId}, инициирую звонок...`);
          await rtc.startOffer(peerId);
        }
      }
    }
    else if (msg.type === 'user_joined'){
      log(`Присоединился: ${msg.userId}`);
      // Ничего не делаем, ждём presence
    }
    else if (msg.type === 'user_left'){
      log(`Отключился: ${msg.userId}`);
      const tile = document.querySelector(`.tile[data-peer="${msg.userId}"]`);
      if (tile) tile.remove();
    }
    else if (msg.type === 'chat'){
      // определяем ID отправителя (Redis может присылать authorId)
      const senderId = msg.fromUserId || msg.authorId;
      const who = msg.authorName || (senderId ? (latestUserNames[senderId] || senderId.slice(0,6)) : 'unknown');
      // self-эвристика: по session connId или (если сервер не прислал id) по локальному username
      let isSelf = false;
      const myConn = getStableConnId();
      if (senderId && senderId === myConn) {
        isSelf = true;
      } else {
        try {
          const storedU = localStorage.getItem('wc_username');
          if (!senderId && storedU && storedU === msg.authorName) isSelf = true;
          // Дополнительный fallback: если authorName совпадает и сообщение пришло почти мгновенно после отправки
          if (!isSelf && storedU && storedU === msg.authorName && Date.now() - (window.__lastChatSendTs||0) < 1500){
            isSelf = true;
          }
        } catch {}
      }
      appendChat(els.chat, who, msg.content, { self: isSelf });
    }
  };

  ws.onclose = (ev) => {
    log(`WS закрыт: ${ev.code} ${ev.reason}`);
    setConnectedState(false);
    if (pingTimer) clearInterval(pingTimer);
    if (rtc) { rtc.close(); rtc = null; }
    ws = null;

    if (!isManuallyDisconnected && !isReconnecting) {
      isReconnecting = true;
      log('Попытка переподключения через 3с...');
      reconnectTimeout = setTimeout(connect, 3000);
    }
  };

  ws.onerror = (err) => {
    log(`WS ошибка: ${err?.message || 'unknown'}`);
    try { ws?.close(); } catch{}
  };
}

function bindPeerMedia(peerId){
  if (document.querySelector(`.tile[data-peer="${peerId}"]`)) return;

  const tpl = document.getElementById('tpl-peer-tile');
  const tile = tpl.content.firstElementChild.cloneNode(true);
  tile.dataset.peer = peerId;
  els.peersGrid.appendChild(tile);

  const video = tile.querySelector('video');
  const audio = tile.querySelector('audio');
  const name = tile.querySelector('.name');
  const vol = tile.querySelector('input[type="range"][name="volume"]');
  const level = tile.querySelector('.level-bar');
  name.textContent = latestUserNames[peerId] || `user-${peerId.slice(0,6)}`;

  // включаем безопасное авто-воспроизведение
  if (video) { video.playsInline = true; video.autoplay = true; video.muted = true; }
  if (audio) { audio.autoplay = true; }

  rtc.bindPeerMedia(peerId, {
    onTrack: (stream) => {
      log(`Получен медиа-поток от ${peerId.slice(0,6)}`);
      if (video) video.srcObject = stream;
      if (audio) {
        audio.srcObject = stream;
        audio.muted = false;
  audio.volume = vol ? (Math.min(100, Math.max(0, Number(vol.value)||100)) / 100) : 1.0;
        audio.play().catch((e)=>{
          log(`audio.play() failed for ${peerId.slice(0,6)}: ${e?.name||e}`);
          unlockAudioPlayback();
          setTimeout(()=> audio.play().catch(()=>{}), 250);
        });
      }
    },
    onLevel: (value) => {
      level.style.transform = `scaleX(${value})`;
    },
    onSinkChange: (deviceId) => {
      // setSinkId поддерживается только для аудио
      if (audio && audio.setSinkId) {
        audio.setSinkId(deviceId).catch(e=>log(`sinkAudio(${peerId.slice(0,6)}): ${e.name}`));
      }
    }
  });

  if (vol && audio){
    vol.addEventListener('input', ()=>{
      const v = Math.min(100, Math.max(0, Number(vol.value)||0));
      audio.volume = v/100;
    });
  }

  // (participants volumes removed)
}


// Try to unlock browser audio autoplay policies
function unlockAudioPlayback(){
  if (audioUnlocked) return;
  audioUnlocked = true;
  try{
    // Create/resume a global AudioContext to satisfy iOS/Safari/Chrome policies
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx){
      if (!globalAudioCtx) globalAudioCtx = new Ctx();
      if (globalAudioCtx.state === 'suspended') globalAudioCtx.resume().catch(()=>{});
      // Play a tiny silent buffer
      const buffer = globalAudioCtx.createBuffer(1, 1, 22050);
      const source = globalAudioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(globalAudioCtx.destination);
      try{ source.start(0); }catch{}
    }
    // Attempt to play any existing <audio> elements
    document.querySelectorAll('audio').forEach(a=>{
      try{ a.muted = false; a.volume = 1.0; a.play().catch(()=>{}); }catch{}
    });
  }catch{}
}

function leave(){
  isManuallyDisconnected = true;
  try { ws.send(JSON.stringify({ type: 'leave', fromUserId: userId })); } catch {}
  if (ws) ws.close();
  if (rtc) { rtc.close(); rtc = null; }
  setConnectedState(false);
  els.peersGrid.innerHTML = '';
  log('Отключено');
  // если был активный звонок — сбросим статус
  if (activeCall) { resetActiveCall('leave'); }
  // обновим историю
  try { loadVisitedRooms(); } catch {}
}

// ===== Participants volumes list
  // (participants volumes feature removed)

// ===== UI
function setupUI(){
  bind(els.btnConnect, 'click', ()=>{ unlockAudioPlayback(); connect(); });
  bind(els.btnLeave, 'click', leave);
  bind(els.btnCopyLink, 'click', ()=>{
    const url = new URL(location.href);
    url.searchParams.set('room', els.roomId.value);
    navigator.clipboard.writeText(url.toString());
    log('Ссылка скопирована');
  });
  bind(els.btnSend, 'click', ()=>{
    const text = els.chatInput.value;
    if (text && ws) {
  (signal.sendChat || (()=>{}))(ws, text, getStableConnId());
  try{ window.__lastChatSendTs = Date.now(); }catch{}
  // Не добавляем локально, ждём эхо от сервера, чтобы унифицировать отображение
  els.chatInput.value = '';
    }
  });
  bind(els.chatInput, 'keydown', (e)=>{ if (e.key==='Enter') els.btnSend.click() });
  bind(els.btnToggleMic, 'click', async ()=>{
    if (!rtc) return;
    const enabled = await rtc.toggleMic();
    els.btnToggleMic.textContent = enabled ? 'Выкл.микро' : 'Вкл.микро';
  });
  bind(els.btnDiag, 'click', ()=> rtc?.diagnoseAudio());
  bind(els.btnToggleTheme, 'click', ()=>{
    const isDark = document.body.classList.toggle('dark');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  });
  if (els.btnLogout){
    bind(els.btnLogout, 'click', ()=>{
      try{ localStorage.removeItem('wc_token'); localStorage.removeItem('wc_username'); }catch{}
      try{ sessionStorage.removeItem('wc_connid'); }catch{}
      if (ws){ try{ ws.close(); }catch{} }
      // Перенаправляем на страницу авторизации
      const params = new URLSearchParams({ redirect: '/call' });
      if (els.roomId.value) params.set('room', els.roomId.value);
      location.href = `/auth?${params.toString()}`;
    });
  }

  // Fallback global unlock on any user gesture (first one only)
  const gestureUnlock = ()=>{ unlockAudioPlayback(); document.removeEventListener('click', gestureUnlock); document.removeEventListener('touchstart', gestureUnlock); };
  document.addEventListener('click', gestureUnlock, { once: true, capture: true });
  document.addEventListener('touchstart', gestureUnlock, { once: true, capture: true });

  // Restore theme
  if (localStorage.getItem('theme') === 'dark') document.body.classList.add('dark');

  // Restore room from URL
  const u = new URL(location.href);
  if (u.searchParams.has('room')) {
    els.roomId.value = u.searchParams.get('room');
  }

  // Load visited rooms for quick access
  loadVisitedRooms().catch(()=>{});
  initFriendsUI();
  // Изначально до входа
  showPreJoin();

  // Инициируем подписку на push (молча, без ошибок)
  try { initPush(); } catch {}

  // Проверка и запрос прав (микрофон/уведомления) при загрузке
  checkAndRequestPermissionsInitial();
}

// ===== Init
setConnectedState(false);
setupUI();
refreshDevices();
log('Приложение инициализировано');
// Автоподключение отключено: пользователь выбирает комнату вручную и жмёт Войти

async function loadVisitedRooms(){
  if (!els.visitedRooms) return;
  try{
    const rawToken = localStorage.getItem('wc_token');
    if (!rawToken) { els.visitedRooms.innerHTML = '<div class="muted">Войдите, чтобы увидеть историю комнат</div>'; return; }
    const r = await fetch('/api/v1/rooms/visited', { headers: { 'Authorization': `Bearer ${rawToken}` } });
    if (!r.ok){ els.visitedRooms.innerHTML = '<div class="muted">Не удалось загрузить историю</div>'; return; }
    const items = await r.json();
  let arr = Array.isArray(items) ? items : [];
  // Фильтруем эфемерные комнаты (call-*)
  arr = arr.filter(it => !(it.room_id || '').startsWith('call-'));
  if (!arr.length){ els.visitedRooms.innerHTML = '<div class="muted">История пуста</div>'; return; }
    els.visitedRooms.innerHTML = '';
  for (const it of arr){
      const div = document.createElement('div');
      div.className = 'list-item';
      const title = it.name || it.room_id;
      const when = new Date(it.last_seen).toLocaleString();
      div.innerHTML = `
        <div class="grow">
          <div class="bold">${title}</div>
          <div class="muted small">${it.room_id} • ${when}</div>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn" data-room="${it.room_id}">Войти</button>
          <button class="btn ghost danger" data-del="${it.room_id}" title="Удалить из истории">Удалить</button>
        </div>
      `;
      const btnJoin = div.querySelector('button[data-room]');
      btnJoin.addEventListener('click', ()=>{
        els.roomId.value = it.room_id;
        unlockAudioPlayback();
        connect();
      });
      const btnDel = div.querySelector('button[data-del]');
      btnDel.addEventListener('click', async ()=>{
        try{
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
        }catch{}
      });
      els.visitedRooms.appendChild(div);
    }
  }catch(e){
    try{ els.visitedRooms.innerHTML = '<div class="muted">Ошибка загрузки</div>'; }catch{}
  }
}

async function initPush(){
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
  if (Notification.permission === 'denied') { updatePermBanner(); return; }
  if (Notification.permission === 'default') {
    // не запрашиваем агрессивно второй раз здесь — оставляем checkAndRequestPermissionsInitial
    // чтобы пользователь инициировал через UI действие (жест) или баннер
    updatePermBanner();
    return;
  }
  const reg = await navigator.serviceWorker.getRegistration('/static/sw.js') || await navigator.serviceWorker.register('/static/sw.js');
  // Получаем публичный VAPID ключ
  const r = await fetch('/api/v1/push/vapid-public');
  const j = await r.json();
  const vapidKey = (j && j.key) ? urlBase64ToUint8Array(j.key) : null;
  const existing = await reg.pushManager.getSubscription();
  let sub = existing;
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey });
  }
  const payload = { endpoint: sub.endpoint, keys: sub.toJSON().keys };
  await subscribePush(payload);
}

function urlBase64ToUint8Array(base64String){
  if (!base64String) return null;
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

// ===== Friends UI =====
function renderUserRow(container, u, opts={}){
  const row = document.createElement('div');
  row.className = 'list-item';
  row.innerHTML = `
    <div class="grow">
      <div class="bold">${u.username}</div>
      <div class="muted small">${u.email} • ${u.id?.slice?.(0,8) || ''}</div>
    </div>
    <div style="display:flex; gap:8px;"></div>
  `;
  const actions = row.querySelector('div[style]');
  (opts.actions || []).forEach(a => actions.appendChild(a));
  if (opts.onSelectDirect){
    row.style.cursor = 'pointer';
    row.addEventListener('click', ()=> opts.onSelectDirect(u));
  }
  container.appendChild(row);
}

function makeBtn(label, cls='btn', onClick){ const b = document.createElement('button'); b.className = cls; b.textContent = label; b.addEventListener('click', onClick); return b; }

async function loadFriends(){
  if (!els.friendsList || !els.friendRequests) return;
  const prevDirect = currentDirectFriend; // запомним выбранного друга для чата
  els.friendsList.innerHTML = '<div class="muted">Загрузка...</div>';
  els.friendRequests.innerHTML = '<div class="muted">Загрузка...</div>';
  try{
    const [friends, reqs] = await Promise.all([listFriends(), listFriendRequests()]);
    // Friends
    els.friendsList.innerHTML = '';
    if (!friends.length) els.friendsList.innerHTML = '<div class="muted">Нет друзей</div>';
    friends.forEach(f => {
      const callControls = [];
      const isActiveWith = activeCall && activeCall.withUserId === f.user_id && activeCall.status !== 'ended';
      if (!isActiveWith){
        // Обычная кнопка Позвонить
        const btnCall = makeBtn('Позвонить', 'btn primary', async (event)=>{
          event?.stopPropagation?.();
          if (activeCall) return; // уже есть звонок
          const rnd = crypto.randomUUID().slice(0,8);
          const friendTag = (f.username || f.user_id).replace(/[^a-zA-Z0-9]+/g,'').slice(0,6) || 'user';
          const room = `call-${rnd}-${friendTag}`;
          els.roomId.value = room;
          try{ await notifyCall(f.user_id, room); }catch{}
          setActiveOutgoingCall(f, room);
          // Автоподключение
          try{ unlockAudioPlayback(); connect(); }catch{}
        });
        callControls.push(btnCall);
      } else {
        // Есть активный или входящий/исходящий звонок с этим пользователем
        if (activeCall.direction === 'incoming' && activeCall.status === 'invited'){
          // Показать Принять / Отклонить
            const btnAccept = makeBtn('Принять', 'btn success', async (ev)=>{
              ev?.stopPropagation?.();
              const info = pendingIncomingInvites.get(f.user_id);
              if (!info) return;
              try{
                await acceptCall(f.user_id, info.roomId);
                // join room
                els.roomId.value = info.roomId;
                try{ unlockAudioPlayback(); connect(); }catch{}
                markCallAccepted(info.roomId);
              }catch(e){ console.error(e); }
            });
            const btnDecline = makeBtn('Отклонить', 'btn danger ghost', async (ev)=>{
              ev?.stopPropagation?.();
              const info = pendingIncomingInvites.get(f.user_id);
              if (!info) return;
              try{ await declineCall(f.user_id, info.roomId); }catch{}
              pendingIncomingInvites.delete(f.user_id);
              markCallDeclined(info.roomId);
            });
            callControls.push(btnAccept, btnDecline);
        } else if (activeCall.direction === 'outgoing' && activeCall.status === 'invited'){
          const span = document.createElement('span');
          span.className = 'muted small';
          span.textContent = 'Ожидание...';
          callControls.push(span);
          const btnCancel = makeBtn('Отменить', 'btn ghost', (ev)=>{ ev?.stopPropagation?.(); try{ leave(); }catch{} resetActiveCall('cancel'); });
          callControls.push(btnCancel);
        } else if (activeCall.status === 'accepted'){
          const span = document.createElement('span');
          span.className = 'muted small';
          span.textContent = 'В звонке';
          callControls.push(span);
        } else if (activeCall.status === 'declined'){
          const span = document.createElement('span');
          span.className = 'muted small';
          span.textContent = 'Отклонён';
          callControls.push(span);
        }
      }
    const btnChat = makeBtn('Чат', 'btn chat-btn', ()=> selectDirectFriend(f.user_id, f.username || f.user_id));
    // ВАЖНО: не используем capture, иначе stopPropagation на стадии capture может прервать target-обработчик
    btnChat.addEventListener('click', e=> e.stopPropagation());
      btnChat.dataset.friendId = f.user_id;
      const btnDel = makeBtn('Удалить', 'btn danger ghost', async ()=>{
        event?.stopPropagation?.();
        if (!confirm('Удалить этого друга?')) return;
        try{
          const t = localStorage.getItem('wc_token');
          const r = await fetch(`/api/v1/friends/${f.user_id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${t}` } });
          if (r.ok){
            // локально обновим состояние (WS тоже придёт)
            if (currentDirectFriend === f.user_id){
              currentDirectFriend = null;
              if (els.directChatTitle) els.directChatTitle.textContent = 'Личный чат';
              if (els.directMessages) els.directMessages.innerHTML = '<div class="muted">Выберите друга</div>';
            }
            directSeenByFriend.delete(f.user_id);
            directUnread.delete(f.user_id);
            await loadFriends();
          } else {
            alert('Не удалось удалить');
          }
        }catch(e){ alert('Ошибка: '+e); }
      });
      renderUserRow(els.friendsList, { id: f.user_id, username: f.username || f.user_id, email: f.email || '' }, {
        actions: [...callControls, btnChat, btnDel],
        // Оставляем кликабельность всей строки для удобства
        onSelectDirect: (user)=> selectDirectFriend(user.id, user.username || user.id)
      });
      // Применить badge если уже есть непрочитанные
      updateFriendUnreadBadge(f.user_id);
    });
    // Если до перезагрузки был выбран directFriend и он всё ещё в списке — не сбрасываем UI
    if (prevDirect && friends.some(fr => fr.user_id === prevDirect)){
      // Ничего не делаем: содержимое сообщений не трогаем; заголовок можно обновить на случай смены username
      const fr = friends.find(fr => fr.user_id === prevDirect);
      if (fr && els.directChatTitle && currentDirectFriend === prevDirect){
        els.directChatTitle.textContent = 'Чат с: ' + (fr.username || prevDirect.slice(0,8));
      }
    }
    // Requests
    els.friendRequests.innerHTML = '';
    if (!reqs.length) els.friendRequests.innerHTML = '<div class="muted">Нет заявок</div>';
    reqs.forEach(r => {
      const btnAccept = makeBtn('Принять', 'btn success', async ()=>{ try{ await acceptFriend(r.user_id); await loadFriends(); }catch(e){ alert(String(e)); } });
            renderUserRow(els.friendRequests, { id: r.user_id, username: r.username || r.user_id, email: r.email || '' }, { actions: [btnAccept] });
    });
  }catch(e){
    els.friendsList.innerHTML = '<div class="muted">Ошибка</div>';
    els.friendRequests.innerHTML = '<div class="muted">Ошибка</div>';
  }
}

function initFriendsUI(){
  if (!els.friendsCard) return;
  // Запуск WS друзей один раз после авторизации
  try { startFriendsWs(); } catch {}
  els.btnFriendSearch?.addEventListener('click', async ()=>{
    const q = (els.friendSearch?.value || '').trim();
    if (!q) return;
    els.friendSearchResults.innerHTML = '<div class="muted">Поиск...</div>';
    try{
      const arr = await findUsers(q);
      els.friendSearchResults.innerHTML = '';
      if (!arr.length) els.friendSearchResults.innerHTML = '<div class="muted">Ничего не найдено</div>';
      arr.forEach(u => {
        const btnAdd = makeBtn('Добавить', 'btn', async ()=>{
          try{ await sendFriendRequest(u.id); alert('Заявка отправлена'); await loadFriends(); }
          catch(e){ alert(String(e)); }
        });
        renderUserRow(els.friendSearchResults, u, { actions: [btnAdd] });
      });
    }catch(e){ els.friendSearchResults.innerHTML = '<div class="muted">Ошибка поиска</div>'; }
  });
  // Инициализируем списки
  loadFriends();
}

function startFriendsWs(){
  if (friendsWs) return;
  const t = localStorage.getItem('wc_token');
  if (!t) return; // нет токена – не подключаемся
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = new URL(`${proto}://${location.host}/ws/friends`);
  url.searchParams.set('token', t);
  friendsWs = new WebSocket(url.toString());
  friendsWs.onopen = () => {
    appendLog(els.logs, 'WS друзей открыт');
    try { friendsWs.send(JSON.stringify({ type: 'ping' })); } catch {}
  };
  friendsWs.onmessage = async (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type){
        case 'friend_request':
        case 'friend_accepted':
        case 'friend_cancelled':
          // Перезагружаем списки (debounce простейший)
          scheduleFriendsReload();
          break;
        case 'friend_removed':
          // Если текущий активный чат связан с удалённым другом — сбросить
          if (currentDirectFriend){
            // Перезагрузим списки в любом случае
            scheduleFriendsReload();
            // Очистим локальные структуры для ВСЕХ (гарантировано синхронизуем позже)
            directSeenByFriend.delete(currentDirectFriend);
            directUnread.delete(currentDirectFriend);
            if (els.directMessages) els.directMessages.innerHTML = '<div class="muted">Выберите друга</div>';
            currentDirectFriend = null;
            if (els.directChatTitle) els.directChatTitle.textContent = 'Личный чат';
          } else {
            scheduleFriendsReload();
          }
          break;
        case 'direct_message':
          handleIncomingDirect(msg);
          break;
        case 'direct_cleared':
          handleDirectCleared(msg);
          break;
        case 'call_invite': {
          // пришло приглашение: если у нас нет активного, выставляем incoming
          if (!activeCall){
            setActiveIncomingCall(msg.fromUserId, msg.fromUsername, msg.roomId);
          } else {
            // Уже в звонке/ожидании: авто-отклоняем (не отправляя decline) или игнорируем
          }
          break; }
        case 'call_accept': {
          // наш собеседник принял: если это наш исходящий звонок — статус accepted и если мы ещё не подключены к этой комнате, уже подключены
          if (activeCall && activeCall.roomId === msg.roomId){
            markCallAccepted(msg.roomId);
          }
          break; }
        case 'call_decline': {
          if (activeCall && activeCall.roomId === msg.roomId){
            markCallDeclined(msg.roomId);
          }
          break; }
        default:
          break;
      }
    } catch {}
  };
  friendsWs.onclose = () => {
    friendsWs = null;
    // Автореконнект через 5с если токен всё ещё есть
    setTimeout(()=>{ try{ startFriendsWs(); }catch{} }, 5000);
  };
  friendsWs.onerror = () => { try { friendsWs.close(); } catch {}; };
}

async function selectDirectFriend(friendId, label, opts={}){
  // NOTE: Раньше при каждом клике мы заново загружали историю и затирали уже отображённые
  // сообщения, из-за чего чат визуально «пропадал» (особенно если в списке друзей происходила
  // перерисовка). Флаг already предотвращает повторную перезагрузку при выборе того же друга.
  const already = currentDirectFriend === friendId;
  currentDirectFriend = friendId;
  if (els.directChatCard) els.directChatCard.style.display = '';
  if (els.directChatTitle) els.directChatTitle.textContent = 'Чат с: ' + (label || friendId.slice(0,8));
  ensureDirectActions();
  // Если уже открыт этот чат — обычно не перезагружаем, НО если явно просят форсировать или чат пуст — перезагрузим
  if (already && !opts.force) {
    // Снимаем непрочитанные
    if (directUnread.has(friendId)) { directUnread.delete(friendId); updateFriendUnreadBadge(friendId); }
    // Если сообщений нет или стоит метка "Пусто" — пробуем обновить
    const hasAny = !!els.directMessages && els.directMessages.querySelector('.chat-line');
    const showsEmpty = !!els.directMessages && /Пусто|Загрузка|Ошибка/.test(els.directMessages.textContent||'');
    if (!hasAny || showsEmpty){
      return await selectDirectFriend(friendId, label, { force: true });
    }
    return;
  }
  // Сбрасываем непрочитанные при первом открытии после выбора
  if (directUnread.has(friendId)) { directUnread.delete(friendId); updateFriendUnreadBadge(friendId); }
  if (els.directMessages) els.directMessages.innerHTML = '<div class="muted">Загрузка...</div>';
  try{
    const t = localStorage.getItem('wc_token');
    const r = await fetch(`/api/v1/direct/${friendId}/messages`, { headers: { 'Authorization': `Bearer ${t}` } });
    const arr = await r.json();
    // ВАЖНО: Полная перезагрузка чата должна заново отрисовать ВСЕ сообщения,
    // поэтому пересоздаём набор seen, чтобы не фильтровать уже известные id.
    let seen = new Set();
    directSeenByFriend.set(friendId, seen);
    let added = 0;
    if (Array.isArray(arr) && arr.length){
      els.directMessages.innerHTML = '';
      arr.forEach(m => {
        // Отрисовываем все элементы, параллельно наполняя seen
        if (m.id) seen.add(m.id);
        added++;
        appendDirectMessage(m, m.from_user_id === getAccountId());
      });
      if (added === 0){ els.directMessages.innerHTML = '<div class="muted">Пусто</div>'; }
      else scrollDirectToEnd();
    } else {
      // Пусто — повторная попытка загрузки через короткую задержку
      els.directMessages.innerHTML = '<div class="muted">Пусто</div>';
      setTimeout(async ()=>{
        try{
          const t2 = localStorage.getItem('wc_token');
          const r2 = await fetch(`/api/v1/direct/${friendId}/messages`, { headers: { 'Authorization': `Bearer ${t2}` } });
          if (r2.ok){
            const arr2 = await r2.json();
            if (Array.isArray(arr2) && arr2.length){
              els.directMessages.innerHTML = '';
              let seen2 = directSeenByFriend.get(friendId);
              if (!seen2){ seen2 = new Set(); directSeenByFriend.set(friendId, seen2); }
              let added2 = 0;
              arr2.forEach(m => { if (m.id && !seen2.has(m.id)){ seen2.add(m.id); added2++; appendDirectMessage(m, m.from_user_id === getAccountId()); } });
              if (added2 === 0){ els.directMessages.innerHTML = '<div class="muted">Пусто</div>'; } else scrollDirectToEnd();
            }
          }
        }catch{}
      }, 600);
    }
  }catch{ try{ els.directMessages.innerHTML = '<div class="muted">Ошибка загрузки</div>'; }catch{} }
}

function getAccountId(){
  try{ const t = localStorage.getItem('wc_token'); if (!t) return null; const payload = JSON.parse(atob(t.split('.')[1])); return payload.sub; }catch{ return null; }
}

function appendDirectMessage(m, isSelf){
  if (!els.directMessages) return;
  const div = document.createElement('div');
  div.className = 'chat-line' + (isSelf ? ' self' : '');
  const dt = new Date(m.sent_at || m.sentAt || Date.now());
  const ts = dt.toLocaleTimeString();
  const full = dt.toLocaleString();
  div.innerHTML = `<span class="who">${isSelf ? 'Я' : (m.from_user_id||m.fromUserId||'--').slice(0,6)}</span> <span class="msg"></span> <span class="time" title="${full}">${ts}</span>`;
  div.querySelector('.msg').textContent = m.content;
  els.directMessages.appendChild(div);
}

function scrollDirectToEnd(){
  try{ els.directMessages.scrollTop = els.directMessages.scrollHeight; }catch{}
}

function handleIncomingDirect(msg){
  const acc = getAccountId();
  // Проверяем, что это переписка с текущим выбранным другом
  const other = msg.fromUserId === acc ? msg.toUserId : msg.fromUserId;
  const show = currentDirectFriend && other === currentDirectFriend;
  if (show){
    const mid = msg.messageId || msg.id;
    let seen = directSeenByFriend.get(currentDirectFriend);
    if (!seen){ seen = new Set(); directSeenByFriend.set(currentDirectFriend, seen); }
    if (mid && seen.has(mid)) return; // уже добавили
    if (mid) seen.add(mid);
    appendDirectMessage({
      id: mid,
      from_user_id: msg.fromUserId,
      content: msg.content,
      sent_at: msg.sentAt
    }, msg.fromUserId === acc);
    scrollDirectToEnd();
  } else {
    // Не активный чат: считаем непрочитанные
    if (acc && msg.fromUserId !== acc){
      const prev = directUnread.get(other) || 0;
      directUnread.set(other, prev + 1);
      updateFriendUnreadBadge(other);
    }
  }
}

function handleDirectCleared(msg){
  // Если выбранный чат совпадает с очищенной парой — сбрасываем UI
  if (!currentDirectFriend) return;
  const acc = getAccountId();
  if (!acc) return;
  const ids = msg.userIds || [];
  if (ids.includes(acc) && ids.includes(currentDirectFriend)){
    if (els.directMessages) els.directMessages.innerHTML = '<div class="muted">Пусто</div>';
    directSeenByFriend.set(currentDirectFriend, new Set());
    directUnread.delete(currentDirectFriend);
    updateFriendUnreadBadge(currentDirectFriend);
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
      if (!currentDirectFriend) return;
      if (!confirm('Удалить всю переписку?')) return;
      try{
        const t = localStorage.getItem('wc_token');
        const r = await fetch(`/api/v1/direct/${currentDirectFriend}/messages`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${t}` } });
        if (r.ok){
          const j = await r.json();
          // Локально очистим (WS событие тоже придёт)
          if (els.directMessages) els.directMessages.innerHTML = '<div class="muted">Пусто</div>';
          directSeenByFriend.set(currentDirectFriend, new Set());
          appendLog(els.logs, `Переписка удалена (${j.removed||0})`);
        }
      }catch{}
    });
    els.directActions.appendChild(btn);
  }
}

if (els.btnDirectSend){
  els.btnDirectSend.addEventListener('click', async ()=>{
    if (!currentDirectFriend) return;
    const text = (els.directInput?.value || '').trim();
    if (!text) return;
    try{
      const t = localStorage.getItem('wc_token');
      const r = await fetch(`/api/v1/direct/${currentDirectFriend}/messages`, {
        method: 'POST',
        headers: { 'content-type':'application/json', 'Authorization': `Bearer ${t}` },
        body: JSON.stringify({ content: text })
      });
      if (r.ok){
        const m = await r.json();
        let seen = directSeenByFriend.get(currentDirectFriend);
        if (!seen){ seen = new Set(); directSeenByFriend.set(currentDirectFriend, seen); }
        if (m.id && !seen.has(m.id)){
          seen.add(m.id);
          appendDirectMessage(m, true);
          scrollDirectToEnd();
        }
      }
    }catch{}
    els.directInput.value='';
  });
  els.directInput?.addEventListener('keydown', e=>{ if (e.key==='Enter') els.btnDirectSend.click(); });
}

let _friendsReloadTimer = null;
function scheduleFriendsReload(){
  if (_friendsReloadTimer) clearTimeout(_friendsReloadTimer);
  _friendsReloadTimer = setTimeout(()=>{ loadFriends(); }, 300); // простая стабилизация всплеска событий
}

// === Permissions (microphone & notifications) ===
async function checkAndRequestPermissionsInitial(){
  try { await requestMicIfNeeded({ silent: true }); } catch {}
  try { await ensurePushPermission({ silent: true }); } catch {}
  updatePermBanner();
}

async function requestMicIfNeeded(opts={}){
  // Если уже был доступ — ничего не делаем
  try {
    if (navigator.permissions && navigator.permissions.query){
      const st = await navigator.permissions.query({ name: 'microphone' });
      if (st.state === 'granted') return true;
    }
  } catch {}
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    return true;
  } catch (e){
    if (!opts.silent) alert('Нет доступа к микрофону. Разрешите в настройках браузера.');
    return false;
  }
}

async function ensurePushPermission(opts={}){
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false; // нельзя программно пере-запросить
  try {
    const perm = await Notification.requestPermission();
    return perm === 'granted';
  } catch { return false; }
}

function updatePermBanner(){
  if (!els.permBanner) return;
  const msgs = [];
  // Микрофон
  (async () => {
    try {
      if (navigator.permissions && navigator.permissions.query){
        const st = await navigator.permissions.query({ name: 'microphone' });
        if (st.state === 'denied') msgs.push('Доступ к микрофону запрещён. Разрешите в настройках браузера.');
        else if (st.state === 'prompt') msgs.push('Предоставьте доступ к микрофону для звонков.');
      }
    } catch {}
    // Push
    try {
      if ('Notification' in window){
        if (Notification.permission === 'denied') msgs.push('Уведомления заблокированы. Разрешите их в настройках браузера.');
        else if (Notification.permission === 'default') msgs.push('Разрешите отправку уведомлений, чтобы получать оповещения о звонках.');
      }
    } catch {}
    if (msgs.length){
      els.permBanner.innerHTML = msgs.map(m=>`<div class="warn">${m}</div>`).join('');
      els.permBanner.style.display = '';
    } else {
      els.permBanner.innerHTML = '';
      els.permBanner.style.display = 'none';
    }
  })();
}

window.__wc_requestMic = () => requestMicIfNeeded({ silent:false }).then(()=> updatePermBanner());
window.__wc_requestPush = () => ensurePushPermission({ silent:false }).then(()=> updatePermBanner());
