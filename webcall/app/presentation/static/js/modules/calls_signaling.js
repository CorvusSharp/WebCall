// calls_signaling.js — новая упрощённая система сигналинга звонков
// Изолирует состояние и переходы. Не зависит от старого calls.js.

import { notifyCall, acceptCall, declineCall, cancelCall } from '../api.js';
import { updateCallUI, bindActions, clearCallUI } from './call_ui.js';

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

const listeners = new Set();

function emit(){
  for (const fn of listeners) { try { fn(state); } catch {} }
  updateCallUI(state);
}

function setState(patch){ state = { ...state, ...patch }; emit(); }
export function getCallState(){ return state; }
export function onCallState(fn){ listeners.add(fn); return ()=> listeners.delete(fn); }

let deps = {
  getAccountId: ()=> null,
  connectRoom: ()=>{},
  unlockAudio: ()=>{},
};

export function initCallSignaling(options){
  deps = { ...deps, ...(options||{}) };
  bindActions(()=>{ if (state.phase==='incoming_invite') internalAccept(); }, ()=>{ if (state.phase==='incoming_invite') internalDecline(); });
}

function internalAccept(){
  if (state.phase !== 'incoming_invite') return;
  const roomId = state.roomId; const other = state.otherUserId;
  setState({ phase:'active' });
  // Отправляем accept
  if (roomId && other){ acceptCall(other, roomId).catch(()=>{}); }
  try { deps.unlockAudio(); } catch {}
  try { if (roomId){ const roomInput = document.getElementById('roomId'); if (roomInput && 'value' in roomInput) roomInput.value = roomId; } } catch {}
  try { deps.connectRoom(); } catch {}
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
  notifyCall(friend.user_id, room).catch(()=>{});
  try { deps.unlockAudio(); } catch {}
  return true;
}

export function cancelOutgoing(){ internalCancel(); }
export function declineIncoming(){ internalDecline(); }
export function acceptIncoming(){ internalAccept(); }

export function handleWsMessage(msg){
  const acc = deps.getAccountId();
  if (!msg || typeof msg !== 'object') return;
  switch(msg.type){
    case 'call_invite': {
      const isForMe = acc && msg.toUserId === acc;
      const isMine = acc && msg.fromUserId === acc;
      if (isForMe){
        // Если уже есть исходящий — игнорируем, если активный — тоже игнорируем
        if (['incoming_invite','outgoing_invite','active'].includes(state.phase)){
          // Возможный дубликат — если тот же roomId и статус входящий, просто обновим имя
          if (state.roomId === msg.roomId && state.phase==='incoming_invite') setState({ otherUsername: msg.fromUsername });
        } else {
          setState({ phase:'incoming_invite', roomId: msg.roomId, otherUserId: msg.fromUserId, otherUsername: msg.fromUsername });
        }
      } else if (isMine){
        // Подтверждение исходящего инвайта (сам себе зеркало) — если idle
        if (state.phase==='idle'){
          setState({ phase:'outgoing_invite', roomId: msg.roomId, otherUserId: msg.toUserId, otherUsername: msg.toUsername });
        }
      }
      break; }
    case 'call_accept': {
      if (state.roomId === msg.roomId && ['outgoing_invite','incoming_invite'].includes(state.phase)){
        setState({ phase:'active' });
        try { if (state.phase==='active'){ deps.unlockAudio(); deps.connectRoom(); } } catch {}
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
