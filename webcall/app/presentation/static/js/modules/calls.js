// @ts-check
// modules/calls.js
// Управление состоянием эфемерных звонков + (позже) спец-рингтон.
// Минимальная изоляция: не тянем напрямую огромный main.js.

import { appState } from './core/state.js';

/**
 * @typedef {import('./core/state.js').ActiveCallState} ActiveCallState
 */
import { els } from './core/dom.js';
import { acceptCall, declineCall } from '../api.js';

// Коллбэки, которые инициализируются из точки входа (main/app_init)
// чтобы избежать жёсткой зависимости (например, от unlockAudioPlayback или loadFriends)
/** @type {{ reloadFriends: (null|(()=>void)); unlockAudioPlayback: (null|(()=>void)); connectRoom?: (null|(()=>void)); }} */
let hooks = {
  reloadFriends: null,          // () => void
  unlockAudioPlayback: null,     // () => void
};

export function initCallModule(options = {}){
  hooks = { ...hooks, ...options };
}

/** Ререндер текста о текущем звонке */
function renderCallContext(){
  if (!els.callContext) return;
  /** @type {ActiveCallState|null} */
  const c = appState.activeCall;
  if (!c){ els.callContext.textContent = ''; return; }
  if (c.direction === 'outgoing' && c.status === 'invited'){
    els.callContext.textContent = `Исходящий звонок: ${c.username || c.withUserId}`;
  } else if (c.direction === 'incoming' && c.status === 'invited') {
    els.callContext.textContent = `Входящий звонок от: ${c.username || c.withUserId}`;
  } else if (c.status === 'accepted') {
    els.callContext.textContent = `Звонок с: ${c.username || c.withUserId}`;
  } else if (c.status === 'declined') {
    els.callContext.textContent = `Отклонён`; // кратко, быстро исчезнет после reset
  } else {
    els.callContext.textContent = '';
  }
}

function touchFriends(){
  try { hooks.reloadFriends && hooks.reloadFriends(); } catch {}
}

/** @param {{user_id:string, username?:string}} friend @param {string} roomId */
export function setActiveOutgoingCall(friend, roomId){
  appState.activeCall = { roomId, withUserId: friend.user_id, username: friend.username, direction: 'outgoing', status: 'invited' };
  renderCallContext();
  touchFriends();
  try { startOutgoingTone(); } catch {}
}

/** @param {string} fromUserId @param {string} username @param {string} roomId */
export function setActiveIncomingCall(fromUserId, username, roomId){
  appState.activeCall = { roomId, withUserId: fromUserId, username, direction: 'incoming', status: 'invited' };
  appState.pendingIncomingInvites.set(fromUserId, { roomId, username });
  renderCallContext();
  touchFriends();
  // Универсальный входящий тон (incall) — одинаковый для всех пользователей
  try { startIncomingTone(); } catch {}
  showIncomingCallModal(username || fromUserId, roomId, fromUserId);
}

/** @param {string} roomId */
export function markCallAccepted(roomId){
  if (appState.activeCall && appState.activeCall.roomId === roomId){
    appState.activeCall.status = 'accepted';
    renderCallContext();
  }
  stopCallTones();
  hideIncomingCallModal();
  try { const k = appState.activeCall?.withUserId; if (k) appState.pendingIncomingInvites.delete(k); } catch {}
  touchFriends();
}

/** @param {string} roomId */
export function markCallDeclined(roomId){
  if (appState.activeCall && appState.activeCall.roomId === roomId){
    appState.activeCall.status = 'declined';
    renderCallContext();
    setTimeout(()=> resetActiveCall('declined'), 1500);
  }
  stopCallTones();
  hideIncomingCallModal();
  try { const k = appState.activeCall?.withUserId; if (k) appState.pendingIncomingInvites.delete(k); } catch {}
  touchFriends();
}

/** @param {string} reason */
export function resetActiveCall(reason){
  appState.activeCall = null;
  renderCallContext();
  stopCallTones();
  hideIncomingCallModal();
  touchFriends();
}

export function getActiveCall(){ return appState.activeCall; }
export function getPendingIncomingInvites(){ return appState.pendingIncomingInvites; }

// ===== Спец-рингтон (мигрирует сюда по частям) =====
// Используем секцию appState.special
const SPECIAL_RING_EMAILS = new Set([
  'roman74mamin@gmail.com',
  'gerasimenkoooo37@gmail.com',
  'myphone@gmail.com',
]);

const isMobileBrowser = typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');

// Стандартизированные причины завершения (используются в WS call_end)
export const CALL_END_REASONS = Object.freeze({
  HANGUP: 'hangup',
  LEAVE: 'leave',
  DISCONNECT: 'disconnect',
  TIMEOUT: 'timeout',
  FAILED: 'failed',
});

function getStoredEmail(){ try { return localStorage.getItem('wc_email') || ''; } catch { return ''; } }

async function ensureSpecialRingtone(){
  const s = appState.special;
  if (s.ringtone) return s.ringtone;
  if (s.readyPromise) return s.readyPromise;
  s.readyPromise = (async () => {
    // Новый упорядоченный список кандидатов: сначала каноническое имя в новой папке media.
    const candidates = [
      '/static/media/special_ringtone.mp3',
      // Fallback: старый путь (до миграции), оставляем временно для совместимости c кэшем.
      '/static/js/Sil-a%20%26%20YUNG%20TRAPPA%20-%20%D0%94%D0%B0%D0%B2%D0%B0%D0%B9%20%D0%BA%D0%B8%D0%BD%D0%B5%D0%BC%20%D0%B1%D0%B0%D1%80%D1%8B%D0%B3%D1%83.mp3',
    ];
    for (const src of candidates){
      try {
        const audio = new Audio(src); audio.preload='auto'; audio.loop=true; audio.volume=1.0;
        const ok = await new Promise(res=>{
          let done=false; const cleanup=()=>{ if(done) return; done=true; audio.removeEventListener('loadedmetadata', onMeta); audio.removeEventListener('canplay', onCan); audio.removeEventListener('error', onErr); };
          const onMeta=()=>{ cleanup(); res(true); }; const onCan=()=>{ cleanup(); res(true); }; const onErr=()=>{ cleanup(); res(false); };
          audio.addEventListener('loadedmetadata', onMeta, { once:true });
          audio.addEventListener('canplay', onCan, { once:true });
          audio.addEventListener('error', onErr, { once:true });
          try { audio.load?.(); } catch {}
          setTimeout(()=>{ if (audio.readyState>=1){ cleanup(); res(true); } }, 60);
        });
        if (ok){ s.ringtone = audio; return audio; }
      } catch {}
    }
    return null;
  })();
  const r = await s.readyPromise; s.readyPromise = null; return r;
}

// === Новая система тонов ===
// outcall.mp3 — слышит звонящий во время исходящего дозвона
// incall.mp3  — слышит тот, кому звонят (входящий)
// special_ringtone.mp3 — ТОЛЬКО для исходящих спец-пользователей (ранее было для входящего) по требованию

/** @type {HTMLAudioElement|null} */
let genericOutcallAudio = null;
/** @type {HTMLAudioElement|null} */
let genericIncallAudio = null;

/**
 * @param {('outcall'|'incall')} kind
 * @returns {HTMLAudioElement|null}
 */
function ensureGenericAudio(kind){
  if (kind === 'outcall'){
    if (!genericOutcallAudio){ try { genericOutcallAudio = new Audio('/static/media/outcall.mp3'); genericOutcallAudio.loop = true; genericOutcallAudio.preload='auto'; } catch {} }
    return genericOutcallAudio;
  } else {
    if (!genericIncallAudio){ try { genericIncallAudio = new Audio('/static/media/incall.mp3'); genericIncallAudio.loop = true; genericIncallAudio.preload='auto'; } catch {} }
    return genericIncallAudio;
  }
}

