// modules/app_init.js
// Оркестрация инициализации приложения: UI, WebSocket комнаты, друзья, push, permissions.

import { buildWs, getMe } from '../../api.js';
import * as signal from '../../signal.js';
import { WebRTCManager } from '../../webrtc.js';
import { els, appendLog, appendChat, setText, setEnabled, showToast } from './dom.js';
import { appState } from './state.js';
import { loadVisitedRooms } from '../visited_rooms.js';
import { initFriendsModule, loadFriends, scheduleFriendsReload, initFriendsUI, markFriendSeen, refreshFriendStatuses, setOnlineSnapshot, addOnlineUser, removeOnlineUser } from '../friends_ui.js';
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
  try {
    if (els.camSel && !els.camSel._wc_bound){
      els.camSel.addEventListener('change', async ()=>{
        const devId = els.camSel.value; appState.selected.cam = devId; try { localStorage.setItem('wc_cam', devId); } catch {}
        if (appState.rtc){
          if (appState.rtc._currentVideoKind === 'camera'){
            await appState.rtc.switchCamera(devId);
          } else {
            appState.rtc.preferred.camId = devId;
          }
        }
      });
      els.camSel._wc_bound = true;
    }
  } catch {}
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
    onPeerState: (peerId,key,value)=>{ const tile=document.querySelector(`.tile[data-peer="${peerId}"]`); if (tile) tile.dataset[key]=value; },
    onVideoState: (kind)=>{
      try {
        const camBtn = els.btnToggleCam; const screenBtn = els.btnScreenShare; const scrBadge = document.getElementById('screenShareBadge');
        const multiBadge = document.getElementById('multiBadge');
        const stopCam = document.getElementById('btnStopCam');
        const stopScr = document.getElementById('btnStopScreen');
        const mixBtn = document.getElementById('btnCompositeToggle');
        camBtn?.classList.remove('btn-media-active'); screenBtn?.classList.remove('btn-media-active');
        if (scrBadge) scrBadge.style.display = (kind==='screen' || kind==='multi') ? '' : 'none';
        if (multiBadge) multiBadge.style.display = (kind==='multi') ? '' : 'none';
        if (kind==='camera' || kind==='multi') camBtn?.classList.add('btn-media-active');
        if (kind==='screen' || kind==='multi') screenBtn?.classList.add('btn-media-active');
        if (stopCam) stopCam.style.display = (kind==='camera' || kind==='multi') ? '' : 'none';
        if (stopScr) stopScr.style.display = (kind==='screen' || kind==='multi') ? '' : 'none';
        if (mixBtn) {
          // Показываем кнопку только когда есть одновременно экран и камера
          mixBtn.style.display = (kind==='multi') ? '' : 'none';
        }
        const card = document.getElementById('localCard'); if (card) card.style.display = (kind==='none') ? 'none' : '';
      } catch {}
    }
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
      try { updatePeerLayout(); } catch {}
      // Авто-выход из личной комнаты звонка если остались одни
      try {
        const roomId = els.roomId?.value || '';
        if (/^call-/.test(roomId)) {
          // Сохраняем предыдущее количество пользователей в appState
          if (typeof appState._prevPresenceCount !== 'number') appState._prevPresenceCount = msg.users.length;
          const prev = appState._prevPresenceCount;
          const nowCount = msg.users.length;
          appState._prevPresenceCount = nowCount;
          // Фиксируем момент стабилизации когда в комнате >=2
          if (nowCount >= 2){ appState._multiPresenceSince = appState._multiPresenceSince || Date.now(); }
          if (nowCount < 2){ /* сбрасывать не будем сразу, пусть хранится для анализа */ }
          // Условия авто-выхода:
          // 1) Раньше было >=2 пользователей
          // 2) Сейчас остались мы одни (<=1)
          // 3) Текущая фаза звонка активная/завершившаяся (исключаем стадии ожидания соединения peer-ов)
          // 4) Ещё не запущен grace таймер
          // 5) Прошло минимум 1.2s с момента когда в комнате впервые стало >=2 (стабилизация)
          const stabilized = appState._multiPresenceSince && (Date.now() - appState._multiPresenceSince > 1200);
          if (prev >= 2 && nowCount <= 1 && stabilized) {
            const phase = (window.getCallState && window.getCallState().phase) || 'idle';
            if (['active','ended','connecting'].includes(phase)){
              if (!appState._callSoloGrace){
                log(`call-room solitary detected (prev=${prev} -> now=${nowCount}), scheduling auto leave`);
                appState._callSoloGrace = setTimeout(()=>{
                  try {
                    // Перепроверка: если за grace время снова кто-то пришёл — отменяем
                    const latestCount = appState._prevPresenceCount;
                    if (latestCount && latestCount > 1){
                      log('solo grace aborted: peer rejoined');
                      appState._callSoloGrace = null;
                      return;
                    }
                    try { window.getCallState && window.getCallState().phase==='active' && window.hangup?.(); } catch {}
                    // Полная очистка состояния звонка, чтобы не оставалось "занято" при повторных попытках
                    try { window.resetCallSystem && window.resetCallSystem(); } catch {}
                    try { if (els.roomId && /^call-/.test(els.roomId.value)) els.roomId.value=''; } catch {}
                    try { appState.currentRoomId = null; } catch {}
                    try { appState._prevPresenceCount = 0; } catch {}
                    leaveRoom();
                  } catch {}
                  appState._callSoloGrace = null;
                }, 800); // grace 0.8s
              }
            }
          }
        }
      } catch {}
    } else if (msg.type === 'user_joined'){ log(`Присоединился: ${msg.userId}`); }
  else if (msg.type === 'user_left'){ log(`Отключился: ${msg.userId}`); const tile=document.querySelector(`.tile[data-peer="${msg.userId}"]`); if (tile) tile.remove(); try { updatePeerLayout(); } catch {} }
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
    try {
      // Если закрылась эфемерная комната звонка — форсируем полный сброс сигналинга
      const rid = els.roomId?.value || '';
      if (/^call-/.test(rid) && window.forceResetCall){ window.forceResetCall(); }
      if (/^call-/.test(rid)){ try { els.roomId.value=''; } catch {} }
      appState.currentRoomId = null;
    } catch {}
    if (!appState.isManuallyDisconnected && !appState.isReconnecting){ appState.isReconnecting = true; log('Попытка переподключения через 3с...'); appState.reconnectTimeout = setTimeout(connectRoom, 3000); }
  };
  appState.ws.onerror = (err)=>{ log(`WS ошибка: ${err?.message||'unknown'}`); try { appState.ws?.close(); } catch {} };
}

