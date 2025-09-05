// webrtc.js — мультипир без единого remoteVideo
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
    this.peers = new Map(); // peerId -> { pc, stream, candidates:[], remoteSet:bool, handlers, level:{ctx,analyser,raf} }
  }

  _log(m){ try{ this.onLog(m); }catch{} }
  getOutputDeviceId(){ return this.outputDeviceId; }
  setPreferredDevices({ mic, cam, spk }){
    if (mic) this.preferred.micId = mic;
    if (cam) this.preferred.camId = cam;
    if (spk) this.outputDeviceId = spk;
  }

  async _getLocalMedia(){
    const tryGet = async (constraints) => {
      try { return await navigator.mediaDevices.getUserMedia(constraints); }
      catch(e){ this._log(`getUserMedia: ${e?.name||e}`); return null; }
    };
    // по умолчанию — только аудио
    const a = await tryGet({
      audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        deviceId: this.preferred.micId ? { exact: this.preferred.micId } : undefined,
      },
      video: false
    });
    if (a) return a;

    // fallback — только видео (если нет микрофона)
    const v = await tryGet({
      audio: false,
      video: { deviceId: this.preferred.camId ? { exact: this.preferred.camId } : undefined }
    });
    return v;
  }

  async init(ws, userId, { micId, camId } = {}){
    this.ws = ws;
    this.userId = userId;
    if (micId) this.preferred.micId = micId;
    if (camId) this.preferred.camId = camId;

    if (this.localStream) return;

    // ICE servers
    const fallback = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };
    let rtcCfg = fallback;
    try { const { iceServers } = await getIceServers(); rtcCfg = { iceServers }; }
    catch { rtcCfg = fallback; }

    // Локальные медиа
    const stream = await this._getLocalMedia();
    this.localStream = stream;
    if (stream && this.localVideo){
      this.localVideo.srcObject = stream;
    }
  }

  async _ensurePeer(peerId){
    if (this.peers.has(peerId)) return this.peers.get(peerId);

    // ICE servers
    const fallback = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };
    let rtcCfg = fallback;
    try { const { iceServers } = await getIceServers(); rtcCfg = { iceServers }; }
    catch { rtcCfg = fallback; }

    const pc = new RTCPeerConnection({ ...rtcCfg, bundlePolicy:"max-bundle", rtcpMuxPolicy:"require" });
    const state = { pc, stream:new MediaStream(), candidates:[], remoteSet:false, handlers:null, level:{ctx:null, analyser:null, raf:0} };

    // локальные треки
    if (this.localStream){
      for (const t of this.localStream.getTracks()) pc.addTrack(t, this.localStream);
    } else {
      try{ pc.addTransceiver("audio", { direction:"recvonly" }); }catch{}
      try{ pc.addTransceiver("video", { direction:"recvonly" }); }catch{}
    }

    pc.addEventListener("icecandidate", (e)=>{
      if (e.candidate) sendSignal(this.ws, "ice-candidate", { candidate:e.candidate }, this.userId, peerId);
    });
    pc.addEventListener("track", (e)=>{
      if (e.track && !state.stream.getTracks().some(t=>t.id===e.track.id)) state.stream.addTrack(e.track);
      if (state.handlers?.onTrack) state.handlers.onTrack(state.stream);
      if (e.track?.kind === 'audio') this._setupPeerLevel(peerId, state);
    });
    pc.addEventListener("connectionstatechange", ()=>{
      this.onPeerState(peerId, 'net', pc.connectionState);
      this._log(`PC(${peerId})=${pc.connectionState}`);
    });

    this.peers.set(peerId, state);
    return state;
  }

  // публичные хуки UI
  bindPeerMedia(peerId, handlers){ const st = this.peers.get(peerId); if (st) st.handlers = handlers; }
  getPeer(peerId){ return this.peers.get(peerId); }

  async handleSignal(msg, mediaBinder){
    if (msg?.fromUserId && this.userId && msg.fromUserId === this.userId) return;
    if (msg?.targetUserId && this.userId && msg.targetUserId !== this.userId) return;

    const peerId = msg.fromUserId;
    const peer = await this._ensurePeer(peerId);

    if (mediaBinder && !peer.handlers){
      mediaBinder(peerId, { onTrack:()=>{}, onLevel:()=>{} });
    }

    if (msg.signalType === 'offer'){
      await this.init(this.ws, this.userId);
      const offer = { type:'offer', sdp: msg.sdp };

      if (peer.pc.signalingState !== 'stable'){
        try{ await peer.pc.setLocalDescription({ type:'rollback' }); }catch(e){ this._log(`rollback: ${e?.name||e}`); }
      }
      if (peer.pc.currentRemoteDescription?.sdp === msg.sdp){
        this._log('Duplicate offer ignored'); return;
      }

      try { await peer.pc.setRemoteDescription(offer); }
      catch(e){ this._log(`SRD(offer)[${peerId}]: ${e?.name||e}`); return; }

      peer.remoteSet = true;
      await this._flushQueuedCandidates(peerId);

      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      sendSignal(this.ws, 'answer', { sdp: answer.sdp }, this.userId, peerId);

    } else if (msg.signalType === 'answer'){
      if (peer.pc.signalingState !== 'have-local-offer'){
        this._log(`Ignore answer in ${peer.pc.signalingState}`); return;
      }
      if (peer.pc.currentRemoteDescription?.type === 'answer'){
        this._log('Duplicate answer ignored'); return;
      }
      try { await peer.pc.setRemoteDescription({ type:'answer', sdp: msg.sdp }); }
      catch(e){ this._log(`SRD(answer)[${peerId}]: ${e?.name||e}`); return; }
      peer.remoteSet = true;
      await this._flushQueuedCandidates(peerId);

    } else if (msg.signalType === 'ice-candidate'){
      if (!peer.remoteSet) peer.candidates.push(msg.candidate);
      else {
        try { await peer.pc.addIceCandidate(msg.candidate); }
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
    const pc = st.pc;
    if (pc.signalingState !== 'stable'){
      this._log(`Skip startOffer(${peerId}) in ${pc.signalingState}`); return;
    }
    try{
      const offer = await pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
      await pc.setLocalDescription(offer);
      sendSignal(this.ws, 'offer', { sdp: offer.sdp }, this.userId, peerId);
    }catch(e){ this._log(`startOffer(${peerId}): ${e?.name||e}`); }
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
        video: { deviceId: this.preferred.camId ? { exact: this.preferred.camId } : undefined },
        audio: false
      }).then(s=>{
        const [vt] = s.getVideoTracks();
        if (!vt) return;
        this.localStream.addTrack(vt);
        if (this.localVideo){
          const ms = this.localVideo.srcObject instanceof MediaStream ? this.localVideo.srcObject : new MediaStream();
          ms.addTrack(vt); this.localVideo.srcObject = ms;
        }
        for (const { pc } of this.peers.values()){
          try{ pc.addTrack(vt, this.localStream); }catch{}
        }
      }).catch(e=> this._log(`Camera init: ${e?.name||e}`));
      return true;
    }
    tr.enabled = !tr.enabled;
    return tr.enabled;
  }

  async close(){
    try{ this.ws?.close(); }catch{}
    for (const [pid, st] of this.peers){
      try{ st.pc?.close(); }catch{}
      if (st.level?.raf) cancelAnimationFrame(st.level.raf);
      if (st.level?.ctx) try{ st.level.ctx.close(); }catch{}
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
