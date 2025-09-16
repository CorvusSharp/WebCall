// main.js — вход (исправлено: логируем адрес WS, кнопка диагностики, стабильные presence/инициация)
import { buildWs, subscribePush, findUsers, listFriends, listFriendRequests, sendFriendRequest, acceptFriend, notifyCall, acceptCall, declineCall, getMe } from './api.js';

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
let audioGestureAllowed = false; // set true after first user gesture
let latestUserNames = {}; // { connId: displayName }
let friendsWs = null;
let currentDirectFriend = null; // UUID друга выбранного в личном чате
// Throttle map to avoid multiple concurrent startOffer for same peer
const recentOffer = new Map(); // peerId -> timestamp
let peerCleanupIntervalId = null;
// Пер-друг кэш id сообщений чтобы не дублировать (Map<friendId, Set<msgId>>)
const directSeenByFriend = new Map();
// Количество непрочитанных per друг
const directUnread = new Map();

// ===== Спец-рингтон для пары пользователей =====
// Файл находится рядом со скриптами в static/js/
let specialRingtone = null;
let specialRingtoneTimer = null; // больше не используется для повторов, но оставим для совместимости
let specialRingtoneActive = false; // ожидаем играть (входящий инвайт у спец-email)
let specialRingtonePlaying = false; // реально играет сейчас
let specialRingtoneReady = null; // Promise единовременного создания

// Autoplay / user gesture helpers
let userGestureHappened = false;
let pendingAutoplayTasks = [];
// Session id to invalidate late callbacks from previous ringtone attempts
let ringtoneSession = 0;
// Basic mobile detection to apply hard-stop semantics on iOS/Android
const isMobileBrowser = typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');

function getStoredEmail(){ try{ return localStorage.getItem('wc_email') || ''; }catch{ return ''; } }
function getStoredUsername(){ try{ return localStorage.getItem('wc_username') || ''; }catch{ return ''; } }

const SPECIAL_RING_EMAILS = new Set([
  'roman74mamin@gmail.com',
  'gerasimenkoooo38@gmail.com',
  'myphone@gmail.com',
]);

async function ensureSpecialRingtone(){
  // Singleton creation with concurrency protection
  if (specialRingtone) return Promise.resolve(specialRingtone);
  if (specialRingtoneReady) return specialRingtoneReady;

  specialRingtoneReady = (async () => {
    const candidates = [
      '/static/js/Sil-a%20%26%20YUNG%20TRAPPA%20-%20%D0%94%D0%B0%D0%B2%D0%B0%D0%B9%20%D0%BA%D0%B8%D0%BD%D0%B5%D0%BC%20%D0%B1%D0%B0%D1%80%D1%8B%D0%B3%D1%83.mp3',
      '/static/js/Sil-a%20%26%20YUNG%20TRAPPA%20-%20%D0%94%D0%B0%D0%B2%D0%B0%D0%B9%20%D0%BA%D0%B8%D0%BD%D0%B5%D0%BC%20%D0%B1%D0%B0%D1%80%D1%8B%D0%B3%D1%83',
    ];
    for (const src of candidates){
      try{
        const audio = new Audio(src);
        audio.preload = 'auto';
        audio.loop = true;
        audio.volume = 1.0;
        const ok = await new Promise((resolve)=>{
          let done = false;
          const cleanup = ()=>{ if (done) return; done = true;
            audio.removeEventListener('loadedmetadata', onMeta);
            audio.removeEventListener('canplay', onCan);
            audio.removeEventListener('error', onErr);
          };
          const onMeta = ()=>{ cleanup(); resolve(true); };
          const onCan  = ()=>{ cleanup(); resolve(true); };
          const onErr  = ()=>{ cleanup(); resolve(false); };
          audio.addEventListener('loadedmetadata', onMeta, {once:true});
          audio.addEventListener('canplay',        onCan,  {once:true});
          audio.addEventListener('error',          onErr,  {once:true});
          try{ audio.load?.(); }catch{}
          setTimeout(()=>{ if (audio.readyState >= 1){ cleanup(); resolve(true); } }, 50);
        });
        if (ok){
          specialRingtone = audio;
          return specialRingtone;
        }
      }catch{}
    }
    return null;
  })();

  const a = await specialRingtoneReady;
  specialRingtoneReady = null;
  return a;
}