// Привязка локальных дополнительных кнопок (камера/экран стоп и PiP)
document.addEventListener('click', (e)=>{
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.id === 'btnStopCam'){
    try { appState.rtc?.stopCamera(); } catch {}
  } else if (t.id === 'btnStopScreen'){
    try { appState.rtc?.stopScreenShare(); } catch {}
  } else if (t.id === 'btnCompositeToggle'){
    try {
      const canvas = document.getElementById('localCompositeCanvas');
      appState.rtc?.toggleComposite(canvas);
      t.classList.toggle('btn-media-active');
    } catch {}
  }
});

// Обновление локального PiP (камера поверх экрана) при изменении треков
const _origOnVideoState = appState.rtc?.onVideoState;
// Уже встроено в onVideoState логика UI; PiP в локальном контейнере управляется в webrtc.js через _updateLocalPreview.

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
  try { updatePeerLayout(); } catch {}
  // Кнопка развёртывания для single-peer режима (создаём заранее, прячем если не нужно)
  let expandBtn = document.createElement('button');
  expandBtn.type='button';
  expandBtn.className='btn btn-fullscreen btn-expand-peer';
  expandBtn.textContent='↕';
  expandBtn.style.position='absolute';
  expandBtn.style.top='8px';
  expandBtn.style.right='8px';
  expandBtn.style.zIndex='7';
  expandBtn.style.opacity='0';
  expandBtn.style.transition='opacity .25s ease';
  expandBtn.addEventListener('click', ()=>{
    tile.classList.toggle('single-peer-expanded');
  });
  tile.appendChild(expandBtn);
  tile.addEventListener('mouseenter', ()=>{ if (tile.classList.contains('single-peer')) expandBtn.style.opacity='1'; });
  tile.addEventListener('mouseleave', ()=>{ expandBtn.style.opacity='0'; });
  const mainVideo = tile.querySelector('video.peer-main');
  const pipWrap = tile.querySelector('.pip');
  const pipVideo = tile.querySelector('video.peer-pip');
  const audio = tile.querySelector('audio');
  const name = tile.querySelector('.name');
  const vol = tile.querySelector('input[type="range"][name="volume"]');
  const level = tile.querySelector('.level-bar');
  name.textContent = appState.latestUserNames[peerId] || `user-${peerId.slice(0,6)}`;
  if (mainVideo){ mainVideo.playsInline=true; mainVideo.autoplay=true; mainVideo.muted=true; }
  if (pipVideo){ pipVideo.playsInline=true; pipVideo.autoplay=true; pipVideo.muted=true; }
  if (audio){ audio.autoplay=true; }

  // Локальное хранилище последнего распределения треков
  const assignTracks = (stream)=>{
    try {
      let vids = stream.getVideoTracks();
      // Фильтруем завершённые/неактивные треки
      const live = vids.filter(v => v.readyState === 'live');
      if (live.length !== vids.length){
        log(`[diag] peer ${peerId.slice(0,6)} filtered dead tracks old=${vids.length} live=${live.length}`);
      }
      vids = live;
      log(`[diag] peer ${peerId.slice(0,6)} assignTracks vids=${vids.length} ids=[${vids.map(v=>v.id+':'+(v.label||'')).join(',')}]`);

      if (!vids.length){
        if (mainVideo){ mainVideo.srcObject=null; mainVideo.load?.(); }
        if (pipWrap){ pipWrap.style.display='none'; if (pipVideo){ pipVideo.srcObject=null; pipVideo.load?.(); } }
        return;
      }

      // Подписка на onended для автоматического пересчёта (один раз на трек)
      vids.forEach(t=>{
        if (!t._wcAssignBound){
          t._wcAssignBound = true;
            t.addEventListener('ended', ()=>{
              log(`[diag] track ended ${t.id}, reassign peer ${peerId.slice(0,6)}`);
              setTimeout(()=> assignTracks(stream), 30);
            }, { once:false });
        }
      });

      if (vids.length === 1){
        const ms = new MediaStream([vids[0]]);
        if (mainVideo && mainVideo.srcObject !== ms) mainVideo.srcObject = ms;
        if (pipWrap){ pipWrap.style.display='none'; if (pipVideo && pipVideo.srcObject){ pipVideo.srcObject=null; pipVideo.load?.(); } }
        return;
      }

      // Эвристика выбора экрана и камеры
      let screen = vids.find(v => /screen|display|window|share/i.test(v.label));
      let camera = vids.find(v => v !== screen);

      // Если эвристика по label не сработала: попробуем по настройкам (широкий трек считаем экраном)
      if (!screen && vids.length >= 2){
        try {
          const withRatio = vids.map(v=>{ const st=v.getSettings?.()||{}; return { v, ratio: (st.width||0) >= (st.height||0) ? (st.width||1)/(st.height||1) : 0 }; });
          // Экран обычно имеет высокий ratio (>=1.5)
          const candidate = withRatio.filter(o=> o.ratio >= 1.5).sort((a,b)=> b.ratio - a.ratio)[0];
          if (candidate){ screen = candidate.v; camera = vids.find(v=> v!==screen); }
        } catch {}
      }

      // Если всё ещё нет screen – просто берём первые два и считаем первый основным
      if (!screen){ screen = vids[0]; camera = vids.find(v=> v!==screen) || vids[0]; }

      // Если screen трек вдруг ended (мог закончиться между фильтрацией и выбором) – промоутим камеру в main
      if (screen.readyState !== 'live' && camera && camera.readyState === 'live'){
        screen = camera;
      }

      log(`[diag] peer ${peerId.slice(0,6)} screen=${screen && screen.id} camera=${camera && camera.id}`);
      const msScreen = new MediaStream([screen]);
      const msCam = camera && camera !== screen ? new MediaStream([camera]) : null;
      if (mainVideo && mainVideo.srcObject !== msScreen) mainVideo.srcObject = msScreen;
      if (pipVideo && msCam){ pipVideo.srcObject = msCam; }
      if (pipWrap) pipWrap.style.display = msCam ? '' : 'none';

      // Пост-эвристика: если вставили предполагаемый экран, но фактически кадры не идут → через 500мс свап
      try {
        if (mainVideo){
          setTimeout(()=>{
            try {
              if (!tile.isConnected) return; // уже удалён
              if (mainVideo.videoWidth === 0 && pipVideo && pipVideo.srcObject){
                log(`[diag] main video no frames, swapping with pip for ${peerId.slice(0,6)}`);
                const mvStream = mainVideo.srcObject; const pvStream = pipVideo.srcObject;
                if (pvStream){ mainVideo.srcObject = pvStream; }
                if (mvStream && msCam){ pipVideo.srcObject = mvStream; }
              }
            } catch {}
          }, 500);
        }
      } catch {}
    } catch(e){ log(`assignTracks(${peerId.slice(0,6)}): ${e}`); }
  };

  appState.rtc.bindPeerMedia(peerId, {
    onTrack: (stream) => {
      log(`Получен медиа-поток от ${peerId.slice(0,6)}`); stopSpecialRingtone(); assignTracks(stream);
      try { updatePeerLayout(); } catch {}
      if (audio){
        audio.srcObject=stream; try{ audio._peerStream=stream; }catch{}; audio.muted=false;
        audio.volume = vol ? (Math.min(100, Math.max(0, Number(vol.value)||100))/100) : 1.0;
        audio.play().catch(()=>{ unlockAudioPlayback(); setTimeout(()=> audio.play().catch(()=>{}), 250); });
      }
    },
    onLevel: (value)=>{ level.style.transform = `scaleX(${value})`; },
    onSinkChange: (deviceId)=>{ if (audio && audio.setSinkId){ audio.setSinkId(deviceId).catch(e=>log(`sinkAudio(${peerId.slice(0,6)}): ${e.name}`)); } }
  });
  if (vol && audio){ vol.addEventListener('input', ()=>{ const v = Math.min(100, Math.max(0, Number(vol.value)||0)); audio.volume = v/100; }); }
}

