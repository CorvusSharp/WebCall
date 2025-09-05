// main.js — вход (исправлено: логируем адрес WS, кнопка диагностики, стабильные presence/инициация)
import { buildWs } from './api.js';
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
  membersList: document.getElementById('membersList'),
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
    try { ws.send(JSON.stringify({ type: 'join', fromUserId: userId })); } catch {}

    await rtc.init(ws, userId, { micId: selected.mic, camId: selected.cam });
  };

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === 'signal'){
      await rtc.handleSignal(msg, bindPeerMedia);
    }
    else if (msg.type === 'presence'){
      log(`В комнате: ${msg.users.join(', ')}`);
      // отображаем список участников
      if (els.membersList) {
        els.membersList.innerHTML = '';
        msg.users.forEach(u => {
          const d = document.createElement('div');
          d.textContent = u.slice(0,6);
          els.membersList.appendChild(d);
        });
      }
      const myId = getStableConnId();
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
      const who = msg.authorName || (senderId ? senderId.slice(0,6) : 'unknown');
      appendChat(els.chat, who, msg.content);
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
  const name = tile.querySelector('.name');
  const level = tile.querySelector('.level-bar');
  name.textContent = `user-${peerId.slice(0,6)}`;

  rtc.bindPeerMedia(peerId, {
    onTrack: (stream) => {
      log(`Получен медиа-поток от ${peerId.slice(0,6)}`);
      video.srcObject = stream;
    },
    onLevel: (value) => {
      level.style.transform = `scaleX(${value})`;
    },
    onSinkChange: (deviceId) => {
      if (video.setSinkId) video.setSinkId(deviceId).catch(e=>log(`sink(${peerId.slice(0,6)}): ${e.name}`));
    }
  });
}

function leave(){
  isManuallyDisconnected = true;
  // Сообщаем серверу о выходе
  try { ws.send(JSON.stringify({ type: 'leave', fromUserId: userId })); } catch {}
  if (ws) ws.close();
  if (rtc) { rtc.close(); rtc = null; }
  setConnectedState(false);
  els.peersGrid.innerHTML = '';
  if (els.membersList) els.membersList.innerHTML = '';
  log('Отключено');
}

// ===== UI
function setupUI(){
  bind(els.btnConnect, 'click', connect);
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
      appendChat(els.chat, 'Вы', text);
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
  });
  bind(els.btnDiag, 'click', ()=> rtc?.diagnoseAudio());
  bind(els.btnToggleTheme, 'click', ()=>{
    const isDark = document.body.classList.toggle('dark');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  });

  // Restore theme
  if (localStorage.getItem('theme') === 'dark') document.body.classList.add('dark');

  // Restore room from URL
  const u = new URL(location.href);
  if (u.searchParams.has('room')) {
    els.roomId.value = u.searchParams.get('room');
  }
}

// ===== Init
setConnectedState(false);
setupUI();
refreshDevices();
log('Приложение инициализировано');
// Попробуем сразу подключиться, если есть комната в URL
if (els.roomId.value) connect();