function startSpecialRingtone(){
  const wasActive = specialRingtoneActive;
  specialRingtoneActive = true;
  // Auto-kill timer to avoid infinite ringing (60 seconds)
  try{ if (specialRingtoneTimer) { clearTimeout(specialRingtoneTimer); specialRingtoneTimer = null; } }catch{}
  try{ specialRingtoneTimer = setTimeout(()=> { try{ stopSpecialRingtone(); }catch{} }, 60000); }catch{}
  // Если пользовательский жест ещё не случился — отложим запуск до первого жеста
  if (!userGestureHappened){
    // Один токен, чтобы не плодить дубликаты. Отложенная задача проверяет,
    // что звонок все ещё в статусе входящего приглашения прежде чем стартовать
    if (!pendingAutoplayTasks.some(fn => fn && fn.__ring)){
      const runner = () => {
        try{
          if (activeCall && activeCall.direction === 'incoming' && activeCall.status === 'invited') {
            startSpecialRingtone();
          }
        }catch{}
      };
      runner.__ring = true;
      pendingAutoplayTasks.push(runner);
    }
    return;
  }

  // Требуем разблокировки аудио политиками браузера
  unlockAudioPlayback();
  // increment session to invalidate previous pending callbacks
  ringtoneSession += 1;
  const mySession = ringtoneSession;

  ensureSpecialRingtone().then(audio => {
    if (mySession !== ringtoneSession) return; // stale
    if (!audio) return;
    const START_AT = 1;
    const startPlayback = () => {
      if (!specialRingtoneActive || specialRingtonePlaying) return;
      specialRingtonePlaying = true;
      audio.play().catch(()=>{
        // одна мягкая повторная попытка спустя 300мс, без циклов
        setTimeout(()=>{ if (specialRingtoneActive && !specialRingtonePlaying) audio.play().catch(()=>{}); }, 300);
      });
    };
    // Если уже был активен рингтон (политика могла заблокировать старт), просто попробуем снова запустить
    if (wasActive) {
      if (!specialRingtonePlaying) startPlayback();
      return;
    }
    const seekAndStart = () => {
      // Установим позицию и дождёмся подтверждения seeked
      const onSeeked = () => { try{ audio.removeEventListener('seeked', onSeeked); }catch{}; if (mySession === ringtoneSession) startPlayback(); };
      audio.addEventListener('seeked', onSeeked, { once: true });
      try { audio.currentTime = START_AT; } catch { /* если не удалось сейчас, попробуем после метаданных */ }
      // Если уже "похоже" на START_AT — запускаем без ожидания
      try { if (Math.abs((audio.currentTime||0) - START_AT) < 0.5) { try{ audio.removeEventListener('seeked', onSeeked); }catch{}; if (mySession === ringtoneSession) startPlayback(); } } catch {}
    };
    // Если метаданные уже есть — сразу seek+start, иначе подождём loadedmetadata
    if (audio.readyState >= 1) {
      seekAndStart();
    } else {
      audio.addEventListener('loadedmetadata', seekAndStart, { once: true });
      // На случай, если loadedmetadata не приходит из-за кеша — вызовем принудительно load
      try { audio.load?.(); } catch {}
    }
  });
}

function stopSpecialRingtone(){
  specialRingtoneActive = false;
  specialRingtonePlaying = false;
  // Invalidate any pending callbacks for previous sessions
  ringtoneSession += 1;
  if (specialRingtone){
    try{ specialRingtone.pause(); }catch{}
    try{ specialRingtone.loop = false; }catch{}
    try{ specialRingtone.currentTime = 0; }catch{}
    // On mobile (iOS) do a hard reset to ensure audio actually stops.
    if (isMobileBrowser){
      try{ specialRingtone.removeAttribute && specialRingtone.removeAttribute('src'); }catch{}
      try{ specialRingtone.src = ''; }catch{}
      try{ specialRingtone.load?.(); }catch{}
      try{ specialRingtone = null; }catch{}
      try{ specialRingtoneReady = null; }catch{}
    }
  }
  if (specialRingtoneTimer) { try{ clearTimeout(specialRingtoneTimer); }catch{} specialRingtoneTimer = null; }
}

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
  // Остановим спец-рингтон при любом сбросе состояния
  stopSpecialRingtone();
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
  // Прекращаем рингтон при ответе и удаляем любые pending приглашения для этого пользователя
  stopSpecialRingtone();
  // Очистим очередь автоплей-задач — пользователь уже сделал жест/действие
  try{ pendingAutoplayTasks = []; }catch{}
  try {
    // Если был pending invite от этого пользователя — удалим
    if (activeCall && activeCall.withUserId) pendingIncomingInvites.delete(activeCall.withUserId);
  } catch {}
  loadFriends();
}

