// capture_mixer.js
// Смешивает локальный и удалённые аудиотреки в один MediaStream и выдаёт WebM Opus чанки через callback

export class VoiceCaptureMixer {
  constructor(opts){
    this.getPeers = opts.getPeers; // функция возвращающая appState.rtc.peers (Map)
    this.getLocalStream = opts.getLocalStream; // функция -> MediaStream | null
    this.onChunk = opts.onChunk; // (Uint8Array, meta) => void
    this.onLog = opts.onLog || (()=>{});
    this.chunkMs = opts.chunkMs || 5000;
    this.initialChunkMs = Math.min(2000, this.chunkMs); // более быстрый первый чанк для снижения латентности
    this.enabled = false;
    this._rec = null;
    this._ctx = null;
    this._dest = null;
    this._lastTracksKey = '';
    this._rebuildInterval = null;
    this._sources = [];
    this._closing = false;
    this._startTs = 0;
    this._initialTimer = null;
    this._waitingForTrack = false;
  }

  start(){
    if (this.enabled) return;
    this.enabled = true;
    this.onLog('VoiceMixer: start');
    this._startTs = Date.now();
    this._ensureContext();
    // Отложенный запуск, если ещё нет ни одного активного трека (частая причина пустой первой сессии)
    const hasAnyLiveTrack = () => {
      try {
        const local = this.getLocalStream?.();
        if (local && local.getAudioTracks().some(t=> t.readyState==='live' && t.enabled)) return true;
        const peers = this.getPeers?.();
        if (peers){
          for (const [, st] of peers.entries()){
            const ms = st.remoteStream; if (ms && ms.getAudioTracks().some(t=> t.readyState==='live' && t.enabled)) return true;
          }
        }
      } catch {}
      return false;
    };
    if (!hasAnyLiveTrack()){
      this._waitingForTrack = true;
      let attempts = 0;
      const maxAttempts = 20; // ~2s (20 * 100ms)
      const poll = () => {
        if (!this.enabled) return;
        if (hasAnyLiveTrack()){
          this._waitingForTrack = false;
          this.onLog(`VoiceMixer: обнаружен первый трек спустя ${Date.now()-this._startTs}ms`);
          this._finishStart();
          return;
        }
        attempts++;
        if (attempts >= maxAttempts){
          this._waitingForTrack = false;
          this.onLog('VoiceMixer: нет треков через 2s — стартуем пустой поток (может быть тишина)');
          this._finishStart();
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
    } else {
      this._finishStart();
    }
  }

  stop(){
    this.enabled = false;
    this.onLog('VoiceMixer: stop');
    try { if (this._initialTimer){ clearTimeout(this._initialTimer); } } catch {}
    this._initialTimer = null;
    try { if (this._rebuildInterval) clearInterval(this._rebuildInterval); } catch {}
    this._rebuildInterval = null;
    try {
      if (this._rec && this._rec.state === 'recording'){
        // Принудительно запрашиваем финальный буфер до stop для более надёжного последнего чанка
        try { this._rec.requestData(); } catch {}
        this._rec.stop();
      }
    } catch {}
    this._rec = null;
    // Отвязываем источники
    try { this._sources.forEach(src=>{ try { src.disconnect(); } catch {} }); } catch {}
    this._sources = [];
    // Закрываем аудио-контекст один раз
    if (this._ctx && !this._closing && this._ctx.state !== 'closed'){
      this._closing = true;
      try { this._ctx.close().catch(()=>{}).finally(()=>{ this._ctx=null; this._dest=null; this._closing=false; }); } catch { this._closing=false; this._ctx=null; this._dest=null; }
    } else {
      this._ctx = null; this._dest = null;
    }
  }

  _ensureContext(){
    if (this._ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this._ctx = new Ctx();
    this._dest = this._ctx.createMediaStreamDestination();
  }

  _finishStart(){
    if (!this.enabled) return;
    this._rebuildGraph();
    try {
      this._rec = new MediaRecorder(this._dest.stream, { mimeType: 'audio/webm;codecs=opus' });
    } catch(e){
      this.onLog('VoiceMixer: MediaRecorder error '+e);
      return;
    }
    this._rec.ondataavailable = (ev)=>{
      if (!ev.data || !ev.data.size) return;
      ev.data.arrayBuffer().then(buf => {
        if (!this.enabled) return; 
        this.onChunk(new Uint8Array(buf), { ts: Date.now() });
      }).catch(()=>{});
    };
    // Первый чанк ускоренно
    try { this._rec.start(this.chunkMs); } catch(e){ this.onLog('VoiceMixer: start error '+e); }
    if (this.initialChunkMs < this.chunkMs){
      this._initialTimer = setTimeout(()=>{
        try {
          if (!this.enabled || !this._rec || this._rec.state !== 'recording') return;
          this.onLog('VoiceMixer: early requestData (initial)');
          this._rec.requestData();
        } catch {}
      }, this.initialChunkMs);
    }
    this._rebuildInterval = setInterval(()=>{ try { this._rebuildGraph(); } catch {} }, 4000);
  }

  _rebuildGraph(){
    if (!this._ctx || !this._dest) return;
    const local = this.getLocalStream?.();
    const peers = this.getPeers?.();
    const tracks = [];
    if (local){ local.getAudioTracks().forEach(t=>{ if (t.readyState==='live' && t.enabled) tracks.push(t); }); }
    if (peers){
      try {
        for (const [pid, st] of peers.entries()){
          const ms = st.remoteStream;
          if (ms){ ms.getAudioTracks().forEach(t=>{ if (t.readyState==='live' && t.enabled) tracks.push(t); }); }
        }
      } catch {}
    }
    const key = tracks.map(t=>t.id).sort().join('|');
    if (key === this._lastTracksKey) return; // нет изменений
    this.onLog(`VoiceMixer: update graph tracks=${tracks.length}`);
    this._lastTracksKey = key;
    // Отключаем старые
    try { this._sources.forEach(src=>{ try { src.disconnect(); } catch {} }); } catch {}
    this._sources = [];
    // Подключаем новые
    for (const tr of tracks){
      try {
        const ms = new MediaStream([tr]);
        const src = this._ctx.createMediaStreamSource(ms);
        src.connect(this._dest);
        this._sources.push(src);
      } catch(e){ this.onLog('VoiceMixer: source err '+e); }
    }
  }
}
