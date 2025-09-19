// calls_signaling.js — новая упрощённая система сигналинга звонков
// Изолирует состояние и переходы. Не зависит от старого calls.js.

import { notifyCall, acceptCall, declineCall, cancelCall } from '../api.js';
import { updateCallUI, bindActions, clearCallUI } from './call_ui.js';
import { startIncomingRing, startOutgoingRing, stopAllRings, resumeAudio } from './call_audio.js';

// === Диагностическое логирование ===
const LOG_PREFIX = '[call-signal]';
function dbg(...a){ try { console.debug(LOG_PREFIX, ...a); } catch {} }

/** @typedef {'idle'|'incoming_invite'|'outgoing_invite'|'active'|'ended'} CallPhase */

/** @typedef {Object} CallState
 *  @property {CallPhase} phase
 *  @property {string=} roomId
 *  @property {string=} otherUserId
 *  @property {string=} otherUsername
 *  @property {string=} finalReason
 */

/** @type {CallState} */
let state = { phase: 'idle' };
let lastStateChangeTs = Date.now();

const listeners = new Set();

function emit(){
  for (const fn of listeners) { try { fn(state); } catch {} }
  updateCallUI(state);
}

function setState(patch){
  const prev = state;
  state = { ...state, ...patch };
  lastStateChangeTs = Date.now();
  dbg('state change', { from: prev.phase, to: state.phase, roomId: state.roomId });
  
  // Отправляем изменение состояния в панель дебага
  if (window.debugPanel) {
    window.debugPanel.logCallEvent(
      'STATE_CHANGE', 
      { 
        from: prev.phase, 
        to: state.phase, 
        roomId: state.roomId,
        otherUserId: state.otherUserId,
        otherUsername: state.otherUsername
      }
    );
  }
  
  // Обновляем глобальное состояние для панели дебага
  if (window.appState) {
    window.appState.callPhase = state.phase;
    window.appState.callType = state.phase === 'incoming_invite' ? 'incoming' : 
                               state.phase === 'outgoing_invite' ? 'outgoing' : '';
    window.appState.callFriendId = state.otherUserId || '';
    window.appState.callRoomId = state.roomId || '';
  }
  try {
    if (state.phase==='incoming_invite' && prev.phase!=='incoming_invite'){ resumeAudio(); startIncomingRing(); }
    if (state.phase==='outgoing_invite' && prev.phase!=='outgoing_invite'){ resumeAudio(); startOutgoingRing(); }
    if (prev.phase==='incoming_invite' && state.phase!=='incoming_invite'){ stopAllRings(); }
    if (prev.phase==='outgoing_invite' && state.phase!=='outgoing_invite'){ stopAllRings(); }
    if (state.phase==='active' || state.phase==='ended'){ stopAllRings(); }
  } catch {}
  
  // Синхронизируем с legacy calls.js для совместимости UI
  try {
    syncWithLegacyCalls(state, prev);
  } catch (e) {
    dbg('legacy sync error', e);
  }
  
  emit();
}
export function getCallState(){ return state; }
export function onCallState(fn){ listeners.add(fn); return ()=> listeners.delete(fn); }

// Синхронизация с legacy calls.js для совместимости UI
async function syncWithLegacyCalls(currentState, prevState) {
  if (typeof window === 'undefined' || !window.appState) return;
  
  try {
    const { setActiveOutgoingCall, setActiveIncomingCall, markCallAccepted, markCallDeclined, resetActiveCall } = await import('./calls.js');
    
    if (currentState.phase === 'outgoing_invite' && prevState.phase !== 'outgoing_invite' && currentState.otherUserId && currentState.roomId) {
      setActiveOutgoingCall(
        { user_id: currentState.otherUserId, username: currentState.otherUsername }, 
        currentState.roomId
      );
    } else if (currentState.phase === 'incoming_invite' && prevState.phase !== 'incoming_invite' && currentState.otherUserId && currentState.roomId) {
      setActiveIncomingCall(currentState.otherUserId, currentState.otherUsername, currentState.roomId);
    } else if (currentState.phase === 'active' && prevState.phase !== 'active' && currentState.roomId) {
      markCallAccepted(currentState.roomId);
    } else if (currentState.phase === 'ended' && prevState.phase !== 'ended' && currentState.roomId) {
      markCallDeclined(currentState.roomId);
    } else if (currentState.phase === 'idle' && prevState.phase !== 'idle') {
      resetActiveCall('idle');
    }
  } catch (e) {
    // Игнорируем ошибки import для совместимости
  }
}

