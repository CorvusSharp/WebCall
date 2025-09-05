// main.js — вход
import { buildWs } from './api.js';
import { sendChat, isWsOpen } from './signal.js';
import { WebRTCManager } from './webrtc.js';
import { bind, setText, setEnabled, appendLog, appendChat } from './ui.js';

let token = null;
let ws = null;
let rtc = null;
let userId = null;

// выбранные устройства
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
  btnToggleTheme: document.getElementById('btnToggleTheme'),
};

function log(msg){ appendLog(els.logs, msg); }
function stat(line){ els.stats && appendLog(els.stats, line); }

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

// ===== Устройства
async function refreshDevices(){
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devs = await navigator.mediaDevices.enumerateDevices();
  const mics = devs.filter(d => d.kind === 'audioinput');
  const cams = devs.filter(d => d.kind === 'videoinput');
  const spks = devs.filter(d => d.kind === 'audiooutput');

  const fill = (sel, list, picked) => {
    sel.innerHTML = '';
    list.forEach(d => {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = d.label || d.kind;
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
  selected.mic = els.micSel.value || null;
  selected.cam = els.camSel.value || null;
  selected.spk = els.spkSel.value || null;
  if (rtc) rtc.setPreferredDevices({ mic: selected.mic, cam: selected.cam, spk: selected.spk });
}));

// ===== Подключение
async function connect(){
  const roomId = els.roomId.value.trim();
  if (!roomId){ log('Введите Room ID'); return; }
  if (!ensureToken()) return;

  // Закроем предыдущий сокет
  try{ if (ws && ws.readyState !== WebSocket.CLOSED) ws.close(); }catch{}

  await refreshDevices();

  ws = buildWs(roomId, token);
  ws.onopen = async () => {
    log('WS connected');
    setConnectedState(true);

    rtc = new WebRTCManager({
      localVideo: els.localVideo,
      outputDeviceId: selected.spk,
      onLog: log,
      onPeerState: (peerId, key, val) => {
        const tile = els.peersGrid.querySelector(`.tile[data-peer="${peerId}"]`);
        if (!tile) return;
        if (key === 'net') tile.querySelector('.badge.net').textContent = val || '•';
      }
    });

    if (!userId) userId = crypto.randomUUID();

    try{
      await rtc.init(ws, userId, {
        micId: selected.mic || undefined,
        camId: selected.cam || undefined
      });
      // сообщаем о входе; офферы по парам создадутся через presence/negotiationneeded
      if (isWsOpen(ws)) ws.send(JSON.stringify({ type: 'join', fromUserId: userId }));
    }catch(e){
      log(`Ошибка старта WebRTC: ${e?.name||e}`);
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

  ws.onclose = (ev) => {
    log(`WS closed (${ev?.code||''} ${ev?.reason||''})`);
    setConnectedState(false);
  };
}

function leave(){
  rtc?.close();
  try{ if (isWsOpen(ws)) ws.send(JSON.stringify({ type: 'leave', fromUserId: userId })); }catch{}
  try{ ws?.close(); }catch{}
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
  els.chatInput.value = '';
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
  if (parts[0] === 'call' && parts[1]) els.roomId.value = decodeURIComponent(parts[1]);
}

function toggleTheme(){
  document.documentElement.classList.toggle('theme-light');
}

// ===== Привязка плеера к peer
function attachPeerMedia(peerId, handlers){
  rtc?.bindPeerMedia?.(peerId, handlers);
}

// ===== Отрисовка presence и детерминированный запуск офферов
function renderPresence(members){
  const my = userId;
  const list = members.map(m => (typeof m === 'string' ? {id:m, name:m.slice(0,8)} : m));
  const others = list.filter(x=>x.id!==my);

  const grid = els.peersGrid;
  const existing = new Set(Array.from(grid.querySelectorAll('.tile')).map(n=>n.dataset.peer));

  // remove ушедших
  for (const pid of existing){
    if (!others.some(o=>o.id===pid)) grid.querySelector(`.tile[data-peer="${pid}"]`)?.remove();
  }

  // add новых
  const tpl = document.getElementById('tpl-peer-tile');
  for (const peer of others){
    if (grid.querySelector(`.tile[data-peer="${peer.id}"]`)) continue;

    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.peer = peer.id;
    node.querySelector('.name').textContent = peer.name || peer.id.slice(0,8);

    const video = node.querySelector('video');
    const meterBar = node.querySelector('.meter>span');
    const muteBtn = node.querySelector('.mute');
    const vol = node.querySelector('.volume');
    const gate = node.querySelector('.gate');

    if (typeof video.setSinkId === 'function' && rtc?.getOutputDeviceId()){
      video.setSinkId(rtc.getOutputDeviceId()).catch(()=>{});
    }

    attachPeerMedia(peer.id, {
      onTrack: async (stream)=>{
        video.srcObject = stream;
        node.querySelector('.avatar').style.display='none';
        try{
          await video.play();
        }catch{
          gate.style.display='block';
        }
      },
      onLevel: (lvl)=>{ meterBar.style.width = `${Math.min(1,Math.max(0,lvl))*100}%`; }
    });

    muteBtn.addEventListener('click', ()=>{
      video.muted = !video.muted;
      muteBtn.textContent = video.muted ? '🔊 Unmute' : '🔇 Mute';
    });
    vol.addEventListener('input', ()=>{ video.volume = parseFloat(vol.value||'1'); });
    gate.addEventListener('click', async ()=>{
      try{ await video.play(); gate.style.display='none'; }catch(e){ log(`play failed: ${e?.name||e}`); }
    });

    grid.appendChild(node);

    // детерминированный инициатор пары: у кого строковый id меньше — делает offer
    if (my && peer?.id && my < peer.id) rtc?.startOffer?.(peer.id);
  }
}

// ===== События
bind(els.btnConnect, 'click', connect);
bind(els.btnLeave, 'click', leave);
bind(els.btnCopyLink, 'click', copyLink);
bind(els.btnSend, 'click', send);
bind(els.btnToggleMic, 'click', toggleMic);
bind(els.btnToggleCam, 'click', toggleCam);
bind(els.btnToggleTheme, 'click', toggleTheme);
window.addEventListener('beforeunload', ()=>{ try{ if (isWsOpen(ws)) ws.close(); }catch{} });

// Init
restoreFromUrl();
if (ensureToken()) {
  log('Готово. Введите Room ID и нажмите Подключиться.');
  refreshDevices().catch(()=>{});
}
