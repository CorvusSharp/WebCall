// call_ui.js — изолированный UI слой для звонков (минимальная версия)
// Не хранит бизнес-логики. Получает состояние и отражает его в DOM.

/**
 * Shape состояния (копия того, что выдаёт calls_signaling):
 * {
 *   phase: 'idle'|'incoming_invite'|'outgoing_invite'|'active'|'ended',
 *   roomId?: string,
 *   otherUserId?: string,
 *   otherUsername?: string,
 *   finalReason?: string,
 * }
 */

let acceptHandler = null;
let declineHandler = null;
let cancelHandler = null;

function qs(id){ return /** @type {HTMLElement|null} */(document.getElementById(id)); }

let modalBound = false;

function ensureModalBindings(){
  if (modalBound) return;
  const accBtn = qs('btnCallAccept');
  const decBtn = qs('btnCallDecline');
  const cancelBtn = qs('btnCallCancel');
  if (accBtn){ accBtn.addEventListener('click', ()=>{ try { acceptHandler && acceptHandler(); } catch {} }); }
  if (decBtn){ decBtn.addEventListener('click', ()=>{ try { declineHandler && declineHandler(); } catch {} }); }
  if (cancelBtn){ cancelBtn.addEventListener('click', ()=>{ try { cancelHandler && cancelHandler(); } catch {} }); }
  modalBound = true;
}

function showIncoming(username){
  ensureModalBindings();
  const m = qs('incomingCallModal');
  const sub = qs('incomingCallFrom');
  if (sub) sub.textContent = username || 'Пользователь';
  if (m) m.style.display = '';
}

function hideIncoming(){
  const m = qs('incomingCallModal'); if (m) m.style.display='none';
}

function ensureCancelButton(){
  let btn = qs('btnCallCancel');
  if (!btn){
    const ctx = qs('callContext');
    if (ctx){
      btn = document.createElement('button');
      btn.id='btnCallCancel';
      btn.textContent='Отменить';
      btn.style.marginLeft='8px';
      btn.addEventListener('click', ()=>{ try { cancelHandler && cancelHandler(); } catch {} });
      ctx.appendChild(btn);
    }
  }
  return btn;
}

function renderBanner(state){
  const el = qs('callContext');
  if (!el) return;
  const s = state || { phase:'idle' };
  let text = '';
  if (s.phase === 'outgoing_invite') text = `Исходящий звонок: ${s.otherUsername || s.otherUserId}`;
  else if (s.phase === 'incoming_invite') text = `Входящий звонок от: ${s.otherUsername || s.otherUserId}`;
  else if (s.phase === 'active') text = `Звонок с: ${s.otherUsername || s.otherUserId}`;
  else if (s.phase === 'ended') {
    if (s.finalReason === 'declined' || s.finalReason === 'cancel') text = 'Звонок отклонён';
    else text = 'Звонок завершён';
  }
  el.textContent = text;
  const cbtn = ensureCancelButton();
  if (cbtn){ cbtn.style.display = (s.phase==='outgoing_invite') ? '' : 'none'; }
}

export function updateCallUI(state){
  renderBanner(state);
  if (state.phase === 'incoming_invite') {
    showIncoming(state.otherUsername || state.otherUserId || 'Пользователь');
  } else {
    hideIncoming();
  }
}

export function bindActions(onAccept, onDecline, onCancel){
  acceptHandler = onAccept;
  declineHandler = onDecline;
  cancelHandler = onCancel;
}

export function clearCallUI(){ updateCallUI({ phase:'idle' }); }
