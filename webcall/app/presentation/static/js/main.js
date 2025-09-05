// main.js — вход (исправлено: логируем адрес WS, кнопка диагностики, стабильные presence/инициация)
import { buildWs } from './api.js';
import { sendChat, isWsOpen } from './signal.js';
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
};

function log(msg){ appendLog(els.logs, msg); }
function stat(line){ els.stats && appendLog(els.stats, line); }

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
  const roomId = els.roomId.value.trim();
  if (!roomId){ log('Введите Room ID'); return; }
  if (!ensureToken()) return;

  isManuallyDisconnected = false;
  try{ if (ws && ws.readyState !== WebSocket.CLOSED) ws.close(); }catch{}
  if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }

  await refreshDevices();

  ws = buildWs(roomId, token);
  log(`WS connecting to: ${ws.__debug_url || '(unknown url)'}`);

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
        if (key === 'net') {
          const badge = tile.querySelector('.badge.net');
          if (badge) {
            badge.textContent = val === 'connected' ? '🟢' :
                                val === 'connecting' ? '🟡' : '🔴';
            badge.title = val;
          }
        }
      }
    });

  // Стабильный connId в рамках вкладки, чтобы не ломать адресацию targetUserId при реконнектах WS
  userId = getStableConnId();

    try{
      await rtc.init(ws, userId, {
        micId: selected.mic || undefined,
        camId: selected.cam || undefined
      });

      if (isWsOpen(ws)) {
        ws.send(JSON.stringify({
          type: 'join',
          fromUserId: userId,
          username: localStorage.getItem('wc_user') || 'User',
          accountId: accountId || null
        }));
      }
    } catch(e) {
      log(`Ошибка старта WebRTC: ${e?.name||e}`);
    }

  // Heartbeat
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  pingTimer = setInterval(()=>{ try{ if (isWsOpen(ws)) ws.send(JSON.stringify({ type: 'ping' })); }catch{} }, 30000);
  };

  ws.onmessage = async (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'signal') {
        await rtc?.handleSignal(msg, attachPeerMedia);
      } else if (msg.type === 'chat') {
        const who = msg.authorName || msg.authorId || 'system';
        appendChat(els.chat, who, msg.content || msg.echo || '');
      } else if (msg.type === 'presence') {
        log(`Участников в комнате: ${Array.isArray(msg.members) ? msg.members.length : '?'}`);
        renderPresence(msg.members || []);
      }
    } catch (e) {
      log(`Ошибка обработки сообщения: ${e}`);
    }
  };

  ws.onclose = (ev) => {
    log(`WS closed (${ev?.code||''} ${ev?.reason||''})`);
    setConnectedState(false);
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (ev?.code === 4401) {
      log('Сессия авторизации недействительна. Переходим на страницу входа...');
      isManuallyDisconnected = true;
      if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
      const params = new URLSearchParams({ redirect: location.pathname + location.search });
      location.href = `/auth?${params.toString()}`;
      return;
    }
    if (!isManuallyDisconnected && !reconnectTimeout) {
      log('Попытка переподключения через 2 секунды...');
      reconnectTimeout = setTimeout(connect, 2000);
    }
  };

  ws.onerror = (err) => { log(`WS error: ${err?.message || err}`); };
}

function leave(){
  isManuallyDisconnected = true;
  if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
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
async function runDiag(){ await rtc?.diagnoseAudio(); }

function restoreFromUrl(){
  const url = new URL(location.href);
  const rid = url.searchParams.get('room');
  if (rid) { els.roomId.value = rid; return; }
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] === 'call' && parts[1]) {
    els.roomId.value = decodeURIComponent(parts[1]);
  }
}

function toggleTheme(){ document.documentElement.classList.toggle('theme-light'); }

// ===== Привязка медиапотоков к плитке
function attachPeerMedia(peerId, handlers){
  rtc?.bindPeerMedia?.(peerId, handlers);
}