let deps = {
  getAccountId: ()=> null,
  connectRoom: ()=>{},
  unlockAudio: ()=>{},
  navigateToRoom: (roomId)=>{ try { window.location.href = `/call/${roomId}`; } catch {} },
};

export function initCallSignaling(options){
  deps = { ...deps, ...(options||{}) };
  try { window.__NEW_CALL_SIGNALING__ = true; } catch {}
  bindActions(
    ()=>{ if (state.phase==='incoming_invite') internalAccept(); },
    ()=>{ if (state.phase==='incoming_invite') internalDecline(); },
    ()=>{ if (state.phase==='outgoing_invite') internalCancel(); }
  );
  dbg('initialized signaling');
}

function internalAccept(){
  if (state.phase !== 'incoming_invite') return;
  const roomId = state.roomId; const other = state.otherUserId;
  setState({ phase:'active' });
  if (roomId && other){ acceptCall(other, roomId).catch(()=>{}); }
  try { deps.unlockAudio(); resumeAudio(); } catch {}
  if (roomId) deps.navigateToRoom(roomId);
}

function internalDecline(){
  if (!['incoming_invite','outgoing_invite'].includes(state.phase)) return;
  const roomId = state.roomId; const other = state.otherUserId;
  setState({ phase:'ended', finalReason:'declined' });
  if (roomId && other){ declineCall(other, roomId).catch(()=>{}); }
  setTimeout(()=>{ if (state.phase==='ended') setState({ phase:'idle' }); }, 2000);
}

function internalCancel(){
  if (state.phase !== 'outgoing_invite') return;
  const roomId = state.roomId; const other = state.otherUserId;
  setState({ phase:'ended', finalReason:'cancel' });
  if (roomId && other){ cancelCall(other, roomId).catch(()=>{}); }
  setTimeout(()=>{ if (state.phase==='ended') setState({ phase:'idle' }); }, 1200);
}

export function startOutgoingCall(friend){
  if (state.phase !== 'idle') return false;
  
  // Проверяем готовность friends WebSocket
  try {
    const ws = window?.appState?.friendsWs;
    const wsConnecting = window?.appState?.friendsWsConnecting;
    const wsState = ws ? ws.readyState : 'not_exists';
    const token = localStorage.getItem('wc_token');
    
    dbg('WS check:', { exists: !!ws, state: wsState, connecting: wsConnecting, hasToken: !!token });
    
    if (!token) {
      try {
        if (typeof window !== 'undefined' && window.showToast) {
          window.showToast('Необходимо войти в систему для совершения звонков', 'warning');
        } else {
          alert('Необходимо войти в систему');
        }
      } catch {}
      return false;
    }
    
    // Если WebSocket подключается, ждем
    if (wsConnecting) {
      try {
        if (typeof window !== 'undefined' && window.showToast) {
          window.showToast('Подключение устанавливается. Подождите немного...', 'info');
        } else {
          alert('Подключение устанавливается. Подождите...');
        }
      } catch {}
      return false;
    }
    
    if (!ws) {
      // Попытаемся инициировать подключение если WebSocket не создан
      try {
        if (typeof window !== 'undefined' && window.startFriendsWs) {
          window.startFriendsWs();
        }
      } catch {}
      
      try {
        if (typeof window !== 'undefined' && window.showToast) {
          window.showToast('Инициируем подключение. Попробуйте через несколько секунд.', 'info');
        } else {
          alert('Инициируем подключение. Попробуйте позже.');
        }
      } catch {}
      return false;
    }
    
    if (ws.readyState !== WebSocket.OPEN){
      const stateNames = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
      const stateName = stateNames[ws.readyState] || 'UNKNOWN';
      
      dbg('friends WS not ready, state:', stateName);
      try { window.__CALL_DEBUG && window.__CALL_DEBUG.push({ ts:Date.now(), warn:'friends_ws_not_ready', state: stateName }); } catch {}
      
      if (ws.readyState === WebSocket.CONNECTING) {
        try {
          if (typeof window !== 'undefined' && window.showToast) {
            window.showToast('Соединение готовится. Попробуйте через пару секунд.', 'info');
          } else {
            alert('Соединение готовится. Попробуйте позже.');
          }
        } catch {}
      } else if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        // При закрытом соединении пытаемся переподключиться только если не идет уже подключение
        try {
          if (typeof window !== 'undefined' && window.startFriendsWs && !window.appState.friendsWsConnecting) {
            window.appState.friendsWs = null;
            window.startFriendsWs();
            if (typeof window !== 'undefined' && window.showToast) {
              window.showToast('Восстанавливаем соединение. Попробуйте через несколько секунд.', 'info');
            }
          } else {
            if (typeof window !== 'undefined' && window.showToast) {
              window.showToast('Соединение недоступно. Попробуйте позже.', 'warning');
            }
          }
        } catch {}
      } else {
        try {
          if (typeof window !== 'undefined' && window.showToast) {
            window.showToast(`Подключение в состоянии ${stateName}. Попробуйте позже.`, 'warning');
          } else {
            alert('Подключение не готово. Попробуйте позже.');
          }
        } catch {}
      }
      return false;
    }
  } catch (e) {
    dbg('WS check error:', e);
  }
  const rnd = crypto.randomUUID().slice(0,8);
  const tag = (friend.username || friend.user_id || 'user').replace(/[^a-zA-Z0-9]+/g,'').slice(0,6) || 'user';
  const room = `call-${rnd}-${tag}`;
  try { const roomInput = document.getElementById('roomId'); if (roomInput && 'value' in roomInput) roomInput.value = room; } catch {}
  
  // Сохраняем информацию о предполагаемом звонке, но не устанавливаем состояние пока не получим подтверждение от сервера
  dbg('notifyCall ->', friend.user_id, room);
  notifyCall(friend.user_id, room).then(()=> {
    dbg('notifyCall ok');
    // Если состояние всё ещё idle, устанавливаем временное состояние ожидания
    if (state.phase === 'idle') {
      setState({ phase:'outgoing_invite', roomId: room, otherUserId: friend.user_id, otherUsername: friend.username });
    }
  }).catch(e=> {
    dbg('notifyCall error', e);
    // При ошибке показываем уведомление пользователю
    try {
      if (window.showToast) {
        window.showToast('Не удалось инициировать звонок: ' + e.message, 'error');
      } else {
        alert('Не удалось инициировать звонок');
      }
    } catch {}
  });
  try { deps.unlockAudio(); } catch {}
  return true;
}

export function cancelOutgoing(){ internalCancel(); }
export function declineIncoming(){ internalDecline(); }
export function acceptIncoming(){ internalAccept(); }

// Буфер сообщений если accountId ещё не доступен
const _pendingQueue = [];
let _replayTimer = null;
function scheduleReplay(){
  if (_replayTimer) return;
  _replayTimer = setTimeout(()=>{
    _replayTimer = null;
    const acc = deps.getAccountId();
    if (!acc){ scheduleReplay(); return; }
    if (_pendingQueue.length){ dbg('replaying queued messages', _pendingQueue.length); }
    for (const m of _pendingQueue.splice(0)){ _handleWsMessage(m, acc); }
  }, 400);
}

export function handleWsMessage(msg){
  if (!msg || typeof msg !== 'object') return;
  const acc = deps.getAccountId();
  if (!acc){
    _pendingQueue.push(msg);
    dbg('queued (no accountId yet)', msg.type);
    scheduleReplay();
    return;
  }
  _handleWsMessage(msg, acc);
}