function markCallDeclined(roomId){
  if (activeCall && activeCall.roomId === roomId){
    activeCall.status = 'declined';
    setTimeout(()=> resetActiveCall('declined'), 1500);
  }
  // Прекращаем рингтон при отклонении и удаляем pending запись
  stopSpecialRingtone();
  try{ pendingAutoplayTasks = []; }catch{}
  try {
    if (activeCall && activeCall.withUserId) pendingIncomingInvites.delete(activeCall.withUserId);
  } catch {}
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
  // После инициализации RTC — если мы в звонке, рингтон больше не нужен
  try{ stopSpecialRingtone(); }catch{}
    // Запустим периодическую очистку застрявших peer-ов
    try{
      if (peerCleanupIntervalId) { clearInterval(peerCleanupIntervalId); peerCleanupIntervalId = null; }
      peerCleanupIntervalId = setInterval(()=>{
        try{
          if (!rtc || !rtc.peers) return;
          const now = Date.now();
          for (const [pid, st] of Array.from(rtc.peers.entries())){
            const created = st.createdAt || st._createdAt || 0;
            if (!created){ try{ st.createdAt = now; }catch{}; continue; }
            if (now - created > 30000){
              try{ st.pc && st.pc.close(); }catch{};
              try{ if (st.level?.raf) cancelAnimationFrame(st.level.raf); }catch{};
              rtc.peers.delete(pid);
              const tile = document.querySelector(`.tile[data-peer="${pid}"]`);
              if (tile) { try{ safeReleaseMedia(tile); }catch{} try{ tile.remove(); }catch{} }
              log(`Удалён зависший пир ${pid}`);
            }
          }
        }catch{}
      }, 5000);
    }catch{}
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
          try{ safeReleaseMedia(tile); }catch{}
          try{ tile.remove(); }catch{}
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
        if (peerId === myId) continue;
        try{
          const last = recentOffer.get(peerId) || 0;
          const now = Date.now();
          if (now - last < 3000){
            log(`Пропущен повторный старт для ${peerId}`);
            continue;
          }
          recentOffer.set(peerId, now);
        }catch{}
        try{
          log(`Обнаружен пир ${peerId}, инициирую звонок...`);
          await rtc.startOffer(peerId);
        }catch(e){ log(`startOffer(${peerId}) failed: ${e}`); }
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
    // При закрытии WS гарантированно гасим спец-рингтон
    try{ stopSpecialRingtone(); }catch{}
    if (pingTimer) clearInterval(pingTimer);
    if (rtc) { rtc.close(); rtc = null; }
    ws = null;
    try{ if (peerCleanupIntervalId) { clearInterval(peerCleanupIntervalId); peerCleanupIntervalId = null; } }catch{}

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
      try{ stopSpecialRingtone(); }catch{}
      if (video) video.srcObject = stream;
      if (audio) {
        // Привязываем поток и сохраняем ссылку для безопасной очистки
        audio.srcObject = stream;
        try{ audio._peerStream = stream; }catch{}
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

// Безопасно освобождаем медиаресурсы, связанные с элементом audio/video/tile
function safeReleaseMedia(el){
  try{
    if (!el) return;
    // Если это контейнер tile — ищем внутри
    if (el.classList && el.classList.contains && el.classList.contains('tile')){
      const aud = el.querySelector('audio');
      const vid = el.querySelector('video');
      try{ safeReleaseMedia(aud); }catch{};
      try{ safeReleaseMedia(vid); }catch{};
      return;
    }
    // audio/video element
    if (el instanceof HTMLMediaElement){
      // Остановим все треки, если есть сохранённый stream
      try{
        const s = el._peerStream || el.srcObject;
        if (s && s.getTracks){
          s.getTracks().forEach(t=>{ try{ t.stop(); }catch{} });
        }
      }catch{}
      try{ el.pause(); }catch{}
      try{ el.srcObject = null; }catch{}
      try{ el.removeAttribute('src'); }catch{}
      // Попытка вызвать load() для сброса внутреннего состояния
      try{ el.load?.(); }catch{}
    }
  }catch{}
}


// Try to unlock browser audio autoplay policies
function unlockAudioPlayback(){
  try{
    if (!userGestureHappened) return false; // do nothing until user gesture
    // Create/resume a global AudioContext to satisfy iOS/Safari/Chrome policies
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx){
      if (!globalAudioCtx) globalAudioCtx = new Ctx();
      if (globalAudioCtx.state === 'suspended') globalAudioCtx.resume().catch(()=>{});
      // Play a tiny silent buffer
      try {
        const buffer = globalAudioCtx.createBuffer(1, 1, 22050);
        const source = globalAudioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(globalAudioCtx.destination);
        source.start(0);
      } catch {}
      try { audioUnlocked = (globalAudioCtx.state === 'running'); } catch { audioUnlocked = false; }
    }
    // Attempt to play any existing <audio> elements
    document.querySelectorAll('audio').forEach(a=>{
      try{ a.playsInline = true; a.muted = false; a.volume = 1.0; a.play().catch(()=>{}); }catch{}
    });
    // Если в момент разблокировки у нас есть входящий звонок в статусе invited для спец-email — запустим или перезапустим рингтон
    try {
      const myEmail = (getStoredEmail() || '').toLowerCase();
      // Avoid recursive restart: only start ringtone here if it is not already marked active
      if (activeCall && activeCall.direction === 'incoming' && activeCall.status === 'invited' && myEmail && SPECIAL_RING_EMAILS.has(myEmail) && !specialRingtoneActive){
        startSpecialRingtone();
      }
    } catch {}
  }catch{}
}

function leave(){
  isManuallyDisconnected = true;
  try { ws.send(JSON.stringify({ type: 'leave', fromUserId: userId })); } catch {}
  if (ws) ws.close();
  if (rtc) { rtc.close(); rtc = null; }
  setConnectedState(false);
  // Безопасно освободим медиа у всех тайлов перед очисткой
  try{
    els.peersGrid.querySelectorAll('.tile').forEach(t => { try{ safeReleaseMedia(t); }catch{} });
  }catch{}
  els.peersGrid.innerHTML = '';
  log('Отключено');
  try{ if (peerCleanupIntervalId) { clearInterval(peerCleanupIntervalId); peerCleanupIntervalId = null; } }catch{}
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
  const runPendingAutoplay = ()=>{
    const tasks = pendingAutoplayTasks.slice();
    pendingAutoplayTasks = [];
    for (const t of tasks){ try{ t(); }catch{} }
  };
  const gestureUnlock = ()=>{
    userGestureHappened = true;
    try{ unlockAudioPlayback(); }catch{};
    try{ runPendingAutoplay(); }catch{};
    document.removeEventListener('click', gestureUnlock, { capture: true });
    document.removeEventListener('touchstart', gestureUnlock, { capture: true });
    document.removeEventListener('keydown', gestureUnlock, { capture: true });
  };
  document.addEventListener('click', gestureUnlock, { once: true, capture: true });
  document.addEventListener('touchstart', gestureUnlock, { once: true, capture: true });
  document.addEventListener('keydown', gestureUnlock, { once: true, capture: true });

  // If the page becomes hidden or is being unloaded, clear pending autoplay and stop ringtone
  const onHidden = ()=>{
    try{ pendingAutoplayTasks = []; }catch{}
    try{ stopSpecialRingtone(); }catch{}
  };
  document.addEventListener('visibilitychange', ()=>{ if (document.hidden) onHidden(); });
  window.addEventListener('pagehide', onHidden, { capture:true });

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

  // Гарантируем, что профиль загружен (wc_email/wc_username) ДО запуска канала друзей,
  // чтобы обработчик call_invite уже имел e-mail и корректно запускал рингтон
  (async () => {
    try {
      await ensureProfile();
    } catch {}
    try { startFriendsWs(); } catch {}
    try { await loadFriends(); } catch {}
  })();

  // SW → main: обработка кликов по уведомлению (открыть личный чат)
  try {
    if ('serviceWorker' in navigator){
      navigator.serviceWorker.addEventListener('message', (e)=>{
        const data = e.data || {};
        if (data.type === 'openDirect' && data.userId){
          // Если друзья уже подгружены — просто открыть; иначе дождаться и открыть
          const open = ()=> selectDirectFriend(data.userId, data.userId, { force: true }).catch(()=>{});
          if (els.friendsList && els.friendsList.children.length){ open(); }
          else { setTimeout(open, 300); }
        }
      });
    }
  } catch {}
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
// ==== E2EE helpers (Web Crypto) ====
// NOTE: This is a minimal client-side E2EE using ECDH (P-256) to derive a symmetric key and AES-GCM for messages.
// It's not as feature-rich as Signal (no forward secrecy across sessions, no multi-device key management).
let _e2ee_keypair = null; // CryptoKeyPair
let _e2ee_exported_pub = null; // base64 string
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function ensureE2EEKeys(){
  if (_e2ee_keypair) return _e2ee_keypair;
  try{
    _e2ee_keypair = await window.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    const raw = await window.crypto.subtle.exportKey('raw', _e2ee_keypair.publicKey);
    _e2ee_exported_pub = btoa(String.fromCharCode(...new Uint8Array(raw)));
    // send public key to server — use dynamic import fallback if named import not available
    try{
      if (typeof setMyPublicKey === 'function') {
        await setMyPublicKey(_e2ee_exported_pub);
      } else {
        try{
        const api = await import('./api.js');
          if (api && typeof api.setMyPublicKey === 'function') await api.setMyPublicKey(_e2ee_exported_pub);
        }catch(e){}
      }
    }catch{}
    return _e2ee_keypair;
  }catch(e){ console.error('E2EE key gen failed', e); return null; }
}

async function importPeerPublicKey(base64){
  try{
    const raw = Uint8Array.from(atob(base64), c=>c.charCodeAt(0)).buffer;
    return await window.crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  }catch(e){ return null; }
}

async function deriveSharedKey(peerPubKey, myKeyPair){
  try{
    const key = await window.crypto.subtle.deriveKey({ name: 'ECDH', public: peerPubKey }, myKeyPair.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt','decrypt']);
    return key;
  }catch(e){ return null; }
}

async function aesGcmEncrypt(key, plaintext){
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const ct = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, textEncoder.encode(plaintext));
  // return base64(iv|ciphertext)
  const buf = new Uint8Array(iv.byteLength + ct.byteLength);
  buf.set(iv, 0);
  buf.set(new Uint8Array(ct), iv.byteLength);
  return btoa(String.fromCharCode(...buf));
}

async function aesGcmDecrypt(key, b64){
  try{
    const raw = Uint8Array.from(atob(b64), c=>c.charCodeAt(0));
    const iv = raw.slice(0,12);
    const ct = raw.slice(12).buffer;
    const plain = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return textDecoder.decode(plain);
  }catch(e){ return null; }
}

// High-level encrypt for peer by friendId (fetch peer public key from server, derive shared key and encrypt)
async function encryptForFriend(friendId, plaintext){
  await ensureE2EEKeys();
  try{
    // Support environments where named import wasn't available at runtime (cache/build issues)
    const pkResp = await (async (id) => {
      if (typeof getUserPublicKey === 'function') return getUserPublicKey(id);
      try{
      const api = await import('./api.js');
        if (api && typeof api.getUserPublicKey === 'function') return api.getUserPublicKey(id);
      }catch(e){}
      throw new Error('getUserPublicKey unavailable');
    })(friendId);
    const pub = pkResp && pkResp.public_key;
    if (!pub) throw new Error('no peer key');
    const peerKey = await importPeerPublicKey(pub);
    if (!peerKey) throw new Error('bad peer key');
    const shared = await deriveSharedKey(peerKey, _e2ee_keypair);
    if (!shared) throw new Error('derive failed');
    const ct = await aesGcmEncrypt(shared, plaintext);
    return ct;
  }catch(e){ console.error('encryptForFriend failed', e); return null; }
}

async function decryptFromFriend(friendId, b64cipher){
  try{
    await ensureE2EEKeys();
    const pkResp = await (async (id) => {
      if (typeof getUserPublicKey === 'function') return getUserPublicKey(id);
      try{
      const api = await import('./api.js');
        if (api && typeof api.getUserPublicKey === 'function') return api.getUserPublicKey(id);
      }catch(e){}
      return null;
    })(friendId);
    const pub = pkResp && pkResp.public_key;
    if (!pub) return null;
    const peerKey = await importPeerPublicKey(pub);
    if (!peerKey) return null;
    const shared = await deriveSharedKey(peerKey, _e2ee_keypair);
    if (!shared) return null;
    const plain = await aesGcmDecrypt(shared, b64cipher);
    return plain;
  }catch(e){ console.error('decryptFromFriend failed', e); return null; }
}

// Ensure keys on initial load (best-effort, non-blocking)
ensureE2EEKeys().catch(()=>{});
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
      // Обновим локальные счётчики непрочитанных по данным сервера
      if (typeof f.unread === 'number') {
        if (f.unread > 0) directUnread.set(f.user_id, f.unread); else directUnread.delete(f.user_id);
      }
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
          // СНАЧАЛА локально отмечаем исходящий, чтобы входящее событие не сработало у инициатора
          setActiveOutgoingCall(f, room);
          // Рингтон только у принимающей стороны (callee), у инициатора не запускаем
          // И только потом — уведомляем сервер (без await, чтобы не ловить гонку)
          try{ notifyCall(f.user_id, room).catch(()=>{}); }catch{}
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
                // Сначала пометим как принятый (чтобы рингтон был отключён и состояние было консистентным), затем выполним accept на сервере
                markCallAccepted(info.roomId);
                // Удаляем pending запись
                pendingIncomingInvites.delete(f.user_id);
                await acceptCall(f.user_id, info.roomId);
                // join room
                els.roomId.value = info.roomId;
                try{ unlockAudioPlayback(); connect(); }catch{}
              }catch(e){ console.error(e); }
            });
            const btnDecline = makeBtn('Отклонить', 'btn danger ghost', async (ev)=>{
              ev?.stopPropagation?.();
              const info = pendingIncomingInvites.get(f.user_id);
              if (!info) return;
              try{ await declineCall(f.user_id, info.roomId); }catch{}
              // Удаляем pending запись и помечаем звонок как отклонённый — это остановит рингтон
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
  // WS друзей запускается после ensureProfile() в setupUI
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
  // Списки загружаем после ensureProfile() в setupUI
}

async function ensureProfile(){
  try {
    const t = localStorage.getItem('wc_token');
    const hasEmail = !!localStorage.getItem('wc_email');
    const hasName = !!localStorage.getItem('wc_username');
    if (t && (!hasEmail || !hasName)){
      const me = await getMe();
      if (me?.email) localStorage.setItem('wc_email', me.email);
      if (me?.username) localStorage.setItem('wc_username', me.username);
    }
  } catch {}
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
          try {
            // Локальное уведомление: если это не наш открытый чат и есть разрешение на уведомления
            const acc = getAccountId();
            const other = msg.fromUserId === acc ? msg.toUserId : msg.fromUserId;
            const isActiveChat = currentDirectFriend && other === currentDirectFriend;
            // ВАЖНО: уведомляем только ПОЛУЧАТЕЛЯ, не отправителя
            const iAmRecipient = msg.toUserId === acc;
            if (iAmRecipient && !isActiveChat && 'Notification' in window && Notification.permission === 'granted'){
              const title = 'Новое сообщение';
              const body = msg.fromUsername ? `От ${msg.fromUsername}` : 'Личное сообщение';
              // Используем Service Worker, если зарегистрирован, чтобы поведение было единым
              const reg = await navigator.serviceWorker.getRegistration('/static/sw.js');
              if (reg && reg.showNotification){
                reg.showNotification(title, {
                  body,
                  data: { type: 'direct', from: other },
                });
              } else {
                // Фоллбек на Notification API
                new Notification(title, { body, data: { type: 'direct', from: other } });
              }
            }
          } catch {}
          break;
        case 'direct_cleared':
          handleDirectCleared(msg);
          break;
        case 'call_invite': {
          // Входящее приглашение обрабатываем ТОЛЬКО если адресовано нам
          const acc = getAccountId();
          const isForMe = acc && msg.toUserId === acc;
          if (isForMe && !activeCall){
            setActiveIncomingCall(msg.fromUserId, msg.fromUsername, msg.roomId);
            // Рингтон только для нужных e-mail
            const myEmail = (getStoredEmail() || '').toLowerCase();
            if (SPECIAL_RING_EMAILS.has(myEmail)) {
              startSpecialRingtone();
            }
          } else if (!activeCall && acc && msg.fromUserId === acc) {
            // Это повторная доставка инвайта для инициатора (после перезагрузки): восстановим исходящее состояние
            setActiveOutgoingCall({ user_id: msg.toUserId, username: msg.toUsername || msg.toUserId }, msg.roomId);
          }
          // Уже в звонке/ожидании: игнорируем
          break; }
        case 'call_accept': {
          // Всегда гасим рингтон на случай гонки/рассинхронизации
          try{ stopSpecialRingtone(); }catch{}
          // наш собеседник принял: если это наш исходящий звонок — помечаем accepted
          if (activeCall && activeCall.roomId === msg.roomId){
            markCallAccepted(msg.roomId);
          }
          break; }
        case 'call_decline': {
          // Всегда гасим рингтон на случай гонки/рассинхронизации
          try{ stopSpecialRingtone(); }catch{}
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
  // Сбрасываем непрочитанные при первом открытии после выбора (локально + серверу read-ack)
  if (directUnread.has(friendId)) { directUnread.delete(friendId); updateFriendUnreadBadge(friendId); }
  try{
    const t = localStorage.getItem('wc_token');
    // не важно, дойдёт ли — best-effort
    fetch(`/api/v1/direct/${friendId}/read-ack`, { method: 'POST', headers: { 'content-type':'application/json', 'Authorization': `Bearer ${t}` }, body: JSON.stringify({}) }).catch(()=>{});
  }catch{}
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
    (async ()=>{
      let plaintext = msg.content;
      try{
        const otherId = msg.fromUserId === acc ? msg.toUserId : msg.fromUserId;
        const dec = await decryptFromFriend(otherId, msg.content);
        if (dec) plaintext = dec;
      }catch(e){ /* ignore */ }
      appendDirectMessage({ id: mid, from_user_id: msg.fromUserId, content: plaintext, sent_at: msg.sentAt }, msg.fromUserId === acc);
      scrollDirectToEnd();
    })();
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
      // Encrypt before sending (client-side E2EE)
      const ct = await encryptForFriend(currentDirectFriend, text);
      if (!ct) throw new Error('encryption failed');
      const t = localStorage.getItem('wc_token');
      const r = await fetch(`/api/v1/direct/${currentDirectFriend}/messages`, {
        method: 'POST',
        headers: { 'content-type':'application/json', 'Authorization': `Bearer ${t}` },
        body: JSON.stringify({ content: ct })
      });
      if (r.ok){
        const m = await r.json();
        let seen = directSeenByFriend.get(currentDirectFriend);
        if (!seen){ seen = new Set(); directSeenByFriend.set(currentDirectFriend, seen); }
        if (m.id && !seen.has(m.id)){
          seen.add(m.id);
          // We encrypted it locally — try to decrypt to display plaintext
          const dec = await decryptFromFriend(currentDirectFriend, ct);
          appendDirectMessage({ id: m.id, from_user_id: getAccountId(), content: dec || '(encrypted)', sent_at: m.sent_at || new Date().toISOString() }, true);
          scrollDirectToEnd();
        }
      }
    }catch(e){ console.error('send direct failed', e); }
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
