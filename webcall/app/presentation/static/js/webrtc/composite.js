// composite.js — отвечает за композицию локального видео (камера + экран) в canvas

export class CanvasCompositeManager {
  constructor({ logger }){
    this._log = logger || (()=>{});
    this._enabled = false;
    this._canvas = null;
    this._raf = null;
    this._getTracks = null; // () => { screenTrack, camTrack }
  }
  bindEnvironment({ getTracks }){ this._getTracks = getTracks; }

  enable(canvas){
    try {
      if (!canvas) return false;
      this._canvas = canvas;
      this._enabled = true;
      canvas.style.display = '';
      this._loop();
      this._log('Composite canvas enabled');
      return true;
    } catch(e){ this._log('enableComposite error: '+(e?.name||e)); return false; }
  }
  disable(){
    this._enabled = false;
    if (this._raf) cancelAnimationFrame(this._raf); this._raf=null;
    if (this._canvas){ this._canvas.getContext('2d')?.clearRect(0,0,this._canvas.width,this._canvas.height); this._canvas.style.display='none'; }
    this._log('Composite canvas disabled');
  }
  toggle(canvas){ if (this._enabled) this.disable(); else this.enable(canvas||this._canvas); }
  isEnabled(){ return this._enabled; }
  currentCanvas(){ return this._canvas; }

  _loop(){
    if (!this._enabled || !this._canvas){ return; }
    const ctx = this._canvas.getContext('2d'); if (!ctx){ return; }
    const { screenTrack, camTrack } = (this._getTracks?.() || {});
    const W = this._canvas.width; const H = this._canvas.height;
    ctx.fillStyle = '#000'; ctx.fillRect(0,0,W,H);
    const drawTrack = (track, dx,dy,dw,dh)=>{
      try {
        const el = track._wcOffscreenEl || (track._wcOffscreenEl = document.createElement('video'));
        if (!el.srcObject){ const ms = new MediaStream([track]); el.srcObject = ms; el.muted=true; el.playsInline=true; el.autoplay=true; el.play().catch(()=>{}); }
        if (el.readyState >= 2){ ctx.drawImage(el, dx,dy,dw,dh); }
      } catch {}
    };
    if (screenTrack){
      drawTrack(screenTrack, 0,0,W,H);
      if (camTrack){
        const pipW = Math.round(W*0.22); const pipH = Math.round(pipW*(9/16));
        drawTrack(camTrack, W-pipW-24, H-pipH-24, pipW, pipH);
        ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 3; ctx.strokeRect(W-pipW-24+1.5, H-pipH-24+1.5, pipW-3, pipH-3);
      }
    } else if (camTrack){
      drawTrack(camTrack, 0,0,W,H);
    } else {
      this.disable();
      return;
    }
    this._raf = requestAnimationFrame(()=> this._loop());
  }
}
