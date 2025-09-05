// webrtc.js — мультипир WebRTC с аккуратной переговоркой и детальными логами
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

    // peerId -> { pc, stream, candidates:[], remoteSet, handlers,
    //             makingOffer, ignoreOffer, polite, iceFailTimer }
    this.peers = new Map();
  }

  _log(m){ try{ this.onLog(m); }catch{} }
  getOutputDeviceId(){ return this.outputDeviceId; }
  setPreferredDevices({ mic, cam, spk }){
    if (mic) this.preferred.micId = mic;
    if (cam) this.preferred.camId = cam;
    if (spk) this.outputDeviceId = spk;
    for (const [,st] of this.peers){
      try { st.handlers?.onSinkChange?.(this.outputDeviceId); } catch {}
    }
  }

  async _getLocalMedia(){
    const baseAudio = {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      deviceId: this.preferred.micId ? { exact: this.preferred.micId } : undefined,
    };
    try {
      this._log('Запрашиваем разрешение на микрофон...');
      const s = await navigator.mediaDevices.getUserMedia({ audio: baseAudio, video: false });
      this._log('Разрешение на микрофон получено');
      return s;
    } catch(e) {
      this._log(`getUserMedia failed: ${e?.name||e}`);
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
      catch(e) {
        this._log(`ICE config error: ${e}`);
        this.iceConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
      }
    }

    if (this.localStream) return;

    const stream = await this._getLocalMedia();
    this.localStream = stream;
    if (stream && this.localVideo){
      this.localVideo.srcObject = stream;
    }
    this._log(`WebRTC инициализирован. Аудио: ${stream && stream.getAudioTracks().length ? 'есть' : 'нет'}`);
  }

  _isPolite(myId, peerId){
    // инициатор — у кого id строкой меньше; «вежливый» тот, у кого больше
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
      makingOffer: false,
      ignoreOffer: false,
      polite: this._isPolite(this.userId, peerId),
      iceFailTimer: null,
    };

    // Добавляем локальные треки (без лишних recvonly, если треков нет — добавим один recvonly audio)
    if (this.localStream && this.localStream.getTracks().length){
      for (const track of this.localStream.getTracks()){
        try {
          pc.addTrack(track, this.localStream);
          this._log(`✅ Добавлен ${track.kind} трек для ${peerId.slice(0,8)}`);
        } catch(e) {
          this._log(`❌ addTrack(${track.kind}) → ${peerId.slice(0,8)}: ${e}`);
        }
      }
    } else {
      try { pc.addTransceiver("audio", { direction: "recvonly" }); this._log(`Добавлен recvonly audio transceiver для ${peerId.slice(0,8)}`); }
      catch(e){ this._log(`❌ addTransceiver(audio) error → ${peerId.slice(0,8)}: ${e}`); }
    }

    pc.addEventListener("icecandidate", (e)=>{
      if (e.candidate) sendSignal(this.ws, "ice-candidate", { candidate: e.candidate }, this.userId, peerId);
    });

    pc.addEventListener("track", (e)=>{
      this._log(`Получен трек от ${peerId.slice(0,8)}: ${e.track.kind} (enabled: ${e.track.enabled})`);
      if (e.track && !state.stream.getTracks().some(t => t.id === e.track.id)) {
        state.stream.addTrack(e.track);
      }
      e.track.addEventListener('mute', ()=> this._log(`(remote:${peerId.slice(0,8)}) ${e.track.kind} muted`));
      e.track.addEventListener('unmute', ()=> this._log(`(remote:${peerId.slice(0,8)}) ${e.track.kind} unmuted`));
      e.track.addEventListener('ended', ()=> this._log(`(remote:${peerId.slice(0,8)}) ${e.track.kind} ended`));

      if (state.handlers?.onTrack) state.handlers.onTrack(state.stream);
      if (e.track?.kind === 'audio') this._setupPeerLevel(peerId, state);
    });

    pc.addEventListener("negotiationneeded", async ()=>{
      if (state.makingOffer) return;
      if (!state.polite) { // инициатор — невежливый
        try {
          state.makingOffer = true;
          const offer = await pc.createOffer(); // без offerToReceive*
          await pc.setLocalDescription(offer);
          sendSignal(this.ws, 'offer', { sdp: offer.sdp }, this.userId, peerId);
          this._log(`📤 Sent offer → ${peerId.slice(0,8)} (negotiationneeded)`);
        } catch(e){
          this._log(`negotiationneeded(${peerId.slice(0,8)}): ${e?.name||e}`);
        } finally { state.makingOffer = false; }
      }
    });

    pc.addEventListener("connectionstatechange", ()=>{
      const s = pc.connectionState;
      this.onPeerState(peerId, 'net', s);
      this._log(`PC(${peerId.slice(0,8)}) = ${s}`);
      if (s === 'failed'){
        this._iceRestart(peerId).catch(()=>{});
      } else if (s === 'disconnected'){
        clearTimeout(state.iceFailTimer);
        state.iceFailTimer = setTimeout(()=>{
          if (pc.connectionState === 'disconnected') this._iceRestart(peerId).catch(()=>{});
        }, 2000);
      } else if (s === 'connected' || s === 'completed'){
        clearTimeout(state.iceFailTimer); state.iceFailTimer = null;
      }
    });

    pc.addEventListener("iceconnectionstatechange", ()=>{
      this._log(`ICE(${peerId.slice(0,8)}) = ${pc.iceConnectionState}`);
    });

    this.peers.set(peerId, state);
    return state;
  }

  async _iceRestart(peerId){
    const st = this.peers.get(peerId);
    if (!st) return;
    this._log(`ICE-restart → ${peerId.slice(0,8)}`);
    try{
      const offer = await st.pc.createOffer({ iceRestart: true });
      await st.pc.setLocalDescription(offer);
      sendSignal(this.ws, 'offer', { sdp: offer.sdp }, this.userId, peerId);
    }catch(e){ this._log(`ICE-restart(${peerId.slice(0,8)}): ${e?.name||e}`); }
  }

  bindPeerMedia(peerId, handlers){
    const st = this.peers.get(peerId);
    if (!st) { return; }
    // Объединим обработчики вместо полного перезаписывания
    st.handlers = Object.assign({}, st.handlers || {}, handlers || {});
    // Если уже есть треки — сразу пробросим поток
    if (st.stream && (st.stream.getAudioTracks().length || st.stream.getVideoTracks().length)){
      try { st.handlers?.onTrack?.(st.stream); } catch {}
      // И сразу поднимем анализатор уровня для аудио
      try { if (st.stream.getAudioTracks().length) this._setupPeerLevel(peerId, st); } catch {}
    }
  }
  getPeer(peerId){ return this.peers.get(peerId); }

  async handleSignal(msg, mediaBinder){
    if (msg?.fromUserId && this.userId && msg.fromUserId === this.userId) return;
    if (msg?.targetUserId && this.userId && msg.targetUserId !== this.userId) return;

    const peerId = msg.fromUserId;
    const peer = await this._ensurePeer(peerId);
    const pc = peer.pc;

    if (mediaBinder && !peer.handlers){
      mediaBinder(peerId, { onTrack: ()=>{}, onLevel: ()=>{}, onSinkChange: ()=>{} });
    }

    if (msg.signalType === 'offer'){
      await this.init(this.ws, this.userId);
      const desc = { type:'offer', sdp: msg.sdp };

      const offerCollision = peer.makingOffer || pc.signalingState !== "stable";
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) { this._log(`⏭️ Ignore offer from ${peerId.slice(0,8)} (impolite collision)`); return; }

      try{
        if (offerCollision) await pc.setLocalDescription({ type:'rollback' });
        await pc.setRemoteDescription(desc);
        peer.remoteSet = true;
        // Гарантируем, что у нас есть sendrecv для аудио с локальным треком
        try {
          const at = this.localStream?.getAudioTracks?.()[0];
          if (at) {
            // Найдём аудио sender
            let aSender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
            if (!aSender) {
              // Возможно sender есть, но без трека
              aSender = pc.getSenders().find(s => s.track == null && s?.sender?.track?.kind === 'audio');
            }
            if (!aSender) {
              try { aSender = pc.addTrack(at, this.localStream); } catch {}
            } else if (!aSender.track) {
              try { await aSender.replaceTrack(at); } catch {}
            }
            // Выставим transceiver на sendrecv
            try {
              const tx = pc.getTransceivers().find(t => (t.sender && t.sender === aSender) || (t.receiver?.track?.kind === 'audio'));
              if (tx && tx.direction !== 'sendrecv') tx.direction = 'sendrecv';
            } catch {}
          } else {
            // Если локального аудио нет — хотя бы приём
            const tx = pc.getTransceivers().find(t => t.receiver?.track?.kind === 'audio');
            if (!tx) { try { pc.addTransceiver('audio', { direction: 'recvonly' }); } catch {} }
          }
        } catch {}
        await this._flushQueuedCandidates(peerId);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(this.ws, 'answer', { sdp: answer.sdp }, this.userId, peerId);
        this._log(`📤 Answered offer from ${peerId.slice(0,8)}`);
      }catch(e){ this._log(`SRD(offer)[${peerId.slice(0,8)}]: ${e?.name||e}`); }

    } else if (msg.signalType === 'answer'){
      if (pc.signalingState !== 'have-local-offer'){
        this._log(`Ignore answer in ${pc.signalingState}`); return;
      }
      try{
        await pc.setRemoteDescription({ type:'answer', sdp: msg.sdp });
        peer.remoteSet = true;
        await this._flushQueuedCandidates(peerId);
        this._log(`Processed answer from ${peerId.slice(0,8)}`);
      }catch(e){ this._log(`SRD(answer)[${peerId.slice(0,8)}]: ${e?.name||e}`); }

    } else if (msg.signalType === 'ice-candidate'){
      if (!peer.remoteSet) peer.candidates.push(msg.candidate);
      else {
        try { await pc.addIceCandidate(msg.candidate); }
        catch(e){ this._log(`addIce[${peerId.slice(0,8)}]: ${e?.name||e}`); }
      }
    }
  }

  async _flushQueuedCandidates(peerId){
    const peer = this.peers.get(peerId);
    if (!peer?.pc) return;
    while (peer.candidates.length){
      const c = peer.candidates.shift();
      try { await peer.pc.addIceCandidate(c); }
      catch(e){ this._log(`flush ICE[${peerId.slice(0,8)}]: ${e?.name||e}`); }
    }
  }

  async startOffer(peerId){
    await this.init(this.ws, this.userId);
    const st = await this._ensurePeer(peerId);
    if (st.makingOffer) return;
    if (st.pc.signalingState !== 'stable'){
      this._log(`Skip startOffer(${peerId.slice(0,8)}) in ${st.pc.signalingState}`); return;
    }
    if (st.polite) { this._log(`Not initiator for ${peerId.slice(0,8)}`); return; }

    try{
      st.makingOffer = true;
      const offer = await st.pc.createOffer();
      await st.pc.setLocalDescription(offer);
      sendSignal(this.ws, 'offer', { sdp: offer.sdp }, this.userId, peerId);
      this._log(`📤 Sent offer → ${peerId.slice(0,8)} (startOffer)`);
    }catch(e){ this._log(`startOffer(${peerId.slice(0,8)}): ${e?.name||e}`); }
    finally{ st.makingOffer = false; }
  }

  toggleMic(){
    if (!this.localStream) { this._log('Нет локального потока для микрофона'); return false; }
    const tr = this.localStream.getAudioTracks()[0];
    if (!tr) { this._log('Нет аудио трека для переключения'); return false; }
    tr.enabled = !tr.enabled;
    this._log(`Микрофон ${tr.enabled ? 'включён' : 'выключен'}`);
    return tr.enabled;
  }
  toggleCam(){
    if (!this.localStream) { this._log('Нет локального потока для камеры'); return false; }
    let tr = this.localStream.getVideoTracks()[0];
    if (!tr){
      navigator.mediaDevices.getUserMedia({
        video: this.preferred.camId ? { deviceId: { exact: this.preferred.camId } } : true,
        audio: false
      }).then(s=>{
        const [vt] = s.getVideoTracks();
        if (!vt) return;
        this.localStream.addTrack(vt);
        if (this.localVideo) this.localVideo.srcObject = this.localStream;
        this._log('Камера включена');
      }).catch(e=> this._log(`Camera init: ${e?.name||e}`));
      return true;
    }
    tr.enabled = !tr.enabled;
    this._log(`Камера ${tr.enabled ? 'включена' : 'выключена'}`);
    return tr.enabled;
  }

  async close(){
    try{ this.ws?.close(); }catch{}
    for (const [, st] of this.peers){
      try{ st.pc?.close(); }catch{}
      if (st.level?.raf) cancelAnimationFrame(st.level.raf);
      clearTimeout(st.iceFailTimer);
    }
    this.peers.clear();
    if (this.localStream) this.localStream.getTracks().forEach(t=>t.stop());
    this.localStream = null;
    this._log('WebRTC соединения закрыты');
  }

  _setupPeerLevel(peerId, state){
    try{
      if (!window.AudioContext || !state.stream?.getAudioTracks().length) return;
      if (state.level?.raf) cancelAnimationFrame(state.level.raf);
      state.level = state.level || {};
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
      state.level.raf = requestAnimationFrame(loop);
      this._log(`Настроен аудио анализатор для ${peerId.slice(0,8)}`);
    } catch(e) {
      this._log(`level[${peerId.slice(0,8)}]: ${e?.name||e}`);
    }
  }

  // Быстрая диагностика
  async diagnoseAudio(){
    this._log('=== 🔊 АУДИО ДИАГНОСТИКА ===');
    if (this.localStream){
      const ats = this.localStream.getAudioTracks();
      this._log(`📱 Локальный поток: ${ats.length} аудио треков`);
      ats.forEach((t,i)=> this._log(`🎤 Трек ${i}: enabled=${t.enabled}, readyState=${t.readyState}, muted=${t.muted}`));
    } else {
      this._log('❌ НЕТ локального потока!');
    }
    this._log(`🔗 Активных соединений: ${this.peers.size}`);
    for (const [peerId, st] of this.peers){
      const pc = st.pc;
      this._log(`--- Peer ${peerId.slice(0,8)} ---`);
      this._log(`📊 Состояние: ${pc.connectionState}`);
      this._log(`🧊 ICE: ${pc.iceConnectionState}`);
      this._log(`📡 Signaling: ${pc.signalingState}`);
      try{
        const stats = await pc.getStats();
        let inboundAudio = 0, outboundAudio = 0;
        stats.forEach(r=>{
          if (r.type === 'inbound-rtp' && r.kind === 'audio') inboundAudio++;
          if (r.type === 'outbound-rtp' && r.kind === 'audio') outboundAudio++;
        });
        this._log(`📈 Inbound audio: ${inboundAudio}, Outbound audio: ${outboundAudio}`);
      }catch{}
    }
    this._log('=== КОНЕЦ ДИАГНОСТИКИ ===');
  }
}
