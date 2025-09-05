// webrtc.js — мультипир с Perfect Negotiation, без лишних m-lines и с ICE-restart
import { sendSignal } from "./signal.js";
import { getIceServers } from "./api.js";

/**
 * Опции:
 * - localVideo: HTMLVideoElement|null
 * - outputDeviceId?: string|null
 * - onLog?: (msg)=>void
 * - onPeerState?: (peerId, key, value)=>void
 */
export class WebRTCManager {
  constructor(opts){
    this.localVideo = opts.localVideo || null;
    this.outputDeviceId = opts.outputDeviceId || null;
    this.onLog = opts.onLog || (()=>{});
    this.onPeerState = opts.onPeerState || (()=>{});

    this.ws = null;
    this.userId = null;
    this.localStream = null;
    this.preferred = { micId: undefined, camId: undefined };
    this.iceConfig = null;

    // peerId -> { pc, stream, candidates:[], remoteSet, handlers, level:{ctx,analyser,raf},
    //             makingOffer, ignoreOffer, polite, iceFailTimer }
    this.peers = new Map();
  }

  _log(m){ try{ this.onLog(m); }catch{} }
  getOutputDeviceId(){ return this.outputDeviceId; }
  setPreferredDevices({ mic, cam, spk }){
    if (mic) this.preferred.micId = mic;
    if (cam) this.preferred.camId = cam;
    if (spk) this.outputDeviceId = spk;
  }

  async _getLocalMedia(){
    const baseAudio = {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      deviceId: this.preferred.micId ? { exact: this.preferred.micId } : undefined,
    };
    // по умолчанию — только аудио (меньше причин для renegotiation у всех)
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: baseAudio, video: false });
    } catch(e) {
      this._log(`getUserMedia audio failed: ${e?.name||e}`);
      // крайний случай — вообще без медиа
      return null;
    }
  }

  async init(ws, userId, { micId, camId } = {}){
    this.ws = ws;
    this.userId = userId;
    if (micId) this.preferred.micId = micId;
    if (camId) this.preferred.camId = camId;

    if (!this.iceConfig) {
      try { this.iceConfig = await getIceServers(); }
      catch { this.iceConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] }; }
    }

    if (this.localStream) return;

    const stream = await this._getLocalMedia();
    this.localStream = stream;
    if (stream && this.localVideo) this.localVideo.srcObject = stream;
  }

  _isPolite(myId, peerId){
    // polite — у кого строковый id больше; инициатор оффера — у кого меньше
    return String(myId) > String(peerId);
  }

  async _ensurePeer(peerId){
    if (this.peers.has(peerId)) return this.peers.get(peerId);

    const pc = new RTCPeerConnection({ ...this.iceConfig, bundlePolicy:"max-bundle", rtcpMuxPolicy:"require" });
    const state = {
      pc,
      stream: new MediaStream(),
      candidates: [],
      remoteSet: false,
      handlers: null,
      level: { ctx:null, analyser:null, raf:0 },
      makingOffer: false,
      ignoreOffer: false,
      polite: this._isPolite(this.userId, peerId),
      iceFailTimer: null,
    };

    // ЛОКАЛЬНЫЕ ТРЕКИ или RECVONLY — НО не одновременно!
    if (this.localStream && this.localStream.getTracks().length){
      for (const t of this.localStream.getTracks()) {
        try { pc.addTrack(t, this.localStream); } catch(e){ this._log(`addTrack: ${e}`); }
      }
    } else {
      try{ pc.addTransceiver("audio", { direction:"recvonly" }); }catch{}
      try{ pc.addTransceiver("video", { direction:"recvonly" }); }catch{}
    }

    pc.addEventListener("icecandidate", (e)=>{
      if (e.candidate) sendSignal(this.ws, "ice-candidate", { candidate: e.candidate }, this.userId, peerId);
    });

    pc.addEventListener("track", (e)=>{
      if (e.track && !state.stream.getTracks().some(t=>t.id===e.track.id)) state.stream.addTrack(e.track);
      if (state.handlers?.onTrack) state.handlers.onTrack(state.stream);
      if (e.track?.kind === 'audio') this._setupPeerLevel(peerId, state);
    });

    // renegotiation по событию
    pc.addEventListener("negotiationneeded", async ()=>{
      try{
        if (state.makingOffer) return;
        state.makingOffer = true;
        const offer = await pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
        await pc.setLocalDescription(offer);
        sendSignal(this.ws, 'offer', { sdp: offer.sdp }, this.userId, peerId);
      }catch(e){ this._log(`negotiationneeded(${peerId}): ${e?.name||e}`); }
      finally{ state.makingOffer = false; }
    });

    // ICE автолечебница
    pc.addEventListener("connectionstatechange", ()=>{
      const s = pc.connectionState;
      this.onPeerState(peerId, 'net', s);
      this._log(`PC(${peerId})=${s}`);
      if (s === 'failed'){
        this._iceRestart(peerId).catch(()=>{});
      } else if (s === 'disconnected'){
        clearTimeout(state.iceFailTimer);
        state.iceFailTimer = setTimeout(()=>{
          if (pc.connectionState === 'disconnected') this._iceRestart(peerId).catch(()=>{});
        }, 2000);
      } else if (s === 'connected' || s === 'completed'){
        clearTimeout(state.iceFailTimer);
        state.iceFailTimer = null;
      }
    });

    pc.addEventListener("iceconnectionstatechange", ()=>{ this._log(`ICE(${peerId})=${pc.iceConnectionState}`); });

    this.peers.set(peerId, state);
    return state;
  }

  async _iceRestart(peerId){
    const st = this.peers.get(peerId);
    if (!st) return;
    this._log(`ICE-restart → ${peerId}`);
    try{
      const offer = await st.pc.createOffer({ iceRestart:true });
      await st.pc.setLocalDescription(offer);
      sendSignal(this.ws, 'offer', { sdp: offer.sdp }, this.userId, peerId);
    }catch(e){ this._log(`ICE-restart(${peerId}): ${e?.name||e}`); }
  }

  // публичные хуки UI
  bindPeerMedia(peerId, handlers){ const st = this.peers.get(peerId); if (st) st.handlers = handlers; }
  getPeer(peerId){ return this.peers.get(peerId); }

  async handleSignal(msg, mediaBinder){
    if (msg?.fromUserId && this.userId && msg.fromUserId === this.userId) return;
    if (msg?.targetUserId && this.userId && msg.targetUserId !== this.userId) return;

    const peerId = msg.fromUserId;
    const peer = await this._ensurePeer(peerId);
    const pc = peer.pc;

    if (mediaBinder && !peer.handlers){
      mediaBinder(peerId, { onTrack:()=>{}, onLevel:()=>{} });
    }

    if (msg.signalType === 'offer'){
      await this.init(this.ws, this.userId);
      const desc = { type:'offer', sdp: msg.sdp };

      const offerCollision = peer.makingOffer || pc.signalingState !== "stable";
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) {
        this._log(`Ignore offer from ${peerId} (impolite collision)`);
        return;
      }

      try {
        if (offerCollision) await pc.setLocalDescription({ type:'rollback' });
        await pc.setRemoteDescription(desc);
        peer.remoteSet = true;
        await this._flushQueuedCandidates(peerId);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(this.ws, 'answer', { sdp: answer.sdp }, this.userId, peerId);
      } catch(e) {
        this._log(`SRD(offer)[${peerId}]: ${e?.name||e}`);
      }

    } else if (msg.signalType === 'answer'){
      if (pc.signalingState !== 'have-local-offer'){
        this._log(`Ignore answer in ${pc.signalingState}`);
        return;
      }
      try {
        await pc.setRemoteDescription({ type:'answer', sdp: msg.sdp });
        peer.remoteSet = true;
        await this._flushQueuedCandidates(peerId);
      } catch(e) {
        this._log(`SRD(answer)[${peerId}]: ${e?.name||e}`);
      }

    } else if (msg.signalType === 'ice-candidate'){
      if (!peer.remoteSet) peer.candidates.push(msg.candidate);
      else {
        try { await pc.addIceCandidate(msg.candidate); }
        catch(e){ this._log(`addIce[${peerId}]: ${e?.name||e}`); }
      }
    }
  }

  async _flushQueuedCandidates(peerId){
    const peer = this.peers.get(peerId);
    if (!peer?.pc) return;
    while (peer.candidates.length){
      const c = peer.candidates.shift();
      try { await peer.pc.addIceCandidate(c); }
      catch(e){ this._log(`flush ICE[${peerId}]: ${e?.name||e}`); }
    }
  }

  async startOffer(peerId){
    await this.init(this.ws, this.userId);
    const st = await this._ensurePeer(peerId);
    if (st.makingOffer) return;
    if (st.pc.signalingState !== 'stable'){
      this._log(`Skip startOffer(${peerId}) in ${st.pc.signalingState}`);
      return;
    }
    try{
      st.makingOffer = true;
      const offer = await st.pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
      await st.pc.setLocalDescription(offer);
      sendSignal(this.ws, 'offer', { sdp: offer.sdp }, this.userId, peerId);
    }catch(e){ this._log(`startOffer(${peerId}): ${e?.name||e}`); }
    finally{ st.makingOffer = false; }
  }

  toggleMic(){
    if (!this.localStream) return false;
    const tr = this.localStream.getAudioTracks()[0];
    if (!tr) return false;
    tr.enabled = !tr.enabled;
    return tr.enabled;
  }

  toggleCam(){
    if (!this.localStream) return false;
    let tr = this.localStream.getVideoTracks()[0];
    if (!tr){
      navigator.mediaDevices.getUserMedia({
        video: this.preferred.camId ? { deviceId: { exact: this.preferred.camId } } : true,
        audio: false
      }).then(s=>{
        const [vt] = s.getVideoTracks();
        if (!vt) return;
        this.localStream.addTrack(vt);
        if (this.localVideo){
          const ms = this.localVideo.srcObject instanceof MediaStream ? this.localVideo.srcObject : new MediaStream();
          ms.addTrack(vt); this.localVideo.srcObject = ms;
        }
        // negotiationneeded триггернется сам
      }).catch(e=> this._log(`Camera init: ${e?.name||e}`));
      return true;
    }
    tr.enabled = !tr.enabled;
    return tr.enabled;
  }

  async close(){
    try{ this.ws?.close(); }catch{}
    for (const [, st] of this.peers){
      try{ st.pc?.close(); }catch{}
      if (st.level?.raf) cancelAnimationFrame(st.level.raf);
      if (st.level?.ctx) try{ st.level.ctx.close(); }catch{}
      clearTimeout(st.iceFailTimer);
    }
    this.peers.clear();
    if (this.localStream) this.localStream.getTracks().forEach(t=>t.stop());
    this.localStream = null;
  }

  _setupPeerLevel(peerId, state){
    try{
      if (!window.AudioContext || !state.stream?.getAudioTracks().length) return;
      state.level.ctx = new AudioContext();
      const src = state.level.ctx.createMediaStreamSource(state.stream);
      state.level.analyser = state.level.ctx.createAnalyser();
      state.level.analyser.fftSize = 256;
      src.connect(state.level.analyser);
      const data = new Uint8Array(state.level.analyser.frequencyBinCount);
      const loop = ()=>{
        state.level.analyser.getByteTimeDomainData(data);
        let sum=0; for (let i=0;i<data.length;i++){ const v=(data[i]-128)/128; sum+=v*v; }
        const rms = Math.sqrt(sum/data.length);
        if (state.handlers?.onLevel) state.handlers.onLevel(rms);
        state.level.raf = requestAnimationFrame(loop);
      };
      if (state.level.raf) cancelAnimationFrame(state.level.raf);
      state.level.raf = requestAnimationFrame(loop);
    }catch(e){ this._log(`level[${peerId}]: ${e?.name||e}`); }
  }
}
