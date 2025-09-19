// core/event_bus.js
// Лёгкая внутренняя шина событий поверх window.dispatchEvent.
// Унифицирует имена и даёт удобные on/off/once/waitFor + JSDoc типы.

/**
 * Префикс всех внутренних событий. Стараемся придерживаться пространства имён 'wc:'.
 * Сами имена без префикса передаём в on/emit: emit('join-room').
 */
const PREFIX = 'wc:';
const target = window;

/**
 * @typedef {(
 *  | 'join-room'
 *  | 'rtc-ready'
 *  | 'stats:sample'
 * )} BusEventName
 *
 * Дополняй список по мере появления новых доменных событий.
 */

/**
 * @template T
 * @param {string} name
 * @param {T} [detail]
 */
export function emit(name, detail){
  const evName = name.startsWith(PREFIX) ? name : PREFIX + name;
  target.dispatchEvent(new CustomEvent(evName, { detail }));
}

/**
 * @template T
 * @param {string} name
 * @param {(detail: T, ev: CustomEvent)=>void} handler
 * @param {AddEventListenerOptions | boolean} [opts]
 * @returns {() => void} off fn
 */
export function on(name, handler, opts){
  const evName = name.startsWith(PREFIX) ? name : PREFIX + name;
  const wrap = (e)=>{ try { handler(e.detail, e); } catch {} };
  target.addEventListener(evName, wrap, opts);
  return ()=> off(name, wrap, opts);
}

/**
 * Одноразовый обработчик.
 * @template T
 * @param {string} name
 * @param {(detail: T, ev: CustomEvent)=>void} handler
 * @returns {() => void} off fn (досрочно отменить)
 */
export function once(name, handler){
  let offFn = on(name, (d,e)=>{ offFn && offFn(); handler(d,e); }, { once:true });
  return offFn;
}

/**
 * @param {string} name
 * @param {EventListenerOrEventListenerObject} handler
 * @param {EventListenerOptions | boolean} [opts]
 */
export function off(name, handler, opts){
  const evName = name.startsWith(PREFIX) ? name : PREFIX + name;
  try { target.removeEventListener(evName, handler, opts); } catch {}
}

/**
 * Promise-утилита: ждём событие (или таймаут).
 * @template T
 * @param {string} name
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
export function waitFor(name, timeoutMs){
  return new Promise((resolve, reject)=>{
    let timer = null;
    const offFn = once(name, (d)=>{ if (timer) clearTimeout(timer); resolve(d); });
    if (timeoutMs){ timer = setTimeout(()=>{ offFn(); reject(new Error('waitFor timeout: '+name)); }, timeoutMs); }
  });
}

export const bus = { emit, on, once, off, waitFor };
