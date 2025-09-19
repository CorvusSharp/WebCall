// Новый UI слой для звонков.
// Полностью переписан: независимая от бизнес-логики визуализация машины состояний.
// Состояния, приходящие извне (из calls_signaling.js):
//  idle | dialing | outgoing_ringing | incoming_ringing | connecting | active | ended
// Поля:
//  { phase, roomId?, otherUserId?, otherUsername?, reason?, sinceTs, meta? }
// Задачи UI: обновить баннер, модалку входящего, кнопки действий, мини-индикаторы.

/** @typedef {import('./calls_signaling.js').UICallState} UICallState */

let _handlers = { accept:null, decline:null, cancel:null, hangup:null };
let _lastClick = 0;

function qs(id){ return /** @type {HTMLElement|null} */(document.getElementById(id)); }

// ---- Создание/кеш UI элементов ----
function ensureButtons(){
  const ctx = qs('callContext');
  if (!ctx) return;
  if (!qs('btnCallCancel')){
    const b = document.createElement('button'); b.id='btnCallCancel'; b.textContent='Отменить'; b.className='btn btn-sm'; ctx.appendChild(b);
    b.addEventListener('click', ()=>actionGuard(()=>_handlers.cancel && _handlers.cancel()));
  }
  if (!qs('btnCallHangup')){
    const b2 = document.createElement('button'); b2.id='btnCallHangup'; b2.textContent='Завершить'; b2.className='btn btn-sm btn-danger'; b2.style.marginLeft='6px'; ctx.appendChild(b2);
    b2.addEventListener('click', ()=>actionGuard(()=>_handlers.hangup && _handlers.hangup()));
  }
}

function actionGuard(fn){
  const now = Date.now();
  if (now - _lastClick < 250) return; // debounce
  _lastClick = now;
  try { fn(); } catch(e){ console.warn('[call-ui] action error', e); }
}

// ---- Incoming modal ----
function showIncoming(name, statusText){
  let modal = qs('incomingCallModal');
  if (!modal){
    // Fallback создание простой модалки если нет в DOM
    modal = document.createElement('div');
    modal.id='incomingCallModal';
    modal.style.position='fixed'; modal.style.top='20px'; modal.style.right='20px';
    modal.style.background='#202124'; modal.style.color='#fff'; modal.style.padding='16px'; modal.style.borderRadius='10px'; modal.style.boxShadow='0 4px 16px rgba(0,0,0,.3)'; modal.style.zIndex='10000';
    modal.innerHTML = `
      <div id="incomingCallTitle" style="font-weight:600;margin-bottom:4px">Входящий звонок</div>
      <div id="incomingCallFrom" style="opacity:.85"></div>
      <div id="incomingCallStatus" style="font-size:12px;margin-top:4px;color:#9fa8b1"></div>
      <div style="margin-top:10px;display:flex;gap:8px">
        <button id="btnCallAccept" class="btn btn-sm btn-success">Принять</button>
        <button id="btnCallDecline" class="btn btn-sm btn-secondary">Отклонить</button>
      </div>`;
    document.body.appendChild(modal);
  }
  const from = qs('incomingCallFrom'); if (from) from.textContent = name || 'Пользователь';
  const st = qs('incomingCallStatus'); if (st) st.textContent = statusText || 'Звонит...';
  modal.style.display='';
  bindModalButtons();
}

function hideIncoming(){ const m = qs('incomingCallModal'); if (m) m.style.display='none'; }

function bindModalButtons(){
  const a = qs('btnCallAccept');
  const d = qs('btnCallDecline');
  if (a && !a.__bound){ a.__bound = true; a.addEventListener('click', ()=> actionGuard(()=> _handlers.accept && _handlers.accept())); }
  if (d && !d.__bound){ d.__bound = true; d.addEventListener('click', ()=> actionGuard(()=> _handlers.decline && _handlers.decline())); }
}

// ---- Banner / status area ----
function render(state){
  ensureButtons();
  const banner = qs('callContext');
  if (!banner) return;
  /** @type {UICallState} */
  const s = state || { phase:'idle' };
  let text = '';
  const peer = s.otherUsername || s.otherUserId || '';
  switch (s.phase){
    case 'idle': text=''; break;
    case 'dialing': text = `Соединение с ${peer}… (dialing)`; break;
    case 'outgoing_ringing': text = `Звоним: ${peer} (ожидание ответа)`; break;
    case 'incoming_ringing': text = `Входящий звонок от: ${peer}`; break;
    case 'connecting': text = `Подключение к ${peer}…`; break;
    case 'active': text = `В разговоре с ${peer}`; break;
    case 'ended': text = formatEndedReason(s); break;
    default: text = s.phase;
  }
  banner.textContent = text;

  // Управление видимостью кнопок
  const btnCancel = qs('btnCallCancel');
  const btnHang = qs('btnCallHangup');
  if (btnCancel){
    btnCancel.style.display = ['dialing','outgoing_ringing'].includes(s.phase) ? '' : 'none';
    btnCancel.disabled = s.phase==='ended';
  }
  if (btnHang){
    btnHang.style.display = ['active','connecting','incoming_ringing'].includes(s.phase) ? '' : (s.phase==='ended' ? '' : 'none');
    btnHang.disabled = s.phase==='ended';
    if (s.phase==='ended') btnHang.textContent='Закрыть'; else btnHang.textContent='Завершить';
  }

  // Incoming modal logic
  if (s.phase === 'incoming_ringing'){
    showIncoming(peer, 'Звонит…');
  } else if (s.phase === 'connecting'){
    if (s.incoming) showIncoming(peer, 'Подключение…'); else hideIncoming();
  } else if (s.phase === 'active'){
    hideIncoming();
  } else if (s.phase === 'ended'){
    hideIncoming();
  }
}

function formatEndedReason(s){
  const r = s.reason || s.finalReason || '';
  switch (r){
    case 'declined': return 'Звонок отклонён';
    case 'cancel': return 'Звонок отменён';
    case 'timeout': return 'Не отвечает (таймаут)';
    case 'unavailable': return 'Пользователь недоступен';
    case 'end': return 'Звонок завершён';
    default: return 'Звонок завершён';
  }
}

// ---- Публичные API ----
/** @param {UICallState} state */
export function updateCallUI(state){ try { render(state); } catch(e){ console.warn('[call-ui] render error', e); } }

export function bindActions(onAccept, onDecline, onCancel, onHangup){
  _handlers.accept = onAccept; _handlers.decline = onDecline; _handlers.cancel = onCancel; _handlers.hangup = onHangup;
  bindModalButtons(); ensureButtons();
}

export function clearCallUI(){ updateCallUI({ phase:'idle' }); }

export { hideIncoming };
