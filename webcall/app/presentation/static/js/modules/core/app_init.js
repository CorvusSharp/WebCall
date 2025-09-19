// modules/app_init.js
// Оркестрация инициализации приложения: UI, WebSocket комнаты, друзья, push, permissions.

import { buildWs, getMe } from '../../api.js';
import * as signal from '../../signal.js';
import { WebRTCManager } from '../../webrtc.js';
import { els, appendLog, appendChat, setText, setEnabled, showToast } from './dom.js';
import { appState } from './state.js';
import { loadVisitedRooms } from '../visited_rooms.js';
import { initFriendsModule, loadFriends, scheduleFriendsReload, initFriendsUI } from '../friends_ui.js';
import { initDirectChatModule, handleIncomingDirect, handleDirectCleared, bindSendDirect } from '../direct_chat.js';
// Legacy calls.js оставляем временно для обратной совместимости (звук, часть тестов)
import { startSpecialRingtone, stopSpecialRingtone, resetActiveCall, getActiveCall, initCallModule } from '../calls.js';
// Новый signaling слой
import { initCallSignaling, handleWsMessage as handleCallSignal, startOutgoingCall as startOutgoingCallNew } from '../calls_signaling.js';
import { checkAndRequestPermissionsInitial, updatePermBanner } from '../permissions.js';
import { initPush } from '../push_subscribe.js';
import { bus } from './event_bus.js';
import { startStatsLoop, stopStatsLoop, formatBitrate } from '../stats.js';

// ===== Helpers =====
function log(msg){ appendLog(els.logs, msg); }
function stat(line){ appendLog(els.stats, line); }

function getStableConnId(){
  try {
    let id = sessionStorage.getItem('wc_connid');
    if (!id){ id = crypto.randomUUID(); sessionStorage.setItem('wc_connid', id); }
    return id;
  } catch { return crypto.randomUUID(); }
}
// Корректное декодирование JWT payload c base64url → JSON
function b64urlDecode(str){
  try {
    // Преобразуем base64url в base64
    str = str.replace(/-/g,'+').replace(/_/g,'/');
    const pad = str.length % 4; if (pad) str += '='.repeat(4-pad);
    return atob(str);
  } catch { return ''; }
}
function getAccountId(){
  try {
    const t = localStorage.getItem('wc_token'); if (!t) return null; const part = t.split('.')[1]; if (!part) return null;
    const raw = b64urlDecode(part); if (!raw) return null; const payload = JSON.parse(raw);
    return payload.sub || null;
  } catch { return null; }
}

// ====== Audio unlock ======
export function unlockAudioPlayback(){
  try {
    if (!appState.userGestureHappened) return false;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx){
      if (!appState.globalAudioCtx) appState.globalAudioCtx = new Ctx();
      if (appState.globalAudioCtx.state === 'suspended') appState.globalAudioCtx.resume().catch(()=>{});
      try {
        const buffer = appState.globalAudioCtx.createBuffer(1,1,22050);
        const source = appState.globalAudioCtx.createBufferSource();
        source.buffer = buffer; source.connect(appState.globalAudioCtx.destination); source.start(0);
      } catch {}
      try { appState.audioUnlocked = (appState.globalAudioCtx.state === 'running'); } catch { appState.audioUnlocked = false; }
    }
    document.querySelectorAll('audio').forEach(a=>{ try{ a.playsInline = true; a.muted=false; a.volume=1.0; a.play().catch(()=>{}); }catch{} });
  } catch {}
}

// ===== Connection state UI =====
function showPreJoin(){ if (els.inCallControls) els.inCallControls.style.display='none'; if (els.inCallSection) els.inCallSection.style.display='none'; if (els.visitedCard) els.visitedCard.style.display=''; if (els.statusCard) els.statusCard.style.display='none'; }
function showInCall(){ if (els.inCallControls) els.inCallControls.style.display=''; if (els.inCallSection) els.inCallSection.style.display=''; if (els.visitedCard) els.visitedCard.style.display='none'; if (els.statusCard) els.statusCard.style.display=''; }

