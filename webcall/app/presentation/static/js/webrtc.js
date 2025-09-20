// УПРОЩЁННАЯ / ПЕРЕПИСАННАЯ ЛОГИКА WebRTC (надёжный двусторонний видео‑звонок, одна камера на участника)
// Цели:
// 1. Исключить асимметрию «второй включивший камеру не виден».
// 2. Предсказуемый SDP: заранее добавляем audio+video transceiver (sendrecv) => всегда m=audio,m=video.
// 3. Perfect Negotiation паттерн (glare safe).
// 4. Минимум динамических addTrack: только replaceTrack на заранее созданном видеотранссивере.
// 5. Сохранён внешний API (частично) для совместимости: onVideoState(kind), toggleMic, toggleCameraStream, stopCamera, diagnose*.

import { sendSignal } from './signal.js';
import { getIceServers } from './api.js';

export class WebRTCManager {
  constructor(opts){
    this.localVideo = opts.localVideo || null;
    this.outputDeviceId = opts.outputDeviceId || null;
    this.onLog = opts.onLog || (()=>{});
    this.onPeerState = opts.onPeerState || (()=>{});
    this.onVideoState = opts.onVideoState || (()=>{});
    this.ws = null;
    this.userId = null;
    this.iceConfig = null;
    this.preferred = { micId: undefined, camId: undefined };
    this.localAudioStream = null;   // только аудио (микрофон)
    this.localVideoTrack = null;    // текущий видео‑трек камеры
    this.peers = new Map();         // peerId -> state
    this._currentVideoKind = 'none';
  }
  _log(m){ try { this.onLog(m); } catch {} }

  async _ensureIce(){
    if (this.iceConfig) return;
    try { this.iceConfig = await getIceServers(); }
    catch { this.iceConfig = { iceServers: [{ urls:'stun:stun.l.google.com:19302' }] }; }
  }