function _handleWsMessage(msg, acc){
  try {
    // Сохраняем в глобальный буфер для ручной диагностики в консоли
    if (!window.__CALL_DEBUG) window.__CALL_DEBUG = [];
    window.__CALL_DEBUG.push({ ts: Date.now(), phase: state.phase, acc, msg });
    if (window.__CALL_DEBUG.length > 200) window.__CALL_DEBUG.splice(0, window.__CALL_DEBUG.length - 200);
  } catch {}
  
  // Отправляем в панель дебага
  if (window.debugPanel) {
    window.debugPanel.logCallEvent(
      `CALL_${msg.type.toUpperCase()}`, 
      { 
        roomId: msg.roomId, 
        from: msg.fromUserId, 
        to: msg.toUserId, 
        phase: state.phase,
        accountId: acc,
        msg: msg
      }
    );
  }
  
  dbg('ws msg', msg.type, { roomId: msg.roomId, from: msg.fromUserId, to: msg.toUserId, acc, curPhase: state.phase });
  switch(msg.type){
    case 'call_invite': {
      const isForMe = acc && msg.toUserId === acc;
      const isMine = acc && msg.fromUserId === acc;
      dbg('call_invite analysis', { isForMe, isMine, acc, fromUserId: msg.fromUserId, toUserId: msg.toUserId });
      if (isForMe){
        dbg('📞 Incoming call for me!', { fromUser: msg.fromUsername, roomId: msg.roomId, currentPhase: state.phase });
        if (['incoming_invite','outgoing_invite','active'].includes(state.phase)){
          if (state.roomId === msg.roomId && state.phase==='incoming_invite') setState({ otherUsername: msg.fromUsername });
        } else {
          // Fallback: если нет DOM элементов модалки — создаём упрощённый баннер
          try {
            if (!document.getElementById('incomingCallModal')){
              const fallback = document.getElementById('callFallbackModal') || document.createElement('div');
              fallback.id = 'callFallbackModal';
              fallback.style.position='fixed'; fallback.style.bottom='16px'; fallback.style.right='16px';
              fallback.style.background='#222'; fallback.style.color='#fff'; fallback.style.padding='12px 16px';
              fallback.style.borderRadius='8px'; fallback.style.zIndex='9999';
              fallback.innerHTML = '';
              const title = document.createElement('div'); title.textContent = 'Входящий звонок'; title.style.fontWeight='600'; fallback.appendChild(title);
              const from = document.createElement('div'); from.textContent = msg.fromUsername || msg.fromUserId || 'Пользователь'; fallback.appendChild(from);
              const row = document.createElement('div'); row.style.marginTop='8px'; fallback.appendChild(row);
              const mkBtn = (text, handler)=>{ const b=document.createElement('button'); b.textContent=text; b.style.marginRight='6px'; b.onclick=()=>{ try { handler(); } catch {}; try { fallback.remove(); } catch {}; }; row.appendChild(b); return b; };
              mkBtn('Принять', ()=> acceptIncoming());
              mkBtn('Отклонить', ()=> declineIncoming());
              document.body.appendChild(fallback);
            }
          } catch {}
          setState({ phase:'incoming_invite', roomId: msg.roomId, otherUserId: msg.fromUserId, otherUsername: msg.fromUsername });
          dbg('✅ Set incoming_invite state');
        }
      } else if (isMine){
        dbg('📞 Outgoing call confirmation for me!');
        if (state.phase==='idle'){
          setState({ phase:'outgoing_invite', roomId: msg.roomId, otherUserId: msg.toUserId, otherUsername: msg.toUsername });
        } else if (state.phase==='outgoing_invite' && state.roomId === msg.roomId){
          // Обновляем информацию о получателе, когда приходит подтверждение от сервера
          setState({ otherUsername: msg.toUsername });
        }
      }
      break; }
    case 'call_accept': {
      if (state.roomId === msg.roomId && ['outgoing_invite','incoming_invite'].includes(state.phase)){
        setState({ phase:'active' });
        try { deps.unlockAudio(); resumeAudio(); } catch {}
        if (msg.roomId) deps.navigateToRoom(msg.roomId);
      }
      break; }
    case 'call_decline': case 'call_cancel': {
      if (state.roomId === msg.roomId && state.phase !== 'idle'){
        setState({ phase:'ended', finalReason:'declined' });
        setTimeout(()=>{ if (state.phase==='ended') setState({ phase:'idle' }); }, 2000);
      }
      break; }
    case 'call_end': {
      if (state.roomId === msg.roomId && state.phase === 'active'){
        setState({ phase:'ended', finalReason: msg.reason || 'end' });
        setTimeout(()=>{ if (state.phase==='ended') setState({ phase:'idle' }); }, 1500);
      }
      break; }
    default: break;
  }
}

export function resetCallSystem(){ state = { phase:'idle' }; clearCallUI(); emit(); }

// Утилита для ручной диагностики из консоли
try {
  window.__debugCallState = ()=> ({ state: { ...state }, log: (window.__CALL_DEBUG||[]).slice() });
  window.getCallState = () => state;
  window.getCallDebug = () => ({
    state: state,
    lastMessages: (window.__CALL_DEBUG||[]).slice(-5),
    phase: state.phase,
    roomId: state.roomId,
    otherUser: state.otherUserId
  });
} catch {}