function setConnectingState(isConnecting){ setText(els.connStatus, isConnecting ? 'Подключение...' : 'Не подключено'); setEnabled(els.btnConnect, !isConnecting); setEnabled(els.btnLeave, false); setEnabled(els.btnSend, false); setEnabled(els.btnToggleMic, false); }
function setConnectedState(connected){ setText(els.connStatus, connected ? 'Подключено' : 'Не подключено'); setEnabled(els.btnConnect, !connected); setEnabled(els.btnSend, connected); setEnabled(els.btnLeave, connected); setEnabled(els.btnToggleMic, connected); if (connected) showInCall(); else { showPreJoin(); if (els.callContext) els.callContext.textContent=''; } }

function ensureToken(){
  appState.token = localStorage.getItem('wc_token');
  if (!appState.token){
    const params = new URLSearchParams({ redirect:'/call' });
    if (els.roomId?.value) params.set('room', els.roomId.value);
    location.href = `/auth?${params.toString()}`; return false;
  }
  try {
    const payload = JSON.parse(atob(appState.token.split('.')[1]));
    appState.accountId = payload.sub; const now = Math.floor(Date.now()/1000);
    if (payload.exp && now >= payload.exp){
      localStorage.removeItem('wc_token');
      const params = new URLSearchParams({ redirect:'/call' }); if (els.roomId?.value) params.set('room', els.roomId.value);
      location.href = `/auth?${params.toString()}`; return false;
    }
  } catch {}
  return true;
}

// ===== Devices =====
async function refreshDevices(){
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devs = await navigator.mediaDevices.enumerateDevices();
  const mics = devs.filter(d=>d.kind==='audioinput');
  const cams = devs.filter(d=>d.kind==='videoinput');
  const spks = devs.filter(d=>d.kind==='audiooutput');
  const fill = (sel,list,picked)=>{ if (!sel) return; sel.innerHTML=''; list.forEach(d=>{ const o=document.createElement('option'); o.value=d.deviceId; o.textContent=d.label||`Unknown ${d.kind}`; if (picked && picked===d.deviceId) o.selected=true; sel.appendChild(o); }); };
  fill(els.micSel,mics,appState.selected.mic); fill(els.camSel,cams,appState.selected.cam); fill(els.spkSel,spks,appState.selected.spk);
  const summary = devs.map(d=>`${d.kind}:${d.label||'(no)'}:${(d.deviceId||'').slice(0,6)}`).join(' | ');
  stat(`Devices: ${summary}`);
}

