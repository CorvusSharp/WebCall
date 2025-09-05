// webrtc.js — мультипир с Perfect Negotiation и авто-переренегацией
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

    // peerId -> {
    //   pc, stream, candidates:[], remoteSet:bool, handlers,
    //   level:{ctx,analyser,raf},
    //   makingOffer:boolean, ignoreOffer:boolean, polite:boolean, iceFailTimer:number|null
    // }
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
    const constraints = {
      audio: {
        echoCancellation: true, 
        noiseSuppression: true, 
        autoGainControl: true,
        deviceId: this.preferred.micId ? { exact: this.preferred.micId } : undefined,
      },
      video: this.preferred.camId ? {
        deviceId: { exact: this.preferred.camId },
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 24 }
      } : false
    };

    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch(e) {
      this._log(`getUserMedia failed: ${e?.name||e}`);
      
      // Fallback - try audio only
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: constraints.audio,
          video: false
        });
      } catch (audioError) {
        this._log(`Audio-only fallback also failed: ${audioError}`);
        return null;
      }
    }
  }

  async init(ws, userId, { micId, camId } = {}){
    this.ws = ws;
    this.userId = userId;
    if (micId) this.preferred.micId = micId;
    if (camId) this.preferred.camId = camId;

    // Get ICE config once
    if (!this.iceConfig) {
      try {
        this.iceConfig = await getIceServers();
      } catch (e) {
        this._log(`ICE config error: ${e}`);
        this.iceConfig = {
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" }
          ]
        };
      }
    }

    if (this.localStream) return;

    // Локальные медиа
    const stream = await this._getLocalMedia();
    this.localStream = stream;
    if (stream && this.localVideo){
      this.localVideo.srcObject = stream;
    }
    
    // Диагностическая информация
    if (stream) {
      const audioTracks = stream.getAudioTracks();
      const videoTracks = stream.getVideoTracks();
      this._log(`Локальный поток: аудио=${audioTracks.length} (enabled=${audioTracks[0]?.enabled}), видео=${videoTracks.length} (enabled=${videoTracks[0]?.enabled})`);
    } else {
      this._log('Не удалось получить локальный медиапоток');
    }
  }

  _isPolite(myId, peerId){
    // Политика: "вежливый" (polite) тот, у кого строковый id БОЛЬШЕ.
    // Это соответствует нашей логике: оффер начинает тот, у кого id МЕНЬШЕ.
    return String(myId) > String(peerId);
  }

  async _ensurePeer(peerId){
    if (this.peers.has(peerId)) return this.peers.get(peerId);

    const pc = new RTCPeerConnection({ 
      ...this.iceConfig, 
      bundlePolicy: "max-bundle", 
      rtcpMuxPolicy: "require" 
    });
    
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

    // локальные треки - добавляем сначала, это создаст правильные трансиверы
    if (this.localStream){
      for (const t of this.localStream.getTracks()) {
        try {
          pc.addTrack(t, this.localStream);
        } catch (e) {
          this._log(`Error adding track: ${e}`);
        }
      }
    }

    // Добавляем трансиверы для получения медиа, если их еще нет
    const existingTransceivers = pc.getTransceivers();
    const hasAudio = existingTransceivers.some(t => t.receiver?.track?.kind === 'audio');
    const hasVideo = existingTransceivers.some(t => t.receiver?.track?.kind === 'video');
    
    try {
      if (!hasAudio) {
        pc.addTransceiver("audio", { direction: "recvonly" });
      }
      if (!hasVideo) {
        pc.addTransceiver("video", { direction: "recvonly" });
      }
    } catch (e) {
      this._log(`Error adding transceivers: ${e}`);
    }

    pc.addEventListener("icecandidate", (e)=>{
      if (e.candidate) {
        sendSignal(this.ws, "ice-candidate", { candidate: e.candidate }, this.userId, peerId);
      }
    });

    pc.addEventListener("track", (e)=>{
      this._log(`Получен трек от пира: kind=${e.track?.kind}, id=${e.track?.id}, enabled=${e.track?.enabled}`);
      if (e.track && !state.stream.getTracks().some(t=>t.id===e.track.id)) {
        state.stream.addTrack(e.track);
        if (state.handlers?.onTrack) state.handlers.onTrack(state.stream);
        if (e.track?.kind === 'audio') {
          this._log(`Настройка аудиоанализатора для пира ${peerId}`);
          this._setupPeerLevel(peerId, state);
        }
      }
    });

    // Perfect Negotiation — инициируем оффер по событию
    pc.addEventListener("negotiationneeded", async ()=>{
      try{
        if (state.makingOffer) return;
        
        state.makingOffer = true;
        const offer = await pc.createOffer({ 
          offerToReceiveAudio: true, 
          offerToReceiveVideo: true 
        });
        await pc.setLocalDescription(offer);
        sendSignal(this.ws, 'offer', { sdp: offer.sdp }, this.userId, peerId);
      } catch(e) {
        this._log(`negotiationneeded(${peerId}): ${e?.name||e}`);
      } finally {
        state.makingOffer = false;
      }
    });

    // автолечебница ICE
    pc.addEventListener("connectionstatechange", ()=>{
      const s = pc.connectionState;
      this.onPeerState(peerId, 'net', s);
      this._log(`PC(${peerId})=${s}`);
      
      if (s === 'failed'){
        // Немедленный ICE-restart
        this._iceRestart(peerId).catch(()=>{});
      } else if (s === 'disconnected'){
        // Если "зависло" в disconnected, через 2 сек попробуем ICE-restart
        clearTimeout(state.iceFailTimer);
        state.iceFailTimer = setTimeout(()=>{
          if (pc.connectionState === 'disconnected') {
            this._iceRestart(peerId).catch(()=>{});
          }
        }, 2000);
      } else if (s === 'connected' || s === 'completed'){
        clearTimeout(state.iceFailTimer);
        state.iceFailTimer = null;
      }
    });

    // Обработка ICE соединения
    pc.addEventListener("iceconnectionstatechange", () => {
      this._log(`ICE(${peerId})=${pc.iceConnectionState}`);
    });

    this.peers.set(peerId, state);
    return state;
  }

  async _iceRestart(peerId){
    const st = this.peers.get(peerId);
    if (!st) return;
    this._log(`ICE-restart → ${peerId}`);
    try{
      const offer = await st.pc.createOffer({ iceRestart: true });
      await st.pc.setLocalDescription(offer);
      sendSignal(this.ws, 'offer', { sdp: offer.sdp }, this.userId, peerId);
    } catch(e) { 
      this._log(`ICE-restart(${peerId}): ${e?.name||e}`);
    }
  }

  // публичные хуки UI
  bindPeerMedia(peerId, handlers){ 
    const st = this.peers.get(peerId); 
    if (st) st.handlers = handlers; 
  }
  
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
        if (offerCollision) {
          await pc.setLocalDescription({ type:'rollback' });
          peer.makingOffer = false; // сброс флага после rollback
        }
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
      if (!peer.remoteSet) {
        peer.candidates.push(msg.candidate);
      } else {
        try { 
          await pc.addIceCandidate(msg.candidate); 
        } catch(e) { 
          this._log(`addIce[${peerId}]: ${e?.name||e}`); 
        }
      }
    }
  }

  async _flushQueuedCandidates(peerId){
    const peer = this.peers.get(peerId);
    if (!peer?.pc) return;
    
    while (peer.candidates.length){
      const c = peer.candidates.shift();
      try { 
        await peer.pc.addIceCandidate(c); 
      } catch(e) { 
        this._log(`flush ICE[${peerId}]: ${e?.name||e}`); 
      }
    }
  }

  async startOffer(peerId){
    // вызывать можно смело — negotiationneeded тоже покроет,
    // но прямой вызов ускорит старт при появлении нового участника
    await this.init(this.ws, this.userId);
    const st = await this._ensurePeer(peerId);
    if (st.makingOffer) return;
    if (st.pc.signalingState !== 'stable'){
      this._log(`Skip startOffer(${peerId}) in ${st.pc.signalingState}`); 
      return;
    }
    
    try{
      st.makingOffer = true;
      const offer = await st.pc.createOffer({ 
        offerToReceiveAudio: true, 
        offerToReceiveVideo: true 
      });
      await st.pc.setLocalDescription(offer);
      sendSignal(this.ws, 'offer', { sdp: offer.sdp }, this.userId, peerId);
    } catch(e) { 
      this._log(`startOffer(${peerId}): ${e?.name||e}`); 
    } finally { 
      st.makingOffer = false; 
    }
  }

  toggleMic(){
    if (!this.localStream) return false;
    const tr = this.localStream.getAudioTracks()[0];
    if (!tr) {
      // Создаем новый аудиотрек если его нет
      navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true, 
          noiseSuppression: true, 
          autoGainControl: true,
          deviceId: this.preferred.micId ? { exact: this.preferred.micId } : undefined,
        },
        video: false
      }).then(s=>{
        const [at] = s.getAudioTracks();
        if (!at) return;
        this.localStream.addTrack(at);
        // Добавляем трек ко всем существующим соединениям
        for (const [peerId, state] of this.peers) {
          try {
            const sender = state.pc.getSenders().find(s => s.track?.kind === 'audio');
            if (sender) {
              sender.replaceTrack(at);
            } else {
              state.pc.addTrack(at, this.localStream);
            }
          } catch (e) {
            this._log(`Error adding audio track to peer ${peerId}: ${e}`);
          }
        }
      }).catch(e=> this._log(`Microphone init: ${e?.name||e}`));
      return true;
    }
    tr.enabled = !tr.enabled;
    return tr.enabled;
  }

  toggleCam(){
    if (!this.localStream) return false;
    let tr = this.localStream.getVideoTracks()[0];
    if (!tr){
      // Создаем новый видеотрек
      navigator.mediaDevices.getUserMedia({
        video: { 
          deviceId: this.preferred.camId ? { exact: this.preferred.camId } : undefined,
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 24 }
        },
        audio: false
      }).then(s=>{
        const [vt] = s.getVideoTracks();
        if (!vt) return;
        this.localStream.addTrack(vt);
        if (this.localVideo){
          this.localVideo.srcObject = this.localStream;
        }
        // Добавляем трек ко всем существующим соединениям
        for (const [peerId, state] of this.peers) {
          try {
            const sender = state.pc.getSenders().find(s => s.track?.kind === 'video');
            if (sender) {
              sender.replaceTrack(vt);
            } else {
              state.pc.addTrack(vt, this.localStream);
            }
          } catch (e) {
            this._log(`Error adding video track to peer ${peerId}: ${e}`);
          }
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
        let sum=0; 
        for (let i=0;i<data.length;i++){ 
          const v=(data[i]-128)/128; 
          sum+=v*v; 
        }
        const rms = Math.sqrt(sum/data.length);
        if (state.handlers?.onLevel) state.handlers.onLevel(rms);
        state.level.raf = requestAnimationFrame(loop);
      };
      if (state.level.raf) cancelAnimationFrame(state.level.raf);
      state.level.raf = requestAnimationFrame(loop);
    } catch(e) { 
      this._log(`level[${peerId}]: ${e?.name||e}`); 
    }
  }
}