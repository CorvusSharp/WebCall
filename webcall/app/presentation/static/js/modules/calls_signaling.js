// Полностью переписанный модуль сигналинга звонков.
// Основные цели:
//  1. Явная машина состояний с промежуточными фазами (dialing, outgoing_ringing, incoming_ringing, connecting, active, ended)
//  2. Таймауты набора / ожидания ответа, авто-отмена
//  3. Чёткая фильтрация дублирующих событий
//  4. Унифицированный UI слой (call_ui.js) через updateCallUI
//  5. Расширенное диагностическое логирование

import { notifyCall, acceptCall, declineCall, cancelCall } from '../api.js';
import { updateCallUI, bindActions, clearCallUI, hideIncoming } from './call_ui.js';
import { startIncomingRing, startOutgoingRing, stopAllRings, resumeAudio } from './call_audio.js';

// ============ Диагностика ============
const LOG = '[call-engine]';
function log(...a){ try { console.debug(LOG, ...a); } catch {} }
function warn(...a){ try { console.warn(LOG, ...a); } catch {} }

// ============ Типы ============
/**
 * @typedef {(
 *  'idle'|
 *  'dialing'|
 *  'outgoing_ringing'|
 *  'incoming_ringing'|
 *  'connecting'|
 *  'active'|
 *  'ended'
 * )} Phase
 */

/**
 * @typedef {Object} EngineState
 * @property {Phase} phase
 * @property {string=} roomId
 * @property {string=} otherUserId
 * @property {string=} otherUsername
 * @property {number} sinceTs
 * @property {string=} reason
 * @property {boolean=} incoming  // признак входящего сценария
 */

/**
 * @typedef {EngineState & { finalReason?:string, meta?:any }} UICallState
 */

/** @type {EngineState} */
let state = { phase:'idle', sinceTs: Date.now() };
const listeners = new Set();
let _dialTimer = null;  // таймер ожидания подтверждения вызова (получатель offline)
let _ringTimer = null;  // таймер ожидания ответа
let _graceTimer = null; // таймер авто-очистки после ended
const DIAL_TIMEOUT_MS = 15000;       // ожидание подтверждения (call_invite broadcast) УВЕЛИЧЕН
const RING_TIMEOUT_MS = 25000;       // ожидание ответа (accept/decline)
const OPTIMISTIC_RING_DELAY_MS = 800; // через сколько после notifyCall OK переходим в временное outgoing_ringing если echo ещё не пришёл
let _optimisticTimer = null; // таймер перехода в оптимистический ringing
  if (_optimisticTimer){ clearTimeout(_optimisticTimer); _optimisticTimer=null; }
  if (_optimisticTimer){ clearTimeout(_optimisticTimer); _optimisticTimer=null; }
const ENDED_CLEAR_DELAY_MS = 2000;   // задержка очистки баннера

// Внешние зависимости (DI)
let deps = {
  getAccountId: ()=> null,
  unlockAudio: ()=>{},
  navigateToRoom: (roomId)=>{ try { window.location.href = `/call/${roomId}`; } catch {} },
};

// ============ Утилиты таймеров ============
function clearTimers(){
  if (_dialTimer){ clearTimeout(_dialTimer); _dialTimer=null; }
  if (_ringTimer){ clearTimeout(_ringTimer); _ringTimer=null; }
  if (_graceTimer){ clearTimeout(_graceTimer); _graceTimer=null; }
}

function scheduleDialTimeout(){
  if (_dialTimer) clearTimeout(_dialTimer);
  _dialTimer = setTimeout(()=>{
    if (state.phase === 'dialing'){
      warn('dial timeout, auto cancel');
      transition('ended', { reason:'unavailable' });
    }
  }, DIAL_TIMEOUT_MS);
}

function scheduleRingTimeout(){
  if (_ringTimer) clearTimeout(_ringTimer);
  _ringTimer = setTimeout(()=>{
    if (['outgoing_ringing','incoming_ringing'].includes(state.phase)){
      warn('ring timeout, auto end');
      if (state.phase==='outgoing_ringing') attemptCancel('timeout');
      else transition('ended', { reason:'timeout' });
    }
  }, RING_TIMEOUT_MS);
}

function scheduleEndedCleanup(){
  if (_graceTimer) clearTimeout(_graceTimer);
  _graceTimer = setTimeout(()=>{ if (state.phase==='ended') transition('idle', { reason:undefined, roomId:undefined, otherUserId:undefined, otherUsername:undefined }); }, ENDED_CLEAR_DELAY_MS);
}

// ============ Слушатели / события ============
function emit(){
  try { updateCallUI(/** @type {UICallState} */({...state})); } catch(e){ warn('UI update failed', e); }
  for (const fn of [...listeners]){ try { fn({...state}); } catch{} }
  if (window.debugPanel){
    try { window.debugPanel.logCallEvent('STATE', { ...state }); } catch{}
  }
  try {
    window.appState && (window.appState.callPhase = state.phase);
  } catch{}
}

/**
 * @param {Phase} phase
 * @param {Partial<EngineState>} patch
 */
function transition(phase, patch){
  const prev = state;
  state = { ...state, ...patch, phase, sinceTs: Date.now() };
  log('transition', prev.phase, '->', phase, { room: state.roomId, peer: state.otherUserId, reason: state.reason||patch?.reason });
  // Аудио сигналы
  try {
    if (phase==='incoming_ringing'){ resumeAudio(); startIncomingRing(); }
    else if (phase==='outgoing_ringing'){ resumeAudio(); startOutgoingRing(); }
    if (!['incoming_ringing','outgoing_ringing'].includes(phase)) stopAllRings();
  } catch{}
  // Таймеры
  if (phase==='dialing') scheduleDialTimeout(); else if (prev.phase==='dialing') { if (_dialTimer) { clearTimeout(_dialTimer); _dialTimer=null; } }
  if (['outgoing_ringing','incoming_ringing'].includes(phase)) scheduleRingTimeout(); else if (['outgoing_ringing','incoming_ringing'].includes(prev.phase)) { if (_ringTimer){ clearTimeout(_ringTimer); _ringTimer=null; } }
  if (phase==='ended') scheduleEndedCleanup(); else if (phase!=='ended' && _graceTimer){ clearTimeout(_graceTimer); _graceTimer=null; }
  emit();
}

export function getCallState(){ return {...state}; }
export function onCallState(fn){ listeners.add(fn); return ()=>listeners.delete(fn); }

// ============ Public init ============
export function initCallSignaling(options){
  deps = { ...deps, ...(options||{}) };
  bindActions(
    ()=> acceptIncoming(),
    ()=> declineIncoming(),
    ()=> cancelOutgoing(),
    ()=> hangup()
  );
  log('initialized');
  try { window.__CALL_ENGINE__ = true; } catch{}
}

// ============ Actions ============
/** @param {{user_id:string, username?:string}} friend */
export function startOutgoingCall(friend){
  if (!friend || !friend.user_id){ warn('invalid friend'); return false; }
  if (state.phase !== 'idle'){ warn('call already in progress'); return false; }
  if (deps.getAccountId && String(deps.getAccountId()) === String(friend.user_id)){ warn('self-call blocked'); return false; }

  if (!isFriendsWsOpen()){
    toast('Нет соединения (WebSocket). Подождите...', 'warning');
    attemptWsReconnect();
    return false;
  }

  const roomId = buildRoomId(friend);
  transition('dialing', { roomId, otherUserId: friend.user_id, otherUsername: friend.username });
  try { deps.unlockAudio(); } catch{}
  scheduleDialTimeout();

  notifyCall(friend.user_id, roomId).then(()=>{
    log('notifyCall OK');
    // Планируем оптимистический переход, чтобы пользователь услышал звонок даже если echo задерживается
    if (_optimisticTimer) clearTimeout(_optimisticTimer);
    _optimisticTimer = setTimeout(()=>{
      _optimisticTimer=null;
      if (state.phase==='dialing'){
        log('optimistic transition -> outgoing_ringing (echo not yet received)');
        transition('outgoing_ringing', { meta:{ optimistic:true, confirmed:false } });
        // продлеваем общий ring timeout если нужно
        scheduleRingTimeout();
      }
    }, OPTIMISTIC_RING_DELAY_MS);
  }).catch(err=>{
    warn('notifyCall failed', err);
    transition('ended', { reason:'unavailable' });
  });
  return true;
}

export function cancelOutgoing(){
  if (['dialing','outgoing_ringing'].includes(state.phase)){
    attemptCancel('cancel');
  }
}

export function declineIncoming(){
  if (state.phase==='incoming_ringing'){
    attemptDecline('declined');
  }
}

export function acceptIncoming(){
  if (state.phase!=='incoming_ringing') return;
  if (!state.roomId || !state.otherUserId) return;
  transition('connecting', {});
  acceptCall(state.otherUserId, state.roomId).catch(err=>{
    warn('acceptCall failed', err);
    transition('ended', { reason:'unavailable' });
  });
  try { deps.unlockAudio(); resumeAudio(); } catch{}
  if (state.roomId) deps.navigateToRoom(state.roomId);
}

export function hangup(){
  if (state.phase==='active'){
    // Отправка call_end в app_init или другом месте (там уже реализовано). Здесь просто локально завершаем
    transition('ended', { reason:'end' });
  } else if (['connecting','incoming_ringing'].includes(state.phase)){
    attemptDecline('declined');
  } else if (['dialing','outgoing_ringing'].includes(state.phase)){
    attemptCancel('cancel');
  } else if (state.phase==='ended'){
    transition('idle', {});
  }
}

function attemptCancel(reason){
  if (!state.roomId || !state.otherUserId){ transition('ended', { reason:'cancel' }); return; }
  cancelCall(state.otherUserId, state.roomId).catch(()=>{});
  transition('ended', { reason: reason||'cancel' });
  hideIncoming();
}
function attemptDecline(reason){
  if (!state.roomId || !state.otherUserId){ transition('ended', { reason:'declined' }); return; }
  declineCall(state.otherUserId, state.roomId).catch(()=>{});
  transition('ended', { reason: reason||'declined' });
  hideIncoming();
}

// ============ Helpers ============
function buildRoomId(friend){
  const rnd = crypto.randomUUID().slice(0,8);
  const tag = (friend.username || friend.user_id || 'user').replace(/[^a-zA-Z0-9]+/g,'').slice(0,6) || 'user';
  return `call-${rnd}-${tag}`;
}

function isFriendsWsOpen(){
  try {
    const ws = window?.appState?.friendsWs;
    return !!ws && ws.readyState === WebSocket.OPEN;
  } catch { return false; }
}
function attemptWsReconnect(){
  try { if (window.startFriendsWs && !window.appState.friendsWsConnecting) window.startFriendsWs(); } catch{}
}
function toast(msg, level){ try { window.showToast && window.showToast(msg, level||'info'); } catch{ try { console.info('[toast]', msg); } catch{} } }

// ============ WS входящие сообщения ============
// Буфер до появления accountId
const _pending = []; let _pendingTimer=null;
function scheduleReplay(){ if (_pendingTimer) return; _pendingTimer = setTimeout(()=>{ _pendingTimer=null; const acc = deps.getAccountId(); if (!acc){ scheduleReplay(); return;} for (const m of _pending.splice(0)){ internalHandle(m, acc); } }, 350); }