// ===== WS Room connect =====
export async function connectRoom(){
  if (appState.ws) return;
  appState.isManuallyDisconnected = false;
  if (!ensureToken()) { log('Нет токена'); return; }
  const roomId = els.roomId.value.trim(); if (!roomId){ log('Нужен ID комнаты'); return; }
  log(`Подключение к комнате ${roomId}...`); setConnectingState(true);
  appState.ws = buildWs(roomId, appState.token); appState.userId = getStableConnId();
  log(`Мой connId: ${appState.userId}`); log(`Адрес WS: ${appState.ws.__debug_url}`);

  appState.rtc = new WebRTCManager({
    localVideo: els.localVideo,
    outputDeviceId: appState.selected.spk,
    onLog: log,
    onPeerState: (peerId,key,value)=>{ const tile=document.querySelector(`.tile[data-peer="${peerId}"]`); if (tile) tile.dataset[key]=value; }
  });

  const sendPingSafe = signal.sendPing ?? (ws => { try { if (ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify({type:'ping'})); } catch {} });

  appState.ws.onopen = async () => {
    appState.isReconnecting = false; log('WS открыт'); setConnectedState(true);
    if (appState.reconnectTimeout) clearTimeout(appState.reconnectTimeout);
    if (appState.pingTimer) clearInterval(appState.pingTimer);
    appState.pingTimer = setInterval(()=> sendPingSafe(appState.ws), 30000);
    try { const storedU = localStorage.getItem('wc_username') || undefined; appState.ws.send(JSON.stringify({ type:'join', fromUserId: appState.userId, username: storedU })); } catch {}
    await appState.rtc.init(appState.ws, appState.userId, { micId: appState.selected.mic, camId: appState.selected.cam });
    // Запуск метрик после готовности rtc
    try {
      startStatsLoop({ intervalMs: 4000 });
    } catch {}
    try { stopSpecialRingtone(); } catch {}
    // peer cleanup
    try {
      if (appState.peerCleanupIntervalId) { clearInterval(appState.peerCleanupIntervalId); }
      appState.peerCleanupIntervalId = setInterval(()=>{
        try {
          if (!appState.rtc || !appState.rtc.peers) return;
          const now = Date.now();
          for (const [pid, st] of Array.from(appState.rtc.peers.entries())){
            const created = st.createdAt || st._createdAt || now; if (!st.createdAt) st.createdAt = created;
            const iceState = st.pc?.iceConnectionState || st.pc?.connectionState;
            const isBad = ['failed','disconnected','closed'].includes(iceState);
            if (isBad && (now - created > 120000)){
              try { st.pc && st.pc.close(); } catch {}
              try { if (st.level?.raf) cancelAnimationFrame(st.level.raf); } catch {}
              appState.rtc.peers.delete(pid);
              const tile = document.querySelector(`.tile[data-peer="${pid}"]`);
              if (tile){ safeReleaseMedia(tile); tile.remove(); }
              log(`Удалён проблемный пир ${pid} (state=${iceState})`);
            }
          }
        } catch {}
      }, 5000);
    } catch {}
    try {
      const hasVideo = !!(appState.rtc.localStream && appState.rtc.localStream.getVideoTracks()[0] && appState.rtc.localStream.getVideoTracks()[0].enabled);
      const card = document.getElementById('localCard'); if (card) card.style.display = hasVideo ? '' : 'none';
    } catch {}
    try { await loadVisitedRooms(); } catch {}
  };

  appState.ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'signal'){
      await appState.rtc.handleSignal(msg, bindPeerMedia);
    } else if (msg.type === 'presence'){
      appState.latestUserNames = msg.userNames || {};
      const readable = msg.users.map(u => appState.latestUserNames[u] || u.slice(0,6));
      log(`В комнате: ${readable.join(', ')}`);
      document.querySelectorAll('.tile').forEach(tile => {
        const pid = tile.getAttribute('data-peer'); const nm = tile.querySelector('.name');
        if (pid && nm) nm.textContent = appState.latestUserNames[pid] || `user-${pid.slice(0,6)}`;
      });
      const myId = getStableConnId();
      const allowed = new Set(msg.users.filter(u => u !== myId));
      document.querySelectorAll('.tile').forEach(tile => { const pid=tile.getAttribute('data-peer'); if (pid && !allowed.has(pid)){ safeReleaseMedia(tile); tile.remove(); } });
      if (appState.rtc && appState.rtc.peers){ for (const [pid,st] of Array.from(appState.rtc.peers.entries())){ if (!allowed.has(pid)){ try { st.pc.onicecandidate=null; st.pc.close(); } catch {}; try { if (st.level?.raf) cancelAnimationFrame(st.level.raf); } catch {}; appState.rtc.peers.delete(pid); } } }
      for (const peerId of msg.users){ if (peerId === myId) continue; try { const last = appState.recentOffer.get(peerId) || 0; const now=Date.now(); if (now - last < 3000){ log(`Пропущен повторный старт для ${peerId}`); continue; } appState.recentOffer.set(peerId, now); } catch {}
        try { log(`Обнаружен пир ${peerId}, инициирую звонок...`); await appState.rtc.startOffer(peerId); } catch(e){ log(`startOffer(${peerId}) failed: ${e}`); }
      }
    } else if (msg.type === 'user_joined'){ log(`Присоединился: ${msg.userId}`); }
    else if (msg.type === 'user_left'){ log(`Отключился: ${msg.userId}`); const tile=document.querySelector(`.tile[data-peer="${msg.userId}"]`); if (tile) tile.remove(); }
    else if (msg.type === 'chat'){
      const senderId = msg.fromUserId || msg.authorId;
      const who = msg.authorName || (senderId ? (appState.latestUserNames[senderId] || senderId.slice(0,6)) : 'unknown');
      let isSelf = false; const myConn = getStableConnId();
      if (senderId && senderId === myConn) isSelf = true; else {
        try { const storedU = localStorage.getItem('wc_username'); if (!senderId && storedU && storedU === msg.authorName) isSelf = true; if (!isSelf && storedU && storedU === msg.authorName && Date.now() - (window.__lastChatSendTs||0) < 1500) isSelf = true; } catch {}
      }
      appendChat(els.chat, who, msg.content, { self: isSelf });
    }
  };

  appState.ws.onclose = (ev) => {
    log(`WS закрыт: ${ev.code} ${ev.reason}`); setConnectedState(false); stopSpecialRingtone();
    if (appState.pingTimer) clearInterval(appState.pingTimer);
    if (appState.rtc) { appState.rtc.close(); appState.rtc = null; }
    try { stopStatsLoop(); } catch {}
    appState.ws = null; if (appState.peerCleanupIntervalId) { clearInterval(appState.peerCleanupIntervalId); appState.peerCleanupIntervalId=null; }
    if (!appState.isManuallyDisconnected && !appState.isReconnecting){ appState.isReconnecting = true; log('Попытка переподключения через 3с...'); appState.reconnectTimeout = setTimeout(connectRoom, 3000); }
  };
  appState.ws.onerror = (err)=>{ log(`WS ошибка: ${err?.message||'unknown'}`); try { appState.ws?.close(); } catch {} };
}

function safeReleaseMedia(el){
  try {
    if (!el) return;
    if (el.classList && el.classList.contains && el.classList.contains('tile')){
      const aud = el.querySelector('audio'); const vid = el.querySelector('video');
      try { safeReleaseMedia(aud); } catch {}; try { safeReleaseMedia(vid); } catch {}; return;
    }
    if (el instanceof HTMLMediaElement){
      try { const s = el._peerStream || el.srcObject; if (s && s.getTracks) s.getTracks().forEach(t=>{ try { t.stop(); } catch {} }); } catch {}
      try { el.pause(); } catch {}; try { el.srcObject=null; } catch {}; try { el.removeAttribute('src'); } catch {}; try { el.load?.(); } catch {}
    }
  } catch {}
}

function bindPeerMedia(peerId){
  if (document.querySelector(`.tile[data-peer="${peerId}"]`)) return;
  const tpl = document.getElementById('tpl-peer-tile');
  const tile = tpl.content.firstElementChild.cloneNode(true); tile.dataset.peer = peerId; els.peersGrid.appendChild(tile);
  const video = tile.querySelector('video'); const audio = tile.querySelector('audio'); const name = tile.querySelector('.name'); const vol = tile.querySelector('input[type="range"][name="volume"]'); const level = tile.querySelector('.level-bar');
  name.textContent = appState.latestUserNames[peerId] || `user-${peerId.slice(0,6)}`;
  if (video){ video.playsInline=true; video.autoplay=true; video.muted=true; }
  if (audio){ audio.autoplay=true; }
  appState.rtc.bindPeerMedia(peerId, {
    onTrack: (stream) => {
      log(`Получен медиа-поток от ${peerId.slice(0,6)}`); stopSpecialRingtone(); if (video) video.srcObject=stream; if (audio){ audio.srcObject=stream; try{ audio._peerStream=stream; }catch{}; audio.muted=false; audio.volume = vol ? (Math.min(100, Math.max(0, Number(vol.value)||100))/100) : 1.0; audio.play().catch(()=>{ unlockAudioPlayback(); setTimeout(()=> audio.play().catch(()=>{}), 250); }); }
    },
    onLevel: (value)=>{ level.style.transform = `scaleX(${value})`; },
    onSinkChange: (deviceId)=>{ if (audio && audio.setSinkId){ audio.setSinkId(deviceId).catch(e=>log(`sinkAudio(${peerId.slice(0,6)}): ${e.name}`)); } }
  });
  if (vol && audio){ vol.addEventListener('input', ()=>{ const v = Math.min(100, Math.max(0, Number(vol.value)||0)); audio.volume = v/100; }); }
}

