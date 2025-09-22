import { els, showToast } from './core/dom.js';

// Новый UI слой для звонков. Отвечает за модалки, баннер статуса и уведомления.
/** @typedef {import('./calls_signaling.js').UICallState} UICallState */

const PHASE_ICONS = Object.freeze({
  idle: '📞',
  dialing: '⏳',
  outgoing_ringing: '📤',
  incoming_ringing: '📥',
  connecting: '🔄',
  active: '✅',
  ended: '⚠️',
});

let _handlers = { accept: null, decline: null, cancel: null, hangup: null };
let _lastClick = 0;
let _lastPhase = 'idle';
let _shellPrepared = false;

function actionGuard(fn) {
  const now = Date.now();
  if (now - _lastClick < 250) return; // простая защита от двойных кликов
  _lastClick = now;
  try { fn(); } catch (e) { console.warn('[call-ui] action error', e); }
}

function prepareShell() {
  if (_shellPrepared) return;
  _shellPrepared = true;
  if (els.callContext) {
    els.callContext.classList.add('call-banner');
    els.callContext.setAttribute('aria-live', 'polite');
    els.callContext.textContent = '';
    els.callContext.style.display = 'none';
  }
}

function ensureModal(id, variant) {
  let modal = document.getElementById(id);
  if (modal && !modal.classList.contains('call-modal')) {
    try { modal.remove(); } catch {}
    modal = null;
  }
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = id;
  modal.className = `call-modal call-modal--${variant} is-hidden`;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  if (variant === 'incoming') {
    modal.innerHTML = `
      <div class="call-modal__body">
        <div class="call-modal__avatar call-modal__avatar--incoming"><span class="call-modal__avatar-icon">📞</span></div>
        <h3 class="call-modal__title">Входящий звонок</h3>
        <p class="call-modal__name" id="incomingCallFrom"></p>
        <p class="call-modal__status" id="incomingCallStatus"></p>
        <div class="call-modal__actions">
          <button id="btnCallAccept" class="btn btn-success">Принять</button>
          <button id="btnCallDecline" class="btn btn-ghost">Отклонить</button>
        </div>
      </div>`;
  } else {
    modal.innerHTML = `
      <div class="call-modal__body">
        <div class="call-modal__avatar call-modal__avatar--outgoing"><span class="call-modal__avatar-icon">📤</span></div>
        <h3 class="call-modal__title">Соединяем…</h3>
        <p class="call-modal__name" id="outgoingCallTo"></p>
        <p class="call-modal__status" id="outgoingCallStatus"></p>
        <div class="call-modal__actions call-modal__actions--single">
          <button id="btnOutgoingCancel" class="btn btn-secondary">Отменить</button>
        </div>
      </div>`;
  }

  document.body.appendChild(modal);
  bindModalButtons();
  return modal;
}

