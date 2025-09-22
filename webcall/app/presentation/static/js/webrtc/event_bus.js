// event_bus.js
// Простой шина событий без внешних зависимостей.
// API: on(event, handler), off(event, handler), once(event, handler), emit(event, payload)

export class EventBus {
  constructor(logger){ this._handlers = new Map(); this._logger = logger || (()=>{}); }
  on(evt, fn){ if(!this._handlers.has(evt)) this._handlers.set(evt, new Set()); this._handlers.get(evt).add(fn); return ()=> this.off(evt, fn); }
  once(evt, fn){ const wrap = (p)=>{ try{ fn(p); } finally { this.off(evt, wrap); } }; return this.on(evt, wrap); }
  off(evt, fn){ const s = this._handlers.get(evt); if(!s) return; s.delete(fn); if(!s.size) this._handlers.delete(evt); }
  emit(evt, payload){ const s = this._handlers.get(evt); if(!s) return; for(const fn of [...s]){ try{ fn(payload); } catch(e){ this._logger('EventBus handler error '+(e?.message||e)); } } }
  clear(){ this._handlers.clear(); }
}

// Список рекомендуемых событий:
// peer:state      { peerId, key, value }
// video:state     { kind, track }
// metrics:video   { peerId?, fps, width, height }
// audio:level     { peerId, rms }
// negotiation     { peerId, type }
// diagnostics:audio { result }
// diagnostics:video { result }