// Адаптация лэйаута: если один удалённый участник и нет screen share — делаем плитку широкой
function updatePeerLayout(){
  try {
    const tiles = Array.from(document.querySelectorAll('#peersGrid .tile'));
    const grid = document.getElementById('peersGrid');
    if (!grid) return;
    // Сбрасываем классы
    tiles.forEach(t=> t.classList.remove('single-peer')); grid.classList.remove('layout-single-peer');
    if (tiles.length === 1){
      const t = tiles[0];
      t.classList.add('single-peer');
      grid.classList.add('layout-single-peer');
      // Показать кнопку expand если есть
      const btn = t.querySelector('.btn-expand-peer');
      if (btn){ btn.style.display=''; }
    } else {
      // Скрыть expand кнопки
      tiles.forEach(t=>{ const btn=t.querySelector('.btn-expand-peer'); if (btn){ btn.style.display='none'; } t.classList.remove('single-peer-expanded'); });
    }
  } catch {}
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
  // Принудительный сброс внутреннего signaling состояния для call-* комнат
  try {
    if (els.roomId && /^call-/.test(els.roomId.value)){
      if (window.forceResetCall) window.forceResetCall();
    }
  } catch {}
  try { appState.ws?.send(JSON.stringify({ type:'leave', fromUserId: appState.userId })); } catch {}
  if (appState.ws) appState.ws.close(); if (appState.rtc) { appState.rtc.close(); appState.rtc=null; }
  try { // Безопасно гасим локальное видео/шаринг (если остались треки)
    if (appState.rtc?.stopVideo) appState.rtc.stopVideo();
  } catch {}
  setConnectedState(false);
  try { els.peersGrid.querySelectorAll('.tile').forEach(t=> safeReleaseMedia(t)); } catch {}
  els.peersGrid.innerHTML=''; log('Отключено'); if (appState.peerCleanupIntervalId){ clearInterval(appState.peerCleanupIntervalId); appState.peerCleanupIntervalId=null; }
  if (getActiveCall()) resetActiveCall('leave');
  try { loadVisitedRooms(); } catch {}
}