export function leaveRoom(){
  appState.isManuallyDisconnected = true;
  try {
    // Если это личный звонок (activeCall принят и roomId начинается с call-), шлём завершающий сигнал через friends WS
    const c = getActiveCall();
    if (c && c.status === 'accepted' && (c.roomId||'').startsWith('call-') && appState.friendsWs && appState.friendsWs.readyState===WebSocket.OPEN){
      const payload = { type:'call_end', roomId: c.roomId, toUserId: c.withUserId, reason:'leave' };
      appState.friendsWs.send(JSON.stringify(payload));
    }
  } catch {}
  try { appState.ws?.send(JSON.stringify({ type:'leave', fromUserId: appState.userId })); } catch {}
  if (appState.ws) appState.ws.close(); if (appState.rtc) { appState.rtc.close(); appState.rtc=null; }
  setConnectedState(false);
  try { els.peersGrid.querySelectorAll('.tile').forEach(t=> safeReleaseMedia(t)); } catch {}
  els.peersGrid.innerHTML=''; log('Отключено'); if (appState.peerCleanupIntervalId){ clearInterval(appState.peerCleanupIntervalId); appState.peerCleanupIntervalId=null; }
  if (getActiveCall()) resetActiveCall('leave');
  try { loadVisitedRooms(); } catch {}
}

// ===== Friends WS =====
function startFriendsWs(){
  if (appState.friendsWs) return; 
  const t = localStorage.getItem('wc_token'); 
  if (!t) {
    log('Friends WS: токен не найден, пропуск подключения');
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = new URL(`${proto}://${location.host}/ws/friends`); url.searchParams.set('token', t);
  log(`Friends WS: подключение к ${url.toString()}`);
  
  try {
    appState.friendsWs = new WebSocket(url.toString());
    appState.friendsWs.onopen = ()=>{ 
      log('WS друзей открыт'); 
      try { 
        appState.friendsWs.send(JSON.stringify({ type:'ping' })); 
        log('Friends WS: ping отправлен');
      } catch (e) {
        log('Friends WS: ошибка отправки ping:', e);
      }
    };
  appState.friendsWs.onmessage = async (ev)=>{
    try { const msg = JSON.parse(ev.data); if (!msg || typeof msg !== 'object') return; switch(msg.type){
      case 'friend_request': case 'friend_accepted': case 'friend_cancelled': scheduleFriendsReload(); break;
      case 'friend_removed': scheduleFriendsReload(); break;
      case 'direct_message': handleIncomingDirect(msg); try { const acc=getAccountId(); const other= msg.fromUserId === acc ? msg.toUserId : msg.fromUserId; const isActiveChat = appState.currentDirectFriend && other === appState.currentDirectFriend; const iAmRecipient = msg.toUserId === acc; if (iAmRecipient && !isActiveChat && 'Notification' in window && Notification.permission==='granted'){ const title = 'Новое сообщение'; const body = msg.fromUsername ? `От ${msg.fromUsername}` : 'Личное сообщение'; const reg = await navigator.serviceWorker.getRegistration('/static/sw.js'); if (reg && reg.showNotification){ reg.showNotification(title, { body, data:{ type:'direct', from: other } }); } else { new Notification(title, { body, data:{ type:'direct', from: other } }); } } } catch {} break;
      case 'direct_cleared': handleDirectCleared(msg); break;
      case 'call_invite':
      case 'call_accept':
      case 'call_decline':
      case 'call_cancel':
      case 'call_end': {
        // Делегируем в новый signaling слой
        try { handleCallSignal(msg); } catch {}
        break; }
      default: break;
    } } catch {}
  };
    appState.friendsWs.onclose = (event)=>{ 
      log(`Friends WS закрыт: код=${event.code}, причина=${event.reason}`);
      appState.friendsWs = null; 
      setTimeout(()=>{ try { startFriendsWs(); } catch {} }, 5000); 
    };
    appState.friendsWs.onerror = (error)=>{ 
      log('Friends WS ошибка:', error);
      try { appState.friendsWs.close(); } catch {}; 
    };
  } catch (error) {
    log('Friends WS: ошибка создания соединения:', error);
    appState.friendsWs = null;
    // Повторяем попытку через 10 секунд
    setTimeout(()=>{ try { startFriendsWs(); } catch {} }, 10000);
  }
}

async function ensureProfile(){
  try { const t = localStorage.getItem('wc_token'); const hasEmail = !!localStorage.getItem('wc_email'); const hasName = !!localStorage.getItem('wc_username'); if (t && (!hasEmail || !hasName)){ const me = await getMe(); if (me?.email) localStorage.setItem('wc_email', me.email); if (me?.username) localStorage.setItem('wc_username', me.username); } } catch {}
}

// ===== User badge (header current user) =====
function updateUserBadge(){
  try {
    const name = localStorage.getItem('wc_username');
    if (name && els.currentUserBadge && els.currentUsername){
      els.currentUsername.textContent = name;
      els.currentUserBadge.style.display = 'inline-flex';
    } else if (els.currentUserBadge){
      els.currentUserBadge.style.display = 'none';
    }
  } catch {}
}

// ===== UI Setup =====
function setupUI(){
  els.btnConnect?.addEventListener('click', ()=>{ unlockAudioPlayback(); connectRoom(); });
  els.btnLeave?.addEventListener('click', leaveRoom);
  els.btnCopyLink?.addEventListener('click', ()=>{ const url = new URL(location.href); url.searchParams.set('room', els.roomId.value); navigator.clipboard.writeText(url.toString()); log('Ссылка скопирована'); });
  els.btnSend?.addEventListener('click', ()=>{ const text = els.chatInput.value; if (text && appState.ws){ (signal.sendChat || (()=>{}))(appState.ws, text, getStableConnId()); try { window.__lastChatSendTs = Date.now(); } catch {}; els.chatInput.value=''; } });
  els.chatInput?.addEventListener('keydown', e=>{ if (e.key==='Enter') els.btnSend.click(); });
  els.btnToggleMic?.addEventListener('click', async ()=>{ if (!appState.rtc) return; const enabled = await appState.rtc.toggleMic(); els.btnToggleMic.textContent = enabled ? 'Выкл.микро' : 'Вкл.микро'; });
  els.btnDiag?.addEventListener('click', ()=> appState.rtc?.diagnoseAudio());
  els.btnToggleTheme?.addEventListener('click', ()=>{ const isDark = document.body.classList.toggle('dark'); localStorage.setItem('theme', isDark ? 'dark' : 'light'); });
  els.btnLogout?.addEventListener('click', ()=>{ try { localStorage.removeItem('wc_token'); localStorage.removeItem('wc_username'); } catch {}; try { sessionStorage.removeItem('wc_connid'); } catch {}; if (appState.ws){ try { appState.ws.close(); } catch {} } const params = new URLSearchParams({ redirect:'/call' }); if (els.roomId.value) params.set('room', els.roomId.value); location.href = `/auth?${params.toString()}`; });

  // user gesture unlock
  const runPendingAutoplay = ()=>{ const tasks = appState.pendingAutoplayTasks.slice(); appState.pendingAutoplayTasks=[]; tasks.forEach(t=>{ try { t(); } catch {} }); };
  const gestureUnlock = ()=>{ appState.userGestureHappened = true; try { unlockAudioPlayback(); } catch {}; try { runPendingAutoplay(); } catch {}; document.removeEventListener('click', gestureUnlock, { capture:true }); document.removeEventListener('touchstart', gestureUnlock, { capture:true }); document.removeEventListener('keydown', gestureUnlock, { capture:true }); };
  document.addEventListener('click', gestureUnlock, { once:true, capture:true });
  document.addEventListener('touchstart', gestureUnlock, { once:true, capture:true });
  document.addEventListener('keydown', gestureUnlock, { once:true, capture:true });
  const onHidden = ()=>{ try { appState.pendingAutoplayTasks=[]; } catch {}; try { stopSpecialRingtone(); } catch {}; };
  document.addEventListener('visibilitychange', ()=>{ if (document.hidden) onHidden(); });
  window.addEventListener('pagehide', onHidden, { capture:true });
  if (localStorage.getItem('theme')==='dark') document.body.classList.add('dark');
  const u = new URL(location.href); if (u.searchParams.has('room')) els.roomId.value = u.searchParams.get('room');
  showPreJoin();
}

// ===== Public init =====
export async function appInit(){
  setConnectedState(false);
  setupUI();
  refreshDevices();
  log('Приложение инициализировано');

  // Инициализация модуля звонков (хуки для подключения комнаты и аудио)
  try { initCallModule({ reloadFriends: loadFriends, unlockAudioPlayback, connectRoom }); } catch {}
  try {
    initCallSignaling({
      getAccountId,
      connectRoom: ()=>{ if (!appState.ws) connectRoom(); },
      unlockAudio: unlockAudioPlayback,
    });
  } catch {}

  initDirectChatModule({ log, getAccountId });
  try { bindSendDirect(); } catch {}
  initFriendsModule({ log, unlockAudioPlayback, connectRoom });
  try { initFriendsUI(); } catch {}

  loadVisitedRooms().catch(()=>{});
  checkAndRequestPermissionsInitial();
  try { initPush(); } catch {}
  await ensureProfile();
  try { updateUserBadge(); } catch {}
  
  // Делаем showToast и startFriendsWs доступными глобально для удобства использования из других модулей
  try { 
    window.showToast = showToast; 
    window.startFriendsWs = startFriendsWs;
    
    // Добавляем функцию диагностики WebSocket (для отладки)
    window.debugWebSocket = () => {
      const ws = window.appState?.friendsWs;
      const token = localStorage.getItem('wc_token');
      const states = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
      const info = {
        hasToken: !!token,
        hasWebSocket: !!ws,
        wsState: ws ? states[ws.readyState] || ws.readyState : 'не создан',
        url: ws ? ws.url : 'нет'
      };
      console.log('WebSocket диагностика:', info);
      showToast(`WS: ${info.wsState}, Token: ${info.hasToken ? 'есть' : 'нет'}`, 'info');
      return info;
    };
  } catch {}
  
  startFriendsWs();
  try { await loadFriends(); } catch {}
  // Подписка на статистику
  try {
    bus.on('stats:sample', (s)=>{
      if (!els.stats) return;
      const last = s.peers.map(p=> `${p.peerId.slice(0,6)} in:${formatBitrate(p.inAudioBitrate)} out:${formatBitrate(p.outAudioBitrate)} lossIn:${p.packetLossIn!=null?(p.packetLossIn*100).toFixed(1)+'%':'-'} rtt:${p.rtt!=null?Math.round(p.rtt)+'ms':'-'}`).join(' | ');
      appendLog(els.stats, `STATS ${new Date(s.ts).toLocaleTimeString()} ${last}`);
    });
  } catch {}
  // SW уведомления → открыть чат
  try { if ('serviceWorker' in navigator){ navigator.serviceWorker.addEventListener('message', (e)=>{ const data=e.data||{}; if (data.type==='openDirect' && data.userId){ const open=()=> selectDirectFriend(data.userId, data.userId, { force:true }).catch(()=>{}); if (els.friendsList && els.friendsList.children.length) open(); else setTimeout(open,300); } }); } } catch {}
}
