// call_audio.js — генерация простых рингтонов через Web Audio API
// incoming: две короткие посылки 440 Гц; outgoing: одиночный треугольный импульс 620 Гц

let audioCtx = null;
function getCtx(){
  if (!audioCtx){
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
  }
  return audioCtx;
}

let incomingOsc = [];
let outgoingOsc = [];
let incomingTimer = null;
let outgoingTimer = null;

function stopGroup(arr, kind){
  for (const o of arr){ try { o.stop(); } catch {} }
  arr.length = 0;
  if (kind==='in' && incomingTimer){ clearInterval(incomingTimer); incomingTimer=null; }
  if (kind==='out' && outgoingTimer){ clearInterval(outgoingTimer); outgoingTimer=null; }
}

export function stopAllRings(){
  stopGroup(incomingOsc,'in');
  stopGroup(outgoingOsc,'out');
}

export function startIncomingRing(){
  if (incomingTimer || incomingOsc.length) return;
  const ctx = getCtx(); if (!ctx) return;
  const pattern = ()=>{
    for (let i=0;i<2;i++){
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type='sine';
      osc.frequency.value = 440;
      const t0 = ctx.currentTime + i*0.55;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.25, t0+0.05);
      gain.gain.linearRampToValueAtTime(0, t0+0.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0+0.55);
      incomingOsc.push(osc);
    }
  };
  pattern();
  incomingTimer = setInterval(()=>{ cleanup(incomingOsc); pattern(); }, 2000);
}

export function startOutgoingRing(){
  if (outgoingTimer || outgoingOsc.length) return;
  const ctx = getCtx(); if (!ctx) return;
  const pattern = ()=>{
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type='triangle';
    osc.frequency.value = 620;
    const t0 = ctx.currentTime;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.22, t0+0.05);
    gain.gain.linearRampToValueAtTime(0, t0+0.55);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0+0.6);
    outgoingOsc.push(osc);
  };
  pattern();
  outgoingTimer = setInterval(()=>{ cleanup(outgoingOsc); pattern(); }, 1500);
}

function cleanup(arr){
  if (arr.length > 50) arr.splice(0); // периодическая очистка для безопасности
}

export function resumeAudio(){
  const c = getCtx();
  if (c && c.state === 'suspended'){ c.resume().catch(()=>{}); }
}
