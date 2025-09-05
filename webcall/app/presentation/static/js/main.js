// main.js - entry
import { buildWs, login as loginApi } from './api.js';
import { sendChat } from './signal.js';
import { WebRTCManager } from './webrtc.js';
import { bind, setText, setEnabled, appendLog, appendChat } from './ui.js';

let token = null;
let ws = null;
let rtc = null;
let outputDeviceId = null;
let userId = null;

const els = {
  email: document.getElementById('email'),
  password: document.getElementById('password'),
  btnLogin: document.getElementById('btnLogin'),
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
  remoteVideo: document.getElementById('remoteVideo'),
  btnToggleTheme: document.getElementById('btnToggleTheme'),
};

function log(msg){ appendLog(els.logs, msg); }

function setConnectedState(connected){
  setText(els.connStatus, connected ? 'Подключено' : 'Не подключено');
  setEnabled(els.btnSend, connected);
  setEnabled(els.btnLeave, connected);
  setEnabled(els.btnToggleMic, connected);
  setEnabled(els.btnToggleCam, connected);
}

async function login(){
  const email = els.email.value.trim();
  const password = els.password.value;
  try{
    const data = await loginApi(email, password);
    token = data.access_token;
  try{ userId = JSON.parse(atob(token.split('.')[1])).sub; }catch{}
    log('Вход выполнен');
  }catch(e){
    log(String(e));
  }
}

async function connect(){
  const roomId = els.roomId.value.trim();
  if (!roomId){ log('Введите Room ID'); return; }
  // Диагностика устройств перед подключением и выбор аудио-выхода
  if (navigator.mediaDevices?.enumerateDevices) {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const summary = devs.map(d => `${d.kind}:${d.label||'(no label)'}:${(d.deviceId||'').slice(0,6)}`).join(' | ');
      log(`Devices: ${summary}`);
      const outs = devs.filter(d => d.kind === 'audiooutput');
      const concrete = outs.find(d => d.deviceId && !['default','communications'].includes(d.deviceId));
      outputDeviceId = (concrete || outs[0] || {}).deviceId || null;
      if (outputDeviceId) {
        const chosen = concrete || outs.find(d => d.deviceId === outputDeviceId) || {};
        log(`Using audiooutput: ${chosen.label || outputDeviceId}`);
      }
    } catch(e){ log(`enumerateDevices error: ${e?.name||e}`); }
  }
  ws = buildWs(roomId, token);
  ws.onopen = async () => {
    log('WS connected');
    setConnectedState(true);
    rtc = new WebRTCManager({
      localVideo: els.localVideo,
      remoteVideo: els.remoteVideo,
      outputDeviceId,
      onLog: log,
      onConnected: ()=>log('P2P connected'),
      onDisconnected: ()=>log('P2P disconnected'),
    });
    if (!userId){
      // dev/test: временный случайный id (для работы без логина)
      userId = crypto.randomUUID();
    }
    try {
      await rtc.start(ws, userId);
    } catch (e) {
      log(`Ошибка старта WebRTC: ${e?.name || e}`);
    }
  };
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'signal') {
      await rtc?.handleSignal(msg);
    } else if (msg.type === 'chat') {
  const who = msg.authorName || msg.authorId || 'system';
  appendChat(els.chat, who, msg.content || msg.echo || '');
    }
  };
  ws.onclose = () => { log('WS closed'); setConnectedState(false); };
}

function leave(){
  rtc?.close();
  setConnectedState(false);
}

function copyLink(){
  const url = new URL(location.href);
  url.searchParams.set('room', els.roomId.value.trim());
  navigator.clipboard.writeText(url.toString());
  log('Ссылка скопирована');
}

function send(){
  const text = els.chatInput.value.trim();
  if (!text) return;
  sendChat(ws, text, userId);
  // Не добавляем сразу в чат: сервер пришлёт широковещательное сообщение с authorId
  els.chatInput.value='';
}

function toggleMic(){
  const on = rtc?.toggleMic();
  log(`Микрофон: ${on ? 'вкл' : 'выкл'}`);
}

function toggleCam(){
  const on = rtc?.toggleCam();
  log(`Камера: ${on ? 'вкл' : 'выкл'}`);
}

function restoreFromUrl(){
  const url = new URL(location.href);
  const rid = url.searchParams.get('room');
  if (rid) els.roomId.value = rid;
}

function toggleTheme(){
  document.documentElement.classList.toggle('light');
}

// Events
bind(els.btnLogin, 'click', login);
bind(els.btnConnect, 'click', connect);
bind(els.btnLeave, 'click', leave);
bind(els.btnCopyLink, 'click', copyLink);
bind(els.btnSend, 'click', send);
bind(els.btnToggleMic, 'click', toggleMic);
bind(els.btnToggleCam, 'click', toggleCam);
bind(els.btnToggleTheme, 'click', toggleTheme);

// Init
restoreFromUrl();
log('Готово. Введите Room ID и нажмите Подключиться.');