// === Fade утилиты ===
/**
 * Плавное изменение громкости
 * @param {HTMLAudioElement} audio
 * @param {number} target 0..1
 * @param {number} ms
 * @param {()=>void} [onDone]
 */
function fadeVolume(audio, target, ms, onDone){
  target = Math.max(0, Math.min(1, target));
  const startVol = audio.volume;
  const delta = target - startVol;
  if (Math.abs(delta) < 0.005){ audio.volume = target; onDone && onDone(); return; }
  const start = performance.now();
  /** @param {number} now */
  function step(now){
    const t = Math.min(1, (now - start)/ms);
    audio.volume = startVol + delta * t;
    if (t < 1){ requestAnimationFrame(step); } else { onDone && onDone(); }
  }
  requestAnimationFrame(step);
}

/**
 * Запуск c fade-in
 * @param {HTMLAudioElement} a
 */
function playWithFadeIn(a){
  try { a.pause(); } catch {}
  try { a.currentTime = 0; } catch {}
  const originalTarget = 1.0;
  a.volume = 0.0;
  a.play().catch(()=>{});
  fadeVolume(a, originalTarget, 350);
}

/**
 * Остановка c fade-out
 * @param {HTMLAudioElement} a
 */
function stopWithFadeOut(a){
  fadeVolume(a, 0, 280, ()=>{ try { a.pause(); } catch {}; try { a.currentTime=0; } catch {}; });
}

function startOutgoingTone(){
  const email = (getStoredEmail() || '').toLowerCase();
  if (SPECIAL_RING_EMAILS.has(email)){
    // Спец-пользователь — используем специальный рингтон (переназначение смысла: теперь для исходящего)
    startSpecialRingtone();
    return;
  }
  const a = ensureGenericAudio('outcall');
  if (!a) return;
  try { if (hooks.unlockAudioPlayback) hooks.unlockAudioPlayback(); } catch {}
  try { playWithFadeIn(a); } catch {}
}

function startIncomingTone(){
  const a = ensureGenericAudio('incall');
  if (!a) return;
  try { if (hooks.unlockAudioPlayback) hooks.unlockAudioPlayback(); } catch {}
  try { playWithFadeIn(a); } catch {}
}

function stopGenericAudio(){
  for (const a of [genericOutcallAudio, genericIncallAudio]){
    if (!a) continue;
    try { stopWithFadeOut(a); } catch {}
  }
}

function stopCallTones(){
  stopSpecialRingtone();
  stopGenericAudio();
}

// Экспорт для тестов
export function __getCurrentOutcallAudio(){ return genericOutcallAudio; }
export function __getCurrentIncallAudio(){ return genericIncallAudio; }

// ===== Incoming Call Modal =====
/** @param {string} id */
function qs(id){ return /** @type {HTMLElement|null} */(document.getElementById(id)); }
let modalBound = false;
/** @type {any} */
let incomingAutoTimeout = null; // таймер авто-скрытия/отклонения входящего звонка
let swipeActive = false;
let swipeStartX = 0;
/** @type {HTMLElement|null} */
let swipeTarget = null; // текущая кнопка в жесте
const SWIPE_THRESHOLD = 110; // px
const SWIPE_CANCEL = 25; // если меньше этого при отпускании — откат

