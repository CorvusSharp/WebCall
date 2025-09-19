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
  try {
    if (state.phase==='incoming_invite' && prev.phase!=='incoming_invite'){ resumeAudio(); startIncomingRing(); }
    if (state.phase==='outgoing_invite' && prev.phase!=='outgoing_invite'){ resumeAudio(); startOutgoingRing(); }
    if (prev.phase==='incoming_invite' && state.phase!=='incoming_invite'){ stopAllRings(); }
    if (prev.phase==='outgoing_invite' && state.phase!=='outgoing_invite'){ stopAllRings(); }
    if (state.phase==='active' || state.phase==='ended'){ stopAllRings(); }
  } catch {}
  emit();
}
export function getCallState(){ return state; }
export function onCallState(fn){ listeners.add(fn); return ()=> listeners.delete(fn); }

let deps = {
  getAccountId: ()=> null,
  connectRoom: ()=>{},
  unlockAudio: ()=>{},
  navigateToRoom: (roomId)=>{ try { window.location.href = `/call/${roomId}`; } catch {} },
};

export function initCallSignaling(options){
  deps = { ...deps, ...(options||{}) };
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
  const rnd = crypto.randomUUID().slice(0,8);
  const tag = (friend.username || friend.user_id || 'user').replace(/[^a-zA-Z0-9]+/g,'').slice(0,6) || 'user';
  const room = `call-${rnd}-${tag}`;
  try { const roomInput = document.getElementById('roomId'); if (roomInput && 'value' in roomInput) roomInput.value = room; } catch {}
  setState({ phase:'outgoing_invite', roomId: room, otherUserId: friend.user_id, otherUsername: friend.username });
  dbg('notifyCall ->', friend.user_id, room);
  notifyCall(friend.user_id, room).then(()=> dbg('notifyCall ok')).catch(e=> dbg('notifyCall error', e));
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
  dbg('ws msg', msg.type, { roomId: msg.roomId, from: msg.fromUserId, to: msg.toUserId, acc });
  switch(msg.type){
    case 'call_invite': {
      const isForMe = acc && msg.toUserId === acc;
      const isMine = acc && msg.fromUserId === acc;
      if (isForMe){
        if (['incoming_invite','outgoing_invite','active'].includes(state.phase)){
          if (state.roomId === msg.roomId && state.phase==='incoming_invite') setState({ otherUsername: msg.fromUsername });
        } else {
          setState({ phase:'incoming_invite', roomId: msg.roomId, otherUserId: msg.fromUserId, otherUsername: msg.fromUsername });
        }
      } else if (isMine){
        if (state.phase==='idle'){
          setState({ phase:'outgoing_invite', roomId: msg.roomId, otherUserId: msg.toUserId, otherUsername: msg.toUsername });
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