// ===== Presence + детерминированный оффер
function renderPresence(members){
  const my = userId;
  const list = members.map(m => (typeof m === 'string' ? {id:m, name:m.slice(0,8)} : m));
  const others = list.filter(x=>x.id!==my);

  const grid = els.peersGrid;
  const existing = new Set(Array.from(grid.querySelectorAll('.tile')).map(n=>n.dataset.peer));

  // Удаляем ушедших
  for (const pid of existing){
    if (!others.some(o=>o.id===pid)) grid.querySelector(`.tile[data-peer="${pid}"]`)?.remove();
  }

  // Добавляем новых и лечим существующих без активного PC
  const tpl = document.getElementById('tpl-peer-tile');
  for (const peer of others){
    const already = grid.querySelector(`.tile[data-peer="${peer.id}"]`);
    if (already){
      // Плитка есть, но мог не быть активный RTCPeerConnection (после реконнекта)
      const node = already;
      const video = node.querySelector('.video');
      const audio = node.querySelector('.audio');
      const meterBar = node.querySelector('.meter>span');
      const muteBtn = node.querySelector('.mute');
      const vol = node.querySelector('.volume');
      const gate = node.querySelector('.gate');
      const avatar = node.querySelector('.avatar');

      const setSink = async (deviceId)=>{
        if (!deviceId) return;
        for (const el of [audio, video]){
          if (typeof el.setSinkId === 'function'){
            try{ await el.setSinkId(deviceId); }catch{}
          }
        }
      };
      setSink(rtc?.getOutputDeviceId());
      attachPeerMedia(peer.id, { onSinkChange: setSink, onTrack: async (stream)=>{
        const aStream = new MediaStream(stream.getAudioTracks());
        const vStream = new MediaStream(stream.getVideoTracks());
        if (aStream.getTracks().length) {
          audio.srcObject = aStream;
          try { await audio.play(); gate.style.display='none'; } catch { gate.style.display='block'; }
        }
        if (vStream.getTracks().length) {
          video.srcObject = vStream;
          avatar.style.display='none';
          try { await video.play(); } catch {}
        }
      }, onLevel: (lvl)=>{ meterBar.style.width = `${Math.min(1, Math.max(0, lvl)) * 100}%`; } });

      // Если у нас ещё нет PC для этого peer — инициатор повторно пошлёт offer
      const st = rtc?.getPeer?.(peer.id);
      const pcState = st?.pc?.connectionState;
      if ((!st || pcState === 'closed' || pcState === 'failed' || pcState === 'disconnected') && my && my < peer.id){
        setTimeout(()=> rtc?.startOffer?.(peer.id), 200);
      }
      continue;
    }

    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.peer = peer.id;
    node.querySelector('.name').textContent = peer.name || peer.id.slice(0,8);

    const video = node.querySelector('.video');
    const audio = node.querySelector('.audio');
    const meterBar = node.querySelector('.meter>span');
    const muteBtn = node.querySelector('.mute');
    const vol = node.querySelector('.volume');
    const gate = node.querySelector('.gate');
    const avatar = node.querySelector('.avatar');

    const setSink = async (deviceId)=>{
      if (!deviceId) return;
      for (const el of [audio, video]){
        if (typeof el.setSinkId === 'function'){
          try{ await el.setSinkId(deviceId); }catch{}
        }
      }
    };
    setSink(rtc?.getOutputDeviceId());
    attachPeerMedia(peer.id, { onSinkChange: setSink, onTrack: async (stream)=>{
        const aStream = new MediaStream(stream.getAudioTracks());
        const vStream = new MediaStream(stream.getVideoTracks());
        if (aStream.getTracks().length) {
          audio.srcObject = aStream;
          try { await audio.play(); gate.style.display='none'; } catch { gate.style.display='block'; }
        }
        if (vStream.getTracks().length) {
          video.srcObject = vStream;
          avatar.style.display='none';
          try { await video.play(); } catch {}
        }
      }, onLevel: (lvl)=>{ meterBar.style.width = `${Math.min(1, Math.max(0, lvl)) * 100}%`; } });

    muteBtn.addEventListener('click', ()=>{
      audio.muted = !audio.muted;
      muteBtn.textContent = audio.muted ? '🔊 Unmute' : '🔇 Mute';
    });
    vol.addEventListener('input', ()=>{ audio.volume = parseFloat(vol.value || '1'); });
    gate.addEventListener('click', async ()=>{
      try{ await audio.play(); await video.play(); gate.style.display='none'; }
      catch(e){ log(`play failed: ${e?.name||e}`); }
    });

    grid.appendChild(node);

    // инициатор — у кого id меньше
  if (my && peer?.id && my < peer.id) {
      setTimeout(() => rtc?.startOffer?.(peer.id), 400);
    }
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
bind(els.btnDiag, 'click', runDiag);
bind(els.chatInput, 'keypress', (e)=>{ if (e.key === 'Enter') send(); });

window.addEventListener('beforeunload', ()=>{ try{ if (isWsOpen(ws)) ws.close(); }catch{} });

// Init
restoreFromUrl();
if (ensureToken()) {
  log('Готово. Введите Room ID и нажмите Подключиться.');
  refreshDevices().catch(()=>{});
}