function showIncoming(name, statusText) {
  const modal = ensureModal('incomingCallModal', 'incoming');
  const from = modal.querySelector('#incomingCallFrom');
  const status = modal.querySelector('#incomingCallStatus');
  if (from) from.textContent = name || 'Пользователь';
  if (status) status.textContent = statusText || 'Звонит…';
  modal.classList.remove('is-hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function hideIncoming() {
  const modal = document.getElementById('incomingCallModal');
  if (!modal) return;
  modal.classList.add('is-hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function showOutgoing(peer, statusText) {
  const modal = ensureModal('outgoingCallModal', 'outgoing');
  const toEl = modal.querySelector('#outgoingCallTo');
  const status = modal.querySelector('#outgoingCallStatus');
  if (toEl) toEl.textContent = peer || '';
  if (status) status.textContent = statusText || 'Соединение…';
  modal.classList.remove('is-hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function hideOutgoing() {
  const modal = document.getElementById('outgoingCallModal');
  if (!modal) return;
  modal.classList.add('is-hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function bindModalButtons() {
  const accept = document.getElementById('btnCallAccept');
  const decline = document.getElementById('btnCallDecline');
  const cancel = document.getElementById('btnOutgoingCancel');
  if (accept && !accept.__bound) {
    accept.__bound = true;
    accept.addEventListener('click', () => actionGuard(() => _handlers.accept && _handlers.accept()));
  }
  if (decline && !decline.__bound) {
    decline.__bound = true;
    decline.addEventListener('click', () => actionGuard(() => _handlers.decline && _handlers.decline()));
  }
  if (cancel && !cancel.__bound) {
    cancel.__bound = true;
    cancel.addEventListener('click', () => actionGuard(() => _handlers.cancel && _handlers.cancel()));
  }
}

function updateBanner(phase, text) {
  if (!els.callContext) return;
  if (!text) {
    els.callContext.textContent = '';
    els.callContext.style.display = 'none';
    els.callContext.removeAttribute('data-phase');
    return;
  }
  const icon = PHASE_ICONS[phase] || PHASE_ICONS.idle;
  els.callContext.innerHTML = `<span class="call-banner__icon">${icon}</span><span class="call-banner__text">${text}</span>`;
  els.callContext.dataset.phase = phase;
  els.callContext.style.display = '';
}

function render(state) {
  prepareShell();
  /** @type {UICallState} */
  const s = state || { phase: 'idle' };
  const peer = s.otherUsername || s.otherUserId || '';
  let text = '';
  switch (s.phase) {
    case 'idle':
      text = '';
      break;
    case 'dialing':
      text = peer ? `Соединяемся с ${peer}…` : 'Подготавливаем соединение…';
      break;
    case 'outgoing_ringing':
      text = peer ? `Звоним ${peer}…` : 'Звоним…';
      break;
    case 'incoming_ringing':
      text = peer ? `Входящий звонок от ${peer}` : 'Входящий звонок';
      break;
    case 'connecting':
      text = peer ? `Подключение к ${peer}…` : 'Подключение…';
      break;
    case 'active':
      text = peer ? `В разговоре с ${peer}` : 'Звонок активен';
      break;
    case 'ended':
      text = formatEndedReason(s);
      break;
    default:
      text = s.phase;
  }
  updateBanner(s.phase, text);

  if (s.phase === 'incoming_ringing') {
    hideOutgoing();
    showIncoming(peer, 'Звонит…');
  } else if (s.phase === 'dialing') {
    hideIncoming();
    showOutgoing(peer, 'Соединяем…');
  } else if (s.phase === 'outgoing_ringing') {
    hideIncoming();
    showOutgoing(peer, 'Ожидаем ответ…');
  } else if (s.phase === 'connecting') {
    if (s.incoming) {
      hideOutgoing();
      showIncoming(peer, 'Подключаем…');
    } else {
      hideIncoming();
      showOutgoing(peer, 'Подключаем…');
    }
  } else {
    hideIncoming();
    hideOutgoing();
  }

  if (s.phase === 'ended' && _lastPhase !== 'ended') {
    const reasonText = formatEndedReason(s);
    showToast(reasonText, { type: 'info', timeoutMs: 3200 });
  } else if (s.phase === 'active' && _lastPhase !== 'active') {
    const successText = peer ? `Соединение с ${peer} установлено` : 'Соединение установлено';
    showToast(successText, { type: 'success', timeoutMs: 2400 });
  }
  _lastPhase = s.phase;
}

function formatEndedReason(s) {
  const r = s.reason || s.finalReason || '';
  switch (r) {
    case 'declined':
      return 'Звонок отклонён';
    case 'cancel':
      return 'Звонок отменён';
    case 'timeout':
      return 'Не удалось дозвониться (таймаут)';
    case 'unavailable':
      return 'Пользователь недоступен';
    case 'hangup':
      return 'Вы завершили звонок';
    case 'leave':
      return 'Собеседник покинул звонок';
    case 'disconnect':
      return 'Связь потеряна';
    case 'failed':
      return 'Не удалось установить соединение';
    default:
      return 'Звонок завершён';
  }
}

export function updateCallUI(state) {
  try { render(state); } catch (e) { console.warn('[call-ui] render error', e); }
}

export function bindActions(onAccept, onDecline, onCancel, onHangup) {
  _handlers.accept = onAccept;
  _handlers.decline = onDecline;
  _handlers.cancel = onCancel;
  _handlers.hangup = onHangup;
  bindModalButtons();
}

export function clearCallUI() {
  updateCallUI({ phase: 'idle' });
}

export { hideIncoming, hideOutgoing };
