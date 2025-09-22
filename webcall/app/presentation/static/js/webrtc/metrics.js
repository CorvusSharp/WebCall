// metrics.js — сбор локальных видео метрик и анализ аудио уровня пиров

export class MetricsManager {
  constructor({ logger }){
    this._log = logger || (()=>{});
    this._videoTimer = null;
    this._metrics = { fps:0, width:0, height:0 };
    this._getCurrentTracks = null; // ()=> ({ cameraTrack, screenTrack, kind })
  }
  bindEnvironment({ getTracks }){ this._getCurrentTracks = getTracks; }
  ensureLoop(){ if (!this._videoTimer) this._start(); }
  stopLoop(){ if (this._videoTimer){ clearInterval(this._videoTimer); this._videoTimer=null; this._updateDom(null); } }
  _start(){
    const update = ()=>{
      try {
        const { cameraTrack, screenTrack, kind } = this._getCurrentTracks?.() || {};
        const track = screenTrack || cameraTrack;
        if (!track || track.readyState!=='live'){ this.stopLoop(); return; }
        let st = {}; try { st = track.getSettings? track.getSettings():{}; } catch{}
        this._metrics.width = st.width || this._metrics.width;
        this._metrics.height = st.height || this._metrics.height;
        this._metrics.fps = st.frameRate ? Math.round(st.frameRate) : this._metrics.fps;
        this._updateDom(kind);
      } catch{}
    };
    this._videoTimer = setInterval(update, 1000);
    update();
  }
  _updateDom(kind){
    const el = document.getElementById('localVideoMetrics');
    if (!el) return;
    if (!kind){ el.style.display='none'; el.textContent='—'; return; }
    el.style.display='';
    el.textContent = `${kind} ${this._metrics.width||'?'}x${this._metrics.height||'?'} @${this._metrics.fps||0}fps`;
  }
}

export class AudioLevelAnalyzer {
  constructor({ logger }){
    this._log = logger || (()=>{});
  }
  attach(peerState, peerId){
    try {
      if (!window.AudioContext || !peerState.stream?.getAudioTracks().length) return;
      if (peerState.level?.raf) cancelAnimationFrame(peerState.level.raf);
      peerState.level = peerState.level || {};
      peerState.level.ctx = new AudioContext();
      const src = peerState.level.ctx.createMediaStreamSource(peerState.stream);
      peerState.level.analyser = peerState.level.ctx.createAnalyser();
      peerState.level.analyser.fftSize = 256;
      src.connect(peerState.level.analyser);
      const data = new Uint8Array(peerState.level.analyser.frequencyBinCount);
      const loop = ()=>{
        peerState.level.analyser.getByteTimeDomainData(data);
        let sum=0; for (let i=0;i<data.length;i++){ const v=(data[i]-128)/128; sum+=v*v; }
        const rms = Math.sqrt(sum/data.length);
        if (peerState.handlers?.onLevel) peerState.handlers.onLevel(rms);
        peerState.level.raf = requestAnimationFrame(loop);
      };
      peerState.level.raf = requestAnimationFrame(loop);
      this._log(`Настроен аудио анализатор для ${peerId.slice(0,8)}`);
    } catch(e){ this._log(`level[${peerId.slice(0,8)}]: ${e?.name||e}`); }
  }
}