function ensureModalBindings(){
  if (modalBound) return;
  const acceptBtn = qs('btnCallAccept');
  const declineBtn = qs('btnCallDecline');
  // Унифицированный хелпер запуска действия по кнопке
  async function triggerAccept(){
    const c = appState.activeCall; if (!c) return;
    try {
      markCallAccepted(c.roomId);
      await acceptCall(c.withUserId, c.roomId).catch(()=>{});
      if (els.roomId && 'value' in els.roomId){ /** @type {any} */(els.roomId).value = c.roomId; }
      if (typeof hooks.unlockAudioPlayback === 'function') hooks.unlockAudioPlayback();
      if (typeof hooks.connectRoom === 'function') hooks.connectRoom();
    } catch {}
  }
  async function triggerDecline(){
    const c = appState.activeCall; if (!c) return;
    try { await declineCall(c.withUserId, c.roomId).catch(()=>{}); } catch {}
    markCallDeclined(c.roomId);
  }
  if (acceptBtn){
    acceptBtn.addEventListener('click', triggerAccept);
  }
  if (declineBtn){
    declineBtn.addEventListener('click', triggerDecline);
  }
  // Swipe (pointer) жесты
  const container = qs('incomingCallModal');
  if (container){
    container.addEventListener('pointerdown', (e)=>{
      const t = /** @type {HTMLElement} */(e.target);
      if (!t) return;
      if (t.id === 'btnCallAccept' || t.id === 'btnCallDecline'){
        swipeActive = true; swipeStartX = e.clientX; swipeTarget = t; t.setPointerCapture?.(e.pointerId);
        t.style.transition = 'none';
      }
    });
    container.addEventListener('pointermove', (e)=>{
      if (!swipeActive || !swipeTarget) return;
      const dx = e.clientX - swipeStartX;
      // Принимаем направление: accept — свайп вправо, decline — свайп влево
      if (swipeTarget.id === 'btnCallAccept' && dx > 0){
        swipeTarget.style.transform = `translateX(${dx}px)`;
      } else if (swipeTarget.id === 'btnCallDecline' && dx < 0){
        swipeTarget.style.transform = `translateX(${dx}px)`;
      }
      // Подсветка и прозрачность
      const abs = Math.abs(dx);
      const frac = Math.min(1, abs / SWIPE_THRESHOLD);
      swipeTarget.style.opacity = String(0.55 + 0.45 * frac);
      if (frac >= 1){ swipeTarget.classList.add('swipe-armed'); }
      else { swipeTarget.classList.remove('swipe-armed'); }
    });
  /**
   * Завершение жеста
   * @param {boolean} commit
   */
  const finishSwipe = (commit)=>{
      if (!swipeTarget) { swipeActive=false; return; }
      const t = swipeTarget;
      const dx = (parseFloat(t.style.transform.replace(/[^-0-9.]/g,'')||'0')) || 0;
      const isAccept = t.id === 'btnCallAccept';
      const passed = isAccept ? dx > SWIPE_THRESHOLD : dx < -SWIPE_THRESHOLD;
      t.style.transition = 'transform 160ms ease';
      if (commit && passed){
        t.style.transform = `translateX(${isAccept?SWIPE_THRESHOLD:-SWIPE_THRESHOLD}px)`;
        setTimeout(()=>{ isAccept ? triggerAccept() : triggerDecline(); }, 150);
      } else {
        // если малый dx — откат
        if (Math.abs(dx) < SWIPE_CANCEL){ t.style.transform = 'translateX(0px)'; }
        else { t.style.transform = 'translateX(0px)'; }
      }
      // Сброс визуальных атрибутов
      if (t){
        setTimeout(()=>{ try { t.classList.remove('swipe-armed'); t.style.opacity=''; t.style.transform=''; t.style.transition=''; } catch {} }, 170);
      }
      swipeActive = false; swipeTarget = null; swipeStartX = 0;
    };
    container.addEventListener('pointerup', ()=> finishSwipe(true));
    container.addEventListener('pointercancel', ()=> finishSwipe(false));
    container.addEventListener('pointerleave', ()=> finishSwipe(false));
  }
  modalBound = true;
}