export function handleWsMessage(msg){
  if (!msg || typeof msg !== 'object') return;
  const acc = deps.getAccountId();
  if (!acc){ _pending.push(msg); scheduleReplay(); return; }
  internalHandle(msg, acc);
}

function internalHandle(msg, acc){
  try {
    if (!window.__CALL_DEBUG) window.__CALL_DEBUG=[];
    window.__CALL_DEBUG.push({ ts:Date.now(), phase:state.phase, msg });
    if (window.__CALL_DEBUG.length>300) window.__CALL_DEBUG.splice(0, window.__CALL_DEBUG.length-300);
  } catch{}
  if (window.debugPanel){ try { window.debugPanel.logCallEvent('MSG', { type: msg.type, ...msg, phase: state.phase }); } catch{} }
  const t = msg.type;
  switch(t){
    case 'call_invite': return onInvite(msg, acc);
    case 'call_accept': return onAccept(msg, acc);
    case 'call_decline': return onDecline(msg, acc);
    case 'call_cancel': return onCancel(msg, acc);
    case 'call_end': return onEnd(msg, acc);
    default: break;
  }
}

function onInvite(m, acc){
  const isForMe = m.toUserId === acc;
  const isMine = m.fromUserId === acc;
  if (isMine){
    // Echo подтверждение: если мы в dialing -> переходим в outgoing_ringing
    if (state.phase==='dialing' && state.roomId === m.roomId){
      transition('outgoing_ringing', { otherUsername: m.toUsername || state.otherUsername, meta:{ optimistic:false, confirmed:true } });
    } else if (state.phase==='outgoing_ringing' && state.roomId === m.roomId){
      // Обновляем meta если это был оптимистический режим
      if (state.meta && state.meta.optimistic && !state.meta.confirmed){
        state.meta.optimistic=false; state.meta.confirmed=true; log('server confirmation for optimistic ringing');
      }
    }
    return;
  }
  if (isForMe){
    if (!['idle','ended'].includes(state.phase)){
      // Уже заняты — авто decline
      warn('incoming invite while busy -> decline');
      declineCall(m.fromUserId, m.roomId).catch(()=>{});
      return;
    }
    transition('incoming_ringing', { roomId: m.roomId, otherUserId: m.fromUserId, otherUsername: m.fromUsername, incoming:true });
  }
}
function onAccept(m, acc){
  if (state.roomId !== m.roomId) return;
  if (['outgoing_ringing','incoming_ringing','dialing','connecting'].includes(state.phase)){
    transition('active', {});
    try { deps.unlockAudio(); resumeAudio(); } catch{}
    if (m.roomId) deps.navigateToRoom(m.roomId);
  }
}
function onDecline(m, acc){
  if (state.roomId !== m.roomId) return;
  if (state.phase !== 'idle') transition('ended', { reason:'declined' });
}
function onCancel(m, acc){
  if (state.roomId !== m.roomId) return;
  if (state.phase !== 'idle') transition('ended', { reason:'cancel' });
}
function onEnd(m, acc){
  if (state.roomId !== m.roomId) return;
  if (state.phase === 'active') transition('ended', { reason: m.reason||'end' });
}

// ============ Legacy совместимость (минимум) ============
// Сохраняем базовые хуки, чтобы старый код не ломался (если он обращается к предыдущим экспортам)
export function resetCallSystem(){ clearTimers(); state = { phase:'idle', sinceTs: Date.now() }; clearCallUI(); emit(); }

// Псевдонимы старых имён
export const startOutgoingCallOld = startOutgoingCall;
export const cancelOutgoingOld = cancelOutgoing;
export const declineIncomingOld = declineIncoming;
export const acceptIncomingOld = acceptIncoming;

// Для консольной диагностики
try {
  window.__debugCallState = () => ({ state: {...state}, log:(window.__CALL_DEBUG||[]).slice(-20) });
  window.getCallState = () => ({...state});
} catch{}

// Экспорт типов для JSDoc других модулей
export {};
