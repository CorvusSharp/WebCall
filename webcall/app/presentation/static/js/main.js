// main.js - entry
import { buildWs } from './api.js';
import { sendChat } from './signal.js';
import { WebRTCManager } from './webrtc.js';
import { bind, setText, setEnabled, appendLog, appendChat } from './ui.js';

let token = null;
let ws = null;
let rtc = null;
let outputDeviceId = null;
let userId = null;

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
  remoteVideo: document.getElementById('remoteVideo'),
  peersGrid: document.getElementById('peersGrid'),
  remoteMute: document.getElementById('remoteMute'),
  remoteVolume: document.getElementById('remoteVolume'),
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

function ensureToken(){
  token = localStorage.getItem('wc_token');
  if (!token){
    const params = new URLSearchParams({ redirect: '/call' });
    if (els.roomId.value) params.set('room', els.roomId.value);
    location.href = `/auth?${params.toString()}`;
    return false;
  }
  try{ userId = JSON.parse(atob(token.split('.')[1])).sub; }catch{}
  return true;
}

async function connect(){
  const roomId = els.roomId.value.trim();
  if (!roomId){ log('Введите Room ID'); return; }
  if (!ensureToken()) return;
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
      remoteVideo: null, // мультипир — не используем единый remoteVideo
      outputDeviceId,
      onLog: log,
    });
    if (!userId){
      // dev/test: временный случайный id (для работы без логина)
      userId = crypto.randomUUID();
    }
    try {
      // мультипир: только инициализация локального PC состояния, без немедленного оффера
      await rtc.init(ws, userId);
      // сообщаем о входе для presence
      ws.send(JSON.stringify({ type: 'join', fromUserId: userId }));
    } catch (e) {
      log(`Ошибка старта WebRTC: ${e?.name || e}`);
    }
  };
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'signal') {
      await rtc?.handleSignal(msg, attachPeerMedia);
    } else if (msg.type === 'chat') {
      const who = msg.authorName || msg.authorId || 'system';
      appendChat(els.chat, who, msg.content || msg.echo || '');
    } else if (msg.type === 'presence') {
      renderPresence(msg.members || []);
    }
  };
  ws.onclose = () => { log('WS closed'); setConnectedState(false); };
}

function leave(){
  rtc?.close();
  setConnectedState(false);
}

function copyLink(){
  const rid = els.roomId.value.trim();
  const pretty = `${location.origin}/call/${encodeURIComponent(rid)}`;
  navigator.clipboard.writeText(pretty);
  log('Ссылка скопирована');
}

function send(){
  const text = els.chatInput.value.trim();
  if (!text) return;
  sendChat(ws, text, userId);
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
  if (rid) { els.roomId.value = rid; return; }
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] === 'call' && parts[1]) {
    els.roomId.value = decodeURIComponent(parts[1]);
  }
}

function toggleTheme(){
  document.documentElement.classList.toggle('light');
}

// Presence rendering and media hookups
function renderPresence(members){
  if (!els.peersGrid) return;
  const my = userId;
  const list = members.map(m=> (typeof m === 'string'? {id:m, name:m.slice(0,8)} : m));
  const others = list.filter(x=>x.id!==my);
  const grid = els.peersGrid;
  const existing = new Set(Array.from(grid.querySelectorAll('.peer-tile')).map(n=>n.dataset.peer));
  // Remove tiles of peers no longer present
  for (const peer of existing){
    if (!others.some(o=>o.id===peer)) grid.querySelector(`.peer-tile[data-peer="${peer}"]`)?.remove();
  }
  // Add tiles for new peers
  const tpl = document.getElementById('tpl-peer-tile');
  for (const peer of others){
    if (grid.querySelector(`.peer-tile[data-peer="${peer.id}"]`)) continue;
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.peer = peer.id;
    node.querySelector('.name').textContent = peer.name || peer.id.slice(0,8);
    const v = node.querySelector('video');
    const bar = node.querySelector('.level-bar>span');
    const volume = node.querySelector('.volume');
    const muteBtn = node.querySelector('.mute');
    // Attach media when first track arrives
    attachPeerMedia(peer.id, {
      onTrack: (stream)=>{ v.srcObject = stream; node.querySelector('.avatar').style.display='none'; },
      onLevel: (lvl)=>{ if (bar) bar.style.width = `${Math.min(1,Math.max(0,lvl))*100}%`; }
    });
    // Local mute/volume controls
    muteBtn.addEventListener('click', ()=>{ if (v) v.muted = !v.muted; muteBtn.textContent = v.muted? 'Unmute':'Mute'; });
    volume.addEventListener('input', ()=>{ if (v) v.volume = parseFloat(volume.value||'1'); });
    grid.appendChild(node);

    // Детерминированное правило: инициатор — у кого id строкой меньше
    if (my && peer?.id && my < peer.id) {
      rtc?.startOffer?.(peer.id);
    }
  }
}

// Provide hook to WebRTC manager to connect per-peer media events
function attachPeerMedia(peerId, handlers){
  // Manager will call this when it has media for peer
  rtc?.bindPeerMedia?.(peerId, handlers);
}

// Events
bind(els.btnConnect, 'click', connect);
bind(els.btnLeave, 'click', leave);
bind(els.btnCopyLink, 'click', copyLink);
bind(els.btnSend, 'click', send);
bind(els.btnToggleMic, 'click', toggleMic);
bind(els.btnToggleCam, 'click', toggleCam);
bind(els.btnToggleTheme, 'click', toggleTheme);
els.remoteMute?.addEventListener('change', ()=>{ if (els.remoteVideo) els.remoteVideo.muted = !!els.remoteMute.checked; });
els.remoteVolume?.addEventListener('input', ()=>{ if (els.remoteVideo) els.remoteVideo.volume = parseFloat(els.remoteVolume.value||'1'); });

// Init
restoreFromUrl();
if (ensureToken()) {
  log('Готово. Введите Room ID и нажмите Подключиться.');
}
