// main.js — вход (исправлено: логируем адрес WS, кнопка диагностики, стабильные presence/инициация)
import { buildWs } from './api.js';

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

const els = {
  roomId: document.getElementById('roomId'),
  btnConnect: document.getElementById('btnConnect'),
  btnLeave: document.getElementById('btnLeave'),
  btnCopyLink: document.getElementById('btnCopyLink'),
  btnSend: document.getElementById('btnSend'),
  chatInput: document.getElementById('chatInput'),
  connStatus: document.getElementById('connStatus'),
  logs: document.getElementById('logs'),
  chat: document.getElementById('chat'),
  btnToggleMic: document.getElementById('btnToggleMic'),
  btnToggleCam: document.getElementById('btnToggleCam'),
  localVideo: document.getElementById('localVideo'),
  peersGrid: document.getElementById('peersGrid'),
  stats: document.getElementById('stats'),
  micSel: document.getElementById('micSel'),
  camSel: document.getElementById('camSel'),
  spkSel: document.getElementById('spkSel'),
  btnDiag: document.getElementById('btnDiag'),
  btnToggleTheme: document.getElementById('btnToggleTheme'),
  btnLogout: document.getElementById('btnLogout'),
  membersList: document.getElementById('membersList'), // legacy (removed section)
  visitedRooms: document.getElementById('visitedRooms'),
};

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
  setEnabled(els.btnToggleCam, false);
}

function setConnectedState(connected){
  setText(els.connStatus, connected ? 'Подключено' : 'Не подключено');
  setEnabled(els.btnConnect, !connected);
  setEnabled(els.btnSend, connected);
  setEnabled(els.btnLeave, connected);
  setEnabled(els.btnToggleMic, connected);
  setEnabled(els.btnToggleCam, connected);
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
  // Сообщаем серверу о выходе
  try { ws.send(JSON.stringify({ type: 'leave', fromUserId: userId })); } catch {}
  if (ws) ws.close();
  if (rtc) { rtc.close(); rtc = null; }
  setConnectedState(false);
  els.peersGrid.innerHTML = '';
  // (participants volumes removed)
  log('Отключено');
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
  bind(els.btnToggleCam, 'click', ()=>{
    if (!rtc) return;
    const enabled = rtc.toggleCam();
    els.btnToggleCam.textContent = enabled ? 'Выкл.камеру' : 'Вкл.камеру';
    try{
      const hasVideo = !!(rtc.localStream && rtc.localStream.getVideoTracks()[0] && rtc.localStream.getVideoTracks()[0].enabled);
      const card = document.getElementById('localCard');
      if (card) card.style.display = hasVideo ? '' : 'none';
    }catch{}
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
    if (!Array.isArray(items) || items.length === 0){ els.visitedRooms.innerHTML = '<div class="muted">История пуста</div>'; return; }
    els.visitedRooms.innerHTML = '';
    for (const it of items){
      const div = document.createElement('div');
      div.className = 'list-item';
      const title = it.name || it.room_id;
      const when = new Date(it.last_seen).toLocaleString();
      div.innerHTML = `
        <div class="grow">
          <div class="bold">${title}</div>
          <div class="muted small">${it.room_id} • ${when}</div>
        </div>
        <button class="btn" data-room="${it.room_id}">Войти</button>
      `;
      const btn = div.querySelector('button');
      btn.addEventListener('click', ()=>{
        els.roomId.value = it.room_id;
        unlockAudioPlayback();
        connect();
      });
      els.visitedRooms.appendChild(div);
    }
  }catch(e){
    try{ els.visitedRooms.innerHTML = '<div class="muted">Ошибка загрузки</div>'; }catch{}
  }
}