// ===== Friends WS =====
function startFriendsWs(){
  log('🔧 startFriendsWs вызвана');
  
  // Предотвращаем множественные одновременные подключения
  if (appState.friendsWs && appState.friendsWs.readyState === WebSocket.OPEN) {
    log('Friends WS: уже подключен и активен');
    return; 
  }
  
  if (appState.friendsWsConnecting) {
    log('Friends WS: подключение уже в процессе');
    return;
  }
  
  const t = localStorage.getItem('wc_token'); 
  if (!t) {
    log('❌ Friends WS: токен не найден, пропуск подключения');
    appState.friendsWsConnecting = false;
    return;
  }
  
  log('✅ Friends WS: токен найден, продолжаем подключение');
  
  // Закрываем старое соединение если оно есть
  if (appState.friendsWs) {
    log('Friends WS: закрываем старое соединение');
    try {
      appState.friendsWs.onclose = null; // Убираем обработчик чтобы не вызвать переподключение
      appState.friendsWs.close();
    } catch (e) {
      log('Ошибка при закрытии старого WS:', e);
    }
    appState.friendsWs = null;
  }
  
  appState.friendsWsConnecting = true;
  const connectStartTime = Date.now();
  
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = new URL(`${proto}://${location.host}/ws/friends`); url.searchParams.set('token', t);
  log(`🔗 Friends WS: подключение к ${url.toString()}`);
  
  try {
    log('🔧 Создание WebSocket объекта...');
    appState.friendsWs = new WebSocket(url.toString());
    log('✅ WebSocket объект создан успешно');
    
    // Таймаут для подключения - если за 10 секунд не подключились, сбрасываем флаг
    const connectTimeout = setTimeout(() => {
      if (appState.friendsWsConnecting) {
        log('Friends WS: таймаут подключения, сбрасываем флаг connecting');
        appState.friendsWsConnecting = false;
        if (appState.friendsWs && appState.friendsWs.readyState === WebSocket.CONNECTING) {
          try { appState.friendsWs.close(); } catch {}
        }
      }
    }, 10000);
    
    appState.friendsWs.onopen = ()=>{ 
      const connectTime = Date.now() - connectStartTime;
      log(`✅ WS друзей открыт за ${connectTime}ms`); 
      clearTimeout(connectTimeout);
      // Сбрасываем счетчик попыток и флаг подключения при успешном подключении
      appState.wsReconnectAttempts = 0;
      appState.friendsWsConnecting = false;
      
      try { 
        appState.friendsWs.send(JSON.stringify({ type:'ping' })); 
        log('📤 Friends WS: ping отправлен');
      } catch (e) {
        log('❌ Friends WS: ошибка отправки ping:', e);
      }
    };
  appState.friendsWs.onmessage = async (ev)=>{
    try { 
      const msg = JSON.parse(ev.data); 
      if (!msg || typeof msg !== 'object') return; 
      // Глобальный сырой лог входящих сообщений друзей
      try {
        if (!window.__WS_RAW_MESSAGES) window.__WS_RAW_MESSAGES = [];
        window.__WS_RAW_MESSAGES.push({ ts: Date.now(), msg });
        if (window.__WS_RAW_MESSAGES.length > 500) window.__WS_RAW_MESSAGES.splice(0, window.__WS_RAW_MESSAGES.length-500);
      } catch {}
      
      // Подсчитываем сообщения
      if (!window.__FRIENDS_WS_STATS) window.__FRIENDS_WS_STATS = { total: 0, byType: {} };
      window.__FRIENDS_WS_STATS.total++;
      window.__FRIENDS_WS_STATS.byType[msg.type] = (window.__FRIENDS_WS_STATS.byType[msg.type] || 0) + 1;
      
      // Обновляем счётчик сообщений в appState для панели дебага
      appState.friendsWsMessageCount = window.__FRIENDS_WS_STATS.total;
      appState.lastFriendsMessage = msg;
      
      // Отправляем в панель дебага
      if (window.debugPanel) {
        window.debugPanel.logFriendsMessage(msg.type, msg, 'incoming');
      }
      
      // Логируем все входящие сообщения
      log(`📥 Friends WS message: ${msg.type} (всего: ${window.__FRIENDS_WS_STATS.total})`);
      
      switch(msg.type){
        case 'presence_snapshot':
          try { setOnlineSnapshot(msg.userIds || []); refreshFriendStatuses(); } catch{}
          break;
        case 'presence_join':
          try { addOnlineUser(msg.userId); refreshFriendStatuses(); } catch{}
          break;
        case 'presence_leave':
          try { removeOnlineUser(msg.userId); refreshFriendStatuses(); } catch{}
          break;
        case 'friend_request': case 'friend_accepted': case 'friend_cancelled': scheduleFriendsReload(); break;
        case 'friend_removed': scheduleFriendsReload(); break;
  case 'direct_message': handleIncomingDirect(msg); try { const acc=getAccountId(); const other= msg.fromUserId === acc ? msg.toUserId : msg.fromUserId; markFriendSeen(other); const isActiveChat = appState.currentDirectFriend && other === appState.currentDirectFriend; const iAmRecipient = msg.toUserId === acc; if (iAmRecipient && !isActiveChat && 'Notification' in window && Notification.permission==='granted'){ const title = 'Новое сообщение'; const body = msg.fromUsername ? `От ${msg.fromUsername}` : 'Личное сообщение'; const reg = await navigator.serviceWorker.getRegistration('/static/sw.js'); if (reg && reg.showNotification){ reg.showNotification(title, { body, data:{ type:'direct', from: other } }); } else { new Notification(title, { body, data:{ type:'direct', from: other } }); } } } catch {} break;
        case 'direct_cleared': handleDirectCleared(msg); break;
        case 'call_invite':
        case 'call_accept':
        case 'call_decline':
        case 'call_cancel':
        case 'call_end': {
          log(`📞 Call signal: ${msg.type} from ${msg.fromUserId} to ${msg.toUserId}`);
          try { const acc=getAccountId(); const other = msg.fromUserId === acc ? msg.toUserId : msg.fromUserId; markFriendSeen(other); } catch {}
          try { handleCallSignal(msg); } catch (e) { log(`❌ Error handling call signal: ${e.message}`); }
          break;
        }
        default: 
          log(`❓ Unknown message type: ${msg.type}`);
          break;
      } 
    } catch (e) {
      log(`❌ Error parsing Friends WS message: ${e.message}`);
    }
  };
    appState.friendsWs.onclose = (event)=>{ 
      log(`Friends WS закрыт: код=${event.code}, причина=${event.reason}`);
      appState.friendsWs = null; 
      appState.friendsWsConnecting = false;
      
      // Не переподключаемся если:
      // - страница выгружается (beforeunload/unload)
      // - код закрытия 1000 (нормальное закрытие) или 1001 (going away)
      // - нет токена авторизации
      // - слишком много попыток переподключения
      const maxReconnectAttempts = 10;
      if (document.visibilityState === 'hidden' || 
          event.code === 1000 || 
          event.code === 1001 ||
          !localStorage.getItem('wc_token') ||
          (appState.wsReconnectAttempts || 0) >= maxReconnectAttempts) {
        log('Friends WS: не переподключаемся, причина:', { 
          visibilityState: document.visibilityState, 
          code: event.code,
          hasToken: !!localStorage.getItem('wc_token'),
          attempts: appState.wsReconnectAttempts || 0,
          maxAttempts: maxReconnectAttempts
        });
        return;
      }
      
      // Увеличиваем интервал переподключения для предотвращения спама
      const reconnectDelay = Math.min(30000, 5000 * (appState.wsReconnectAttempts || 1));
      appState.wsReconnectAttempts = (appState.wsReconnectAttempts || 0) + 1;
      
      log(`Friends WS: переподключение через ${reconnectDelay}ms (попытка ${appState.wsReconnectAttempts}/${maxReconnectAttempts})`);
      setTimeout(()=>{ 
        if (!appState.friendsWs && !appState.friendsWsConnecting && localStorage.getItem('wc_token')) {
          try { startFriendsWs(); } catch {} 
        }
      }, reconnectDelay); 
    };
    appState.friendsWs.onerror = (error)=>{ 
      log('Friends WS ошибка:', error);
      clearTimeout(connectTimeout);
      appState.friendsWsConnecting = false;
      // Закрываем соединение при ошибке
      try { 
        if (appState.friendsWs) {
          appState.friendsWs.close(); 
        } 
      } catch {}; 
    };
  } catch (error) {
    log('Friends WS: ошибка создания соединения:', error);
    appState.friendsWs = null;
    appState.friendsWsConnecting = false;
    // Не делаем автоматический ретрай при ошибке создания
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
try { window.updateUserBadge = updateUserBadge; } catch {}

// ===== UI Setup =====
function setupUI(){
  els.btnConnect?.addEventListener('click', ()=>{ unlockAudioPlayback(); connectRoom(); });
  els.btnLeave?.addEventListener('click', leaveRoom);
  els.btnCopyLink?.addEventListener('click', ()=>{ const url = new URL(location.href); url.searchParams.set('room', els.roomId.value); navigator.clipboard.writeText(url.toString()); log('Ссылка скопирована'); });
  els.btnSend?.addEventListener('click', ()=>{ const text = els.chatInput.value; if (text && appState.ws){ (signal.sendChat || (()=>{}))(appState.ws, text, getStableConnId()); try { window.__lastChatSendTs = Date.now(); } catch {}; els.chatInput.value=''; } });
  els.chatInput?.addEventListener('keydown', e=>{ if (e.key==='Enter') els.btnSend.click(); });
  els.btnToggleMic?.addEventListener('click', async ()=>{ if (!appState.rtc) return; const enabled = await appState.rtc.toggleMic(); els.btnToggleMic.textContent = enabled ? 'Выкл.микро' : 'Вкл.микро'; });
  els.btnToggleCam?.addEventListener('click', async ()=>{ if (!appState.rtc) return; const on = await appState.rtc.toggleCameraStream(); els.btnToggleCam.textContent = on ? '🎥 Камера выкл' : '🎥 Камера'; });
  els.btnScreenShare?.addEventListener('click', async ()=>{ if (!appState.rtc) return; const sharing = await appState.rtc.toggleScreenShare(); els.btnScreenShare.textContent = sharing ? '🛑 Остановить' : '🖥 Экран'; });
  els.btnDiag?.addEventListener('click', ()=> appState.rtc?.diagnoseAudio());
  els.btnToggleTheme?.addEventListener('click', ()=>{
    // Цикл тем: light -> dark -> red -> light (визуально один кружок меняет цвет)
    const body = document.body;
    let mode = localStorage.getItem('theme') || 'light';
    if (mode === 'light'){
      mode='dark';
      body.classList.add('dark');
      body.classList.remove('theme-red');
    } else if (mode === 'dark'){
      mode='red';
      body.classList.remove('dark');
      body.classList.add('theme-red');
    } else {
      mode='light';
      body.classList.remove('dark','theme-red');
    }
    localStorage.setItem('theme', mode);
    if (els.btnToggleTheme){ els.btnToggleTheme.title = 'Тема: '+mode; }
  });
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
  // Применяем сохранённую тему
  try {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark'){
      document.body.classList.add('dark');
      document.body.classList.remove('theme-red');
    } else if (savedTheme === 'red'){
      document.body.classList.add('theme-red');
      document.body.classList.remove('dark');
    } else {
      document.body.classList.remove('dark','theme-red');
    }
    if (els.btnToggleTheme){ els.btnToggleTheme.title = 'Тема: '+(savedTheme||'light'); }
  } catch {}
  const u = new URL(location.href); if (u.searchParams.has('room')) els.roomId.value = u.searchParams.get('room');
  showPreJoin();

  // Делегирование кликов для кнопок полноэкранного режима (локальное и peer видео)
  try {
    document.addEventListener('click', (e)=>{
      const btn = e.target.closest('button[data-action="fullscreen"], button[data-action="fullscreen-local"]');
      if (!btn) return;
      e.preventDefault();
      let container = null;
      if (btn.dataset.action === 'fullscreen-local') {
        container = document.getElementById('localCard')?.querySelector('.video-wrap') || document.getElementById('localCard');
      } else {
        container = btn.closest('.tile');
      }
      if (!container) return;
      const enter = () => {
        try { container.requestFullscreen?.(); } catch {}
        container.classList.add('fullscreen-active');
      };
      const exitMark = () => { container.classList.remove('fullscreen-active'); };
      if (document.fullscreenElement) {
        if (document.fullscreenElement === container) {
          document.exitFullscreen().catch(()=>{}).then(exitMark);
        } else {
          document.exitFullscreen().catch(()=>{}).then(()=> enter());
        }
      } else {
        enter();
      }
    });
    document.addEventListener('fullscreenchange', ()=>{
      if (!document.fullscreenElement) {
        document.querySelectorAll('.fullscreen-active').forEach(el => el.classList.remove('fullscreen-active'));
      }
    });
  } catch {}

  // Принудительная попытка воспроизведения локального видео (фикс черного экрана при некоторых политиках автоплея)
  try {
    const vid = document.getElementById('localVideo');
    if (vid) {
      vid.addEventListener('loadedmetadata', ()=>{ vid.play().catch(()=>{}); });
      setTimeout(()=>{ if (vid.paused) vid.play().catch(()=>{}); }, 800);
    }
  } catch {}

  // === Горячие клавиши медиа ===
  try {
    document.addEventListener('keydown', (e)=>{
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target && e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      switch(e.key){
        case 'm': // toggle mic
          if (appState.rtc){ appState.rtc.toggleMic(); showToast && showToast('Микрофон: toggle', 'info'); }
          break;
        case 'c': // toggle camera
          if (appState.rtc){ appState.rtc.toggleCameraStream(); showToast && showToast('Камера: toggle', 'info'); }
          break;
        case 's': // toggle screen
          if (appState.rtc){ appState.rtc.toggleScreenShare(); showToast && showToast('Экран: toggle', 'info'); }
          break;
        case 'x': // stop screen explicitly
          if (appState.rtc && appState.rtc._screenTrack){ appState.rtc.stopScreenShare(); showToast && showToast('Экран: стоп', 'info'); }
          break;
        case 'k': // stop camera explicitly
          if (appState.rtc && appState.rtc._cameraTrack){ appState.rtc.stopCamera(); showToast && showToast('Камера: стоп', 'info'); }
          break;
        case 'M': // Shift+M → composite toggle (регистр различается)
          if (appState.rtc){
            const canvas = document.getElementById('localCompositeCanvas');
            appState.rtc.toggleComposite(canvas);
            showToast && showToast('Composite: toggle', 'info');
            const btn = document.getElementById('btnCompositeToggle'); if (btn){ btn.classList.toggle('btn-media-active', appState.rtc._compositeEnabled); }
          }
          break;
        default: return;
      }
    });
  } catch {}

  // === Панель настроек отображения ===
  try {
    // Вставляем кнопку-шестерёнку рядом с кнопкой выхода
    if (els.btnLogout && !document.getElementById('btnUiSettings')){
      const gearBtn = document.createElement('button');
      gearBtn.id='btnUiSettings';
      gearBtn.title='Настройки отображения';
      gearBtn.textContent='⚙';
      gearBtn.style.marginLeft='6px';
      gearBtn.className='btn btn-sm btn-secondary';
      els.btnLogout.parentElement?.insertBefore(gearBtn, els.btnLogout);
      const panel = document.createElement('div');
      panel.id='uiSettingsPanel';
      panel.style.position='fixed';
      panel.style.top='50px';
      panel.style.right='20px';
      panel.style.background='#202124';
      panel.style.color='#fff';
      panel.style.padding='14px 16px';
      panel.style.borderRadius='10px';
      panel.style.boxShadow='0 8px 24px rgba(0,0,0,.35)';
      panel.style.display='none';
      panel.style.zIndex='2000';
      panel.style.minWidth='220px';
  panel.innerHTML = '<div style="font-weight:600;margin-bottom:8px">Отображение</div>';
  const container = document.createElement('div');
  container.style.display='flex';
  container.style.flexWrap='wrap';
  container.style.gap='6px';
      const groups = [
        { id:'logs', label:'Логи' },
        { id:'stats', label:'Статистика' },
        { id:'chat', label:'Чат' },
        { id:'friendsCard', label:'Друзья' },
        { id:'visitedCard', label:'Недавние' },
        { id:'statusCard', label:'Статус' },
        { id:'directChatCard', label:'Личные сообщения' },
      ];
      const prefsKey = 'wc_ui_panels_v1';
      const loadPrefs = ()=>{ try { return JSON.parse(localStorage.getItem(prefsKey)||'{}'); } catch { return {}; } };
      const savePrefs = (p)=>{ try { localStorage.setItem(prefsKey, JSON.stringify(p)); } catch {} };
      const apply = (prefs)=>{
        groups.forEach(g=>{
          // Базовый элемент (например logs, stats, chat)
            const base = els[g.id] || document.getElementById(g.id);
            // Альтернативный элемент c суффиксом Card (например logsCard)
            const alt = document.getElementById(g.id + 'Card');
            // Если базовый элемент вложен в card/panel – найдём ближайшего родителя
            const containers = [];
            if (base) containers.push(base);
            if (alt && alt !== base) containers.push(alt);
            // Собираем потенциальные обёртки
            const wrappers = new Set();
            for (const node of containers){
              if (!node) continue;
              // Ищем ближайшего родителя с классом card или panel
              let p = node;
              while (p && p !== document.body){
                if (p.classList && (p.classList.contains('card') || p.classList.contains('panel'))){ wrappers.add(p); break; }
                p = p.parentElement;
              }
            }
            const shouldShow = prefs[g.id] !== false;
            // Применяем display для всех собранных элементов
            [...wrappers, ...containers].forEach(el=>{ if (el) el.style.display = shouldShow ? '' : 'none'; });
        });
      };
      let prefs = loadPrefs();
      // Если первый запуск (нет ключей) — скрываем логи и статус по умолчанию
      if (!prefs || Object.keys(prefs).length === 0){
        prefs = { logs:false, statusCard:false };
        savePrefs(prefs);
      }
      groups.forEach(g=>{
        const wrap = document.createElement('label');
        wrap.style.display='inline-flex';
        wrap.style.alignItems='center';
        wrap.style.border='1px solid #404449';
        wrap.style.borderRadius='18px';
        wrap.style.padding='4px 10px 4px 8px';
        wrap.style.fontSize='12px';
        wrap.style.background='#2a2d31';
        wrap.style.cursor='pointer';
        const cb = document.createElement('input'); cb.type='checkbox'; cb.checked = prefs[g.id] !== false; cb.style.marginRight='6px'; cb.style.accentColor='#4fa3ff';
        cb.addEventListener('change', ()=>{ const p=loadPrefs(); p[g.id] = cb.checked; savePrefs(p); apply(p); });
        wrap.appendChild(cb); wrap.appendChild(document.createTextNode(g.label)); container.appendChild(wrap);
      });
  panel.appendChild(container);
  // Кнопка перехода в профиль
  const profBtn = document.createElement('button');
  profBtn.type='button';
  profBtn.textContent='Изменить данные';
  profBtn.style.marginTop='10px';
  profBtn.style.width='100%';
  profBtn.style.background='#1fa060';
  profBtn.style.color='#fff';
  profBtn.style.border='none';
  profBtn.style.padding='8px 10px';
  profBtn.style.borderRadius='6px';
  profBtn.style.cursor='pointer';
  profBtn.addEventListener('click', (e)=>{ e.stopPropagation(); location.href='/static/profile.html'; });
  panel.appendChild(profBtn);
      document.body.appendChild(panel);
      gearBtn.addEventListener('click', ()=>{ panel.style.display = panel.style.display==='none' ? 'block' : 'none'; });
      document.addEventListener('click', (e)=>{ if (!panel.contains(e.target) && e.target!==gearBtn){ if (panel.style.display==='block') panel.style.display='none'; } }, { capture:true });
      apply(prefs);
    }
  } catch {}
}

// ===== Public init =====
export async function appInit(){
  log('🚀 Начало инициализации приложения');
  setConnectedState(false);
  setupUI();
  refreshDevices();
  log('✅ Приложение инициализировано');

  // Инициализация модуля звонков (хуки для подключения комнаты и аудио)
  try { initCallModule({ reloadFriends: loadFriends, unlockAudioPlayback, connectRoom }); } catch {}
  try {
    initCallSignaling({
      getAccountId,
      unlockAudio: unlockAudioPlayback,
      navigateToRoom: (roomId)=>{
        try {
          if (!roomId) return;
          // Если мы НЕ на странице /call – делаем переход с параметром
          if (!location.pathname.startsWith('/call')){
            const url = new URL(location.origin + '/call');
            url.searchParams.set('room', roomId);
            log(`navigateToRoom: redirect to ${url.toString()}`);
            location.href = url.toString();
            return;
          }
          // Уже на /call: выставляем значение в input при необходимости
            if (els.roomId && els.roomId.value !== roomId){
              els.roomId.value = roomId;
              log(`navigateToRoom: roomId input set to ${roomId}`);
            }
          // Если уже есть WS и это тот же room – ничего не делаем
          if (appState.ws){
            if (appState.currentRoomId && appState.currentRoomId === roomId){
              log('navigateToRoom: already connected to this room');
              return;
            }
            // Иначе попытка переподключиться: аккуратно закрываем и откроем заново
            try { log('navigateToRoom: switching room, closing existing ws'); appState.ws.close(); } catch {}
            appState.ws = null;
          }
          // Подключаемся
          try { appState.currentRoomId = roomId; } catch {}
          connectRoom();
          // Fallback: если через 1.2с не подключены к нужной комнате – повторяем попытку
          setTimeout(()=>{
            try {
              const need = roomId;
              const have = appState.currentRoomId;
              if (need === roomId && (!appState.ws || appState.ws.readyState !== WebSocket.OPEN)){
                log('navigateToRoom fallback retry connectRoom');
                if (!appState.ws) connectRoom();
              }
            } catch {}
          }, 1200);
        } catch(e){ log('navigateToRoom error: '+ (e?.message||e)); }
      }
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
    window.appState = appState; // Для диагностики
    
    // Добавляем функцию диагностики WebSocket (для отладки)
    window.debugWebSocket = () => {
      const ws = window.appState?.friendsWs;
      const connecting = window.appState?.friendsWsConnecting;
      const token = localStorage.getItem('wc_token');
      const states = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
      const info = {
        hasToken: !!token,
        hasWebSocket: !!ws,
        wsState: ws ? states[ws.readyState] || ws.readyState : 'не создан',
        connecting: connecting,
        url: ws ? ws.url : 'нет',
        reconnectAttempts: window.appState?.wsReconnectAttempts || 0,
        visibilityState: document.visibilityState
      };
      console.log('🔍 WebSocket диагностика:', info);
      showToast(`WS: ${info.wsState}${info.connecting ? ' (подключается)' : ''}, Token: ${info.hasToken ? 'есть' : 'нет'}, Попыток: ${info.reconnectAttempts}`, 'info');
      
      // Показываем состояние звонков если доступно
      try {
        if (window.getCallState) {
          const callState = window.getCallState();
          console.log('📞 Состояние звонков:', callState);
        }
      } catch {}
      
      return info;
    };
    
    // Функция полной диагностики
    window.debugCalls = () => {
      const wsInfo = window.debugWebSocket();
      
      console.log('🔧 Системная информация:', {
        userAgent: navigator.userAgent,
        online: navigator.onLine,
        connectionType: navigator?.connection?.effectiveType || 'unknown'
      });
      
      console.log('📡 Доступность API звонков:', {
        notifyCall: typeof window.notifyCall !== 'undefined',
        startOutgoingCall: typeof window.startOutgoingCall !== 'undefined',
        getCallState: typeof window.getCallState !== 'undefined'
      });
      
      return wsInfo;
    };
    
    // Функция для принудительного переподключения
    window.forceReconnectWebSocket = () => {
      console.log('🔄 Принудительное переподключение WebSocket...');
      if (window.appState?.friendsWs) {
        window.appState.friendsWs.onclose = null;
        window.appState.friendsWs.close();
      }
      window.appState.friendsWs = null;
      window.appState.friendsWsConnecting = false;
      window.appState.wsReconnectAttempts = 0;
      startFriendsWs();
      showToast('Принудительное переподключение WebSocket', 'info');
    };
    
    // Функция для тестирования Friends WebSocket
    window.testFriendsWS = () => {
      const ws = window.appState?.friendsWs;
      if (!ws) {
        console.log('❌ Friends WebSocket не создан');
        return false;
      }
      
      const states = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
      const state = states[ws.readyState] || 'UNKNOWN';
      console.log(`🔍 Friends WebSocket состояние: ${state} (${ws.readyState})`);
      
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'test_message', timestamp: Date.now() }));
          console.log('📤 Тестовое сообщение отправлено');
          return true;
        } catch (e) {
          console.log(`❌ Ошибка отправки: ${e.message}`);
          return false;
        }
      } else {
        console.log('⚠️ WebSocket не в состоянии OPEN');
        return false;
      }
    };
    
    // Функция для получения статистики Friends WebSocket
    window.getFriendsWSStats = () => {
      const ws = window.appState?.friendsWs;
      const stats = window.__FRIENDS_WS_STATS || { total: 0, byType: {} };
      
      return {
        websocket: {
          exists: !!ws,
          state: ws ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][ws.readyState] : 'NOT_CREATED',
          url: ws?.url || null,
          connecting: window.appState?.friendsWsConnecting || false,
          reconnectAttempts: window.appState?.wsReconnectAttempts || 0
        },
        messages: stats,
        token: !!localStorage.getItem('wc_token')
      };
    };
  } catch {}
  
  // Предотвращаем переподключения при закрытии страницы
  window.addEventListener('beforeunload', () => {
    if (appState.friendsWs) {
      appState.friendsWs.onclose = null; // Отключаем автопереподключение
      appState.friendsWs.close(1000, 'Page unload');
    }
  });
  
  log('🔗 Инициализация WebSocket друзей...');
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