/** @param {string} label @param {string} roomId @param {string} fromUserId */
function showIncomingCallModal(label, roomId, fromUserId){
  ensureModalBindings();
  const m = qs('incomingCallModal'); if (!m) return;
  const sub = qs('incomingCallFrom'); if (sub) sub.textContent = label;
  m.style.display = '';
  // Авто-таймаут: если за 45с не ответили — отклоняем локально.
  if (incomingAutoTimeout){ try { clearTimeout(incomingAutoTimeout); } catch {} }
  incomingAutoTimeout = setTimeout(()=>{
    try {
      const c = appState.activeCall;
      if (c && c.direction==='incoming' && c.status==='invited' && c.roomId===roomId){
        markCallDeclined(roomId);
      }
    } catch {}
  }, 45000);
}
function hideIncomingCallModal(){
  const m = qs('incomingCallModal'); if (m) m.style.display='none';
  if (incomingAutoTimeout){ try { clearTimeout(incomingAutoTimeout); } catch {}; incomingAutoTimeout=null; }
}

export function startSpecialRingtone(){
  const s = appState.special;
  s.active = true;
  // Цикличное (бесконечное) воспроизведение: убрали авто-остановку через 60с.
  if (s.timer) { try { clearTimeout(s.timer); } catch {}; s.timer=null; }
  if (!appState.userGestureHappened){
    // Откладываем до user gesture
    if (!appState.pendingAutoplayTasks.some(fn => /** @type {any} */(fn)?.__ring)){
      const runner = ()=>{ try{ const c=appState.activeCall; if (c && c.direction==='incoming' && c.status==='invited'){ startSpecialRingtone(); } }catch{} };
      /** @type {any} */(runner).__ring = true;
      appState.pendingAutoplayTasks.push(runner);
    }
    return;
  }
  if (hooks.unlockAudioPlayback) { try { hooks.unlockAudioPlayback(); } catch {} }
  s.session += 1; const mySession = s.session;
  ensureSpecialRingtone().then(audio => {
    if (mySession !== s.session) return;
    if (!audio) return;
    const START_AT = 1;
    const startPlayback = ()=>{
      if (!s.active || s.playing) return;
      s.playing = true;
      try { audio.volume = 0.0; } catch {}
      audio.play().catch(()=>{
        setTimeout(()=>{ if (s.active && !s.playing) audio.play().catch(()=>{}); }, 300);
      });
      // Плавное нарастание
      fadeVolume(audio, 1.0, 400);
    };
    const seekAndStart = ()=>{
      const onSeeked = ()=>{ try{ audio.removeEventListener('seeked', onSeeked);}catch{}; if (mySession===s.session) startPlayback(); };
      audio.addEventListener('seeked', onSeeked, { once:true });
      try { audio.currentTime = START_AT; } catch {}
      try { if (Math.abs((audio.currentTime||0)-START_AT) < 0.5){ audio.removeEventListener('seeked', onSeeked); if (mySession===s.session) startPlayback(); } } catch {}
    };
    if (audio.readyState >= 1) seekAndStart(); else { audio.addEventListener('loadedmetadata', seekAndStart, { once:true }); try { audio.load?.(); } catch {} }
  });
}

export function stopSpecialRingtone(){
  const s = appState.special;
  s.active = false; s.playing = false; s.session += 1;
  if (s.ringtone){
    const r = s.ringtone;
    // Плавное затухание
    try {
      fadeVolume(r, 0, 320, ()=>{ try { r.pause(); } catch {}; try { r.currentTime=0; } catch {}; });
    } catch {
      try { r.pause(); } catch {}
      try { r.currentTime = 0; } catch {}
    }
    // Не изменяем loop, пусть остаётся true — при следующем старте повтор сразу продолжится.
    if (isMobileBrowser){
      try { s.ringtone.removeAttribute && s.ringtone.removeAttribute('src'); } catch {}
      try { s.ringtone.src=''; } catch {}
      try { s.ringtone.load?.(); } catch {}
      s.ringtone = null; s.readyPromise = null;
    }
  }
  if (s.timer){ try { clearTimeout(s.timer); } catch {}; s.timer = null; }
}