  async _ensureMic(){
    if (this.localAudioStream && this.localAudioStream.getAudioTracks().some(t=>t.readyState==='live')) return;
    try {
      const base = this.preferred.micId ? { deviceId: { exact: this.preferred.micId } } : true;
      this._log('🔐 Запрашиваем микрофон');
      this.localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: base, video:false });
      this._log('✅ Микрофон получен');
    } catch(e){ this._log('❌ Микрофон недоступен: '+(e?.name||e)); }
  }

  async init(ws, userId, { micId, camId }={}){
    this.ws = ws; this.userId = userId;
    if (micId) this.preferred.micId = micId;
    if (camId) this.preferred.camId = camId;
    await this._ensureIce();
    await this._ensureMic();
  }

  _isPolite(my, other){ return String(my) > String(other); }

  async _ensurePeer(peerId){
    if (this.peers.has(peerId)) return this.peers.get(peerId);
    await this._ensureMic();
    const pc = new RTCPeerConnection(this.iceConfig);
    const state = {
      pc,
      polite: this._isPolite(this.userId, peerId),
      makingOffer: false,
      ignoreOffer: false,
      pendingCandidates: [],
      stream: new MediaStream(),
      videoSender: null,
      audioSender: null,
      handlers: null,
      audioTrans: null,
      videoTrans: null,
    };

    // Предсоздаём transceivers (sendrecv) — гарант m=строк.
    try {
      state.audioTrans = pc.addTransceiver('audio', { direction:'sendrecv' });
      state.videoTrans = pc.addTransceiver('video', { direction:'sendrecv' });
      this._log(`➕ transceivers preset for ${peerId.slice(0,8)}`);
      // Привяжем локальный аудио трек если есть.
      const at = this.localAudioStream?.getAudioTracks?.()[0];
      if (at) await state.audioTrans.sender.replaceTrack(at);
    } catch(e){ this._log('transceiver preset error: '+(e?.name||e)); }

    pc.onicecandidate = (ev)=>{
      if (ev.candidate){
        sendSignal(this.ws, 'ice-candidate', { candidate: ev.candidate }, this.userId, peerId);
      }
    };
    pc.onconnectionstatechange = ()=> this._log(`PC(${peerId.slice(0,8)}) state=${pc.connectionState}`);
    pc.ontrack = (ev)=>{
      const track = ev.track;
      if (!state.stream.getTracks().some(t=> t.id===track.id)) state.stream.addTrack(track);
      if (state.handlers?.onTrack){ try { state.handlers.onTrack(state.stream); } catch{} }
    };
    pc.onnegotiationneeded = async ()=>{
      try {
        if (state.makingOffer) return;
        state.makingOffer = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal(this.ws,'offer',{ sdp: offer.sdp }, this.userId, peerId);
        this._log(`📤 offer → ${peerId.slice(0,8)}`);
      } catch(e){ this._log('offer err: '+(e?.name||e)); }
      finally { state.makingOffer=false; }
    };
    this.peers.set(peerId, state);
    return state;
  }

  bindPeerMedia(peerId, handlers){
    const st = this.peers.get(peerId); if (!st) return;
    st.handlers = { ...(st.handlers||{}), ...(handlers||{}) };
    if (st.stream.getTracks().length){ try { st.handlers.onTrack?.(st.stream); } catch{} }
  }

  async handleSignal(msg, mediaBinder){
    if (!msg || msg.fromUserId === this.userId) return;
    if (msg.targetUserId && msg.targetUserId !== this.userId) return;
    const peerId = msg.fromUserId;
    const st = await this._ensurePeer(peerId);
    const pc = st.pc;
    if (mediaBinder && !st.handlers) mediaBinder(peerId, { onTrack:()=>{} });

    if (msg.signalType === 'offer'){
      const offerDesc = { type:'offer', sdp: msg.sdp };
      const offerCollision = st.makingOffer || pc.signalingState !== 'stable';
      st.ignoreOffer = !st.polite && offerCollision;
      if (st.ignoreOffer){ this._log(`⏭️ glare ignore from ${peerId.slice(0,8)}`); return; }
      try {
        if (offerCollision) await pc.setLocalDescription({ type:'rollback' });
        await pc.setRemoteDescription(offerDesc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(this.ws,'answer',{ sdp: answer.sdp }, this.userId, peerId);
        this._log(`📤 answer → ${peerId.slice(0,8)}`);
      } catch(e){ this._log('answer err: '+(e?.name||e)); }
      // ICE candidates, пришедшие до SRD
      while (st.pendingCandidates.length){ const c=st.pendingCandidates.shift(); try { await pc.addIceCandidate(c); } catch{} }
    } else if (msg.signalType === 'answer'){
      if (pc.signalingState !== 'have-local-offer'){ this._log('late answer ignored'); return; }
      try { await pc.setRemoteDescription({ type:'answer', sdp: msg.sdp }); } catch(e){ this._log('SRD(answer) '+(e?.name||e)); }
    } else if (msg.signalType === 'ice-candidate' || msg.signalType === 'ice_candidate'){
      if (!pc || pc.signalingState === 'closed') return;
      if (!pc.remoteDescription){ st.pendingCandidates.push(msg.candidate); return; }
      try { await pc.addIceCandidate(msg.candidate); } catch(e){ this._log('addIce '+(e?.name||e)); }
    }
  }

  async _negotiateAll(){
    for (const [pid, st] of this.peers){
      const pc = st.pc;
      if (pc.signalingState !== 'stable') continue;
      try {
        st.makingOffer = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal(this.ws,'offer',{ sdp: offer.sdp }, this.userId, pid);
        this._log(`♻️ renegotiate → ${pid.slice(0,8)}`);
      } catch(e){ this._log('renegotiate err: '+(e?.name||e)); }
      finally { st.makingOffer=false; }
    }
  }

  async startOffer(peerId){
    const st = await this._ensurePeer(peerId);
    if (st.polite) return; // только "невежливый" инициирует первично
    if (st.pc.signalingState !== 'stable') return;
    try {
      st.makingOffer = true;
      const offer = await st.pc.createOffer();
      await st.pc.setLocalDescription(offer);
      sendSignal(this.ws,'offer',{ sdp: offer.sdp }, this.userId, peerId);
      this._log(`📤 initial offer → ${peerId.slice(0,8)}`);
    } catch(e){ this._log('init offer err '+(e?.name||e)); }
    finally { st.makingOffer=false; }
  }

  async toggleMic(){
    await this._ensureMic();
    const tr = this.localAudioStream?.getAudioTracks?.()[0];
    if (!tr){ this._log('no audio track'); return false; }
    tr.enabled = !tr.enabled;
    this._log('Mic '+(tr.enabled?'ON':'OFF'));
    return tr.enabled;
  }

  async startCamera(){
    if (this.localVideoTrack && this.localVideoTrack.readyState==='live'){ this._log('Камера уже активна'); return true; }
    try {
      const base = this.preferred.camId ? { deviceId:{ exact:this.preferred.camId }, width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:24,max:30} } : { width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:24,max:30} };
      const gum = await navigator.mediaDevices.getUserMedia({ video: base, audio:false });
      const vt = gum.getVideoTracks()[0]; if (!vt){ this._log('Нет видеотрека'); return false; }
      this.localVideoTrack = vt;
      this._attachLocalVideo();
      this._currentVideoKind = 'camera';
      this.onVideoState('camera', vt);
      this._log('🎥 Камера запущена');
      // renegotiate если уже есть соединения
      await this._negotiateAll();
      return true;
    } catch(e){ this._log('startCamera '+(e?.name||e)); return false; }
  }

  _attachLocalVideo(){
    if (this.localVideoTrack && this.localVideo){ try { this.localVideo.srcObject = new MediaStream([this.localVideoTrack]); this.localVideo.play?.(); } catch{} }
    for (const [, st] of this.peers){
      try {
        if (!st.videoTrans) continue;
        st.videoTrans.sender.replaceTrack(this.localVideoTrack).catch(()=>{});
      } catch{}
    }
  }

  stopCamera(){
    if (!this.localVideoTrack) return;
    try { this.localVideoTrack.stop(); } catch{}
    for (const [, st] of this.peers){ try { st.videoTrans?.sender.replaceTrack(null); } catch{} }
    this.localVideoTrack = null;
    if (this.localVideo){ try { this.localVideo.srcObject=null; this.localVideo.load?.(); } catch{} }
    this._currentVideoKind='none';
    this.onVideoState('none', null);
    this._log('🛑 Камера остановлена');
    // Можно не делать полную renegotiation — sender остаётся, просто без трека.
  }

  async toggleCameraStream(){
    if (this.localVideoTrack) { this.stopCamera(); return false; }
    return await this.startCamera();
  }

  // Заглушки для совместимости UI (screen share не реализуем здесь)
  async startScreenShare(){ this._log('screen share disabled (simplified)'); return false; }
  async toggleScreenShare(){ this._log('screen share disabled'); return false; }
  stopScreenShare(){}
  switchScreenShareWindow(){}
  switchCamera(){ this._log('switchCamera simplified: перезапускайте startCamera с другим deviceId через preferred.camId'); }

  async close(){
    for (const [, st] of this.peers){ try { st.pc.onicecandidate=null; st.pc.close(); } catch{} }
    this.peers.clear();
    try { this.localAudioStream?.getTracks().forEach(t=>t.stop()); } catch{}
    try { this.localVideoTrack?.stop(); } catch{}
    if (this.localVideo){ try { this.localVideo.srcObject=null; } catch{} }
    this.localAudioStream=null; this.localVideoTrack=null;
    this._currentVideoKind='none';
    this._log('Closed all peers');
  }

  // Простая диагностика
  async diagnoseVideo(){
    this._log('=== VIDEO DIAG ===');
    this._log(`localTrack=${this.localVideoTrack?this.localVideoTrack.id:'none'} ready=${this.localVideoTrack?.readyState}`);
    for (const [pid, st] of this.peers){
      const pc = st.pc;
      this._log(`Peer ${pid.slice(0,8)} state=${pc.connectionState} sign=${pc.signalingState}`);
      const trans = pc.getTransceivers().filter(t=> t.receiver?.track?.kind==='video' || t.sender?.track?.kind==='video');
      trans.forEach(t=> this._log(` mid=${t.mid} dir=${t.direction} cur=${t.currentDirection} send=${t.sender?.track?.id||'-'} recv=${t.receiver?.track?.id||'-'}`));
    }
    this._log('=== END VIDEO DIAG ===');
  }
  async diagnoseAudio(){ this._log('audio tracks='+ (this.localAudioStream?.getAudioTracks()?.length||0)); }
}