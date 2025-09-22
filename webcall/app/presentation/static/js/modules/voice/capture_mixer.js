// capture_mixer.js
// Смешивает локальный и удалённые аудиотреки в один MediaStream и выдаёт WebM Opus чанки через callback

export class VoiceCaptureMixer {
  constructor(opts){
    this.getPeers = opts.getPeers; // функция возвращающая appState.rtc.peers (Map)
    this.getLocalStream = opts.getLocalStream; // функция -> MediaStream | null
    this.onChunk = opts.onChunk; // (Uint8Array, meta) => void
    this.onLog = opts.onLog || (()=>{});
    this.chunkMs = opts.chunkMs || 5000;
    this.enabled = false;
    this._rec = null;
    this._ctx = null;
    this._dest = null;
    this._lastTracksKey = '';
    this._rebuildInterval = null;
  }

  start(){
    if (this.enabled) return;
    this.enabled = true;
    this.onLog('VoiceMixer: start');
    this._ensureContext();
    this._rebuildGraph();
    this._rec = new MediaRecorder(this._dest.stream, { mimeType: 'audio/webm;codecs=opus' });
    this._rec.ondataavailable = (ev)=>{
      if (!ev.data || !ev.data.size) return;
      ev.data.arrayBuffer().then(buf => {
        if (!this.enabled) return; 
        this.onChunk(new Uint8Array(buf), { ts: Date.now() });
      }).catch(()=>{});
    };
    this._rec.start(this.chunkMs);
    this._rebuildInterval = setInterval(()=>{ try { this._rebuildGraph(); } catch {} }, 4000);
  }

  stop(){
    this.enabled = false;
    this.onLog('VoiceMixer: stop');
    try { if (this._rebuildInterval) clearInterval(this._rebuildInterval); } catch {}
    this._rebuildInterval = null;
    try { this._rec && this._rec.state !== 'inactive' && this._rec.stop(); } catch {}
    this._rec = null;
    try { this._ctx && this._ctx.close(); } catch {}
    this._ctx = null; this._dest = null;
  }

  _ensureContext(){
    if (this._ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this._ctx = new Ctx();
    this._dest = this._ctx.createMediaStreamDestination();
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
    // Пересоздаём контекст (проще для MVP, т.к. отсоединять ноды не всегда корректно)
    try { this._ctx && this._ctx.close(); } catch {}
    this._ensureContext();
    for (const tr of tracks){
      try {
        const src = this._ctx.createMediaStreamSource(new MediaStream([tr]));
        src.connect(this._dest);
      } catch {}
    }
  }
}
