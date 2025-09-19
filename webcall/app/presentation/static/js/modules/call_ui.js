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
let lastActionTs = 0;

function qs(id){ return /** @type {HTMLElement|null} */(document.getElementById(id)); }

let modalBound = false;

function ensureModalBindings(){
  if (modalBound) return;
  const accBtn = qs('btnCallAccept');
  const decBtn = qs('btnCallDecline');
  const cancelBtn = qs('btnCallCancel');
  if (accBtn){ accBtn.addEventListener('click', ()=>{ if (Date.now()-lastActionTs<200) return; lastActionTs=Date.now(); try { accBtn.disabled=true; decBtn && (decBtn.disabled=true); acceptHandler && acceptHandler(); } catch {} }); }
  if (decBtn){ decBtn.addEventListener('click', ()=>{ if (Date.now()-lastActionTs<200) return; lastActionTs=Date.now(); try { decBtn.disabled=true; accBtn && (accBtn.disabled=true); declineHandler && declineHandler(); } catch {} }); }
  if (cancelBtn){ cancelBtn.addEventListener('click', ()=>{ if (Date.now()-lastActionTs<200) return; lastActionTs=Date.now(); try { cancelBtn.disabled=true; cancelHandler && cancelHandler(); } catch {} }); }
  modalBound = true;
}

function showIncoming(username){
  ensureModalBindings();
  const m = qs('incomingCallModal');
  const sub = qs('incomingCallFrom');
  if (sub) sub.textContent = username || 'Пользователь';
  if (m) m.style.display = '';
  const status = qs('incomingCallStatus'); if (status) status.textContent='Входящий звонок...';
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
  if (s.phase === 'outgoing_invite') text = `Исходящий звонок: ${s.otherUsername || s.otherUserId} (ожидание ответа…)`;
  else if (s.phase === 'incoming_invite') text = `Входящий звонок от: ${s.otherUsername || s.otherUserId}`;
  else if (s.phase === 'active') text = `Звонок с: ${s.otherUsername || s.otherUserId}`;
  else if (s.phase === 'ended') {
    if (s.finalReason === 'declined' || s.finalReason === 'cancel') text = 'Звонок отклонён';
    else text = 'Звонок завершён';
  }
  el.textContent = text;
  const cbtn = ensureCancelButton();
  if (cbtn){ cbtn.style.display = (s.phase==='outgoing_invite') ? '' : 'none'; }

  // Обновление состояния кнопок модалки
  const accBtn = qs('btnCallAccept');
  const decBtn = qs('btnCallDecline');
  const cancelBtn = qs('btnCallCancel');
  if (s.phase==='incoming_invite'){
    if (accBtn) { accBtn.style.display=''; accBtn.disabled=false; }
    if (decBtn) { decBtn.style.display=''; decBtn.disabled=false; }
    if (cancelBtn) cancelBtn.style.display='none';
  } else if (s.phase==='outgoing_invite'){
    if (accBtn) accBtn.style.display='none';
    if (decBtn) decBtn.style.display='none';
    if (cancelBtn){ cancelBtn.style.display=''; cancelBtn.disabled=false; }
  } else {
    if (accBtn) accBtn.style.display='none';
    if (decBtn) decBtn.style.display='none';
    if (cancelBtn) cancelBtn.style.display='none';
  }
  const status = qs('incomingCallStatus');
  if (status){
    if (s.phase==='incoming_invite') status.textContent='Входящий звонок...';
    else if (s.phase==='outgoing_invite') status.textContent='Исходящий...';
    else if (s.phase==='active') status.textContent='Активный звонок';
    else if (s.phase==='ended') status.textContent='Завершено'; else status.textContent='';
  }
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
