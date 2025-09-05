// webrtc.js — мультипир WebRTC с Perfect Negotiation, аккуратным ICE и подробными логами
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
  this.audioCtx = null; // Глобальный аудио контекст для вывода звука

  // peerId -> { pc, stream, candidates:[], remoteSet, handlers, level:{analyser,raf,gain,volume,muted},
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
    try {
      this._log('Запрашиваем локальный медиапоток: audio=true, video=false');
      return await navigator.mediaDevices.getUserMedia({ audio: baseAudio, video: false });
    } catch(e) {
      this._log(`getUserMedia audio failed: ${e?.name||e}`);
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
    this._log(`WebRTC инициализирован. Аудио: ${this.localStream ? 'есть' : 'нет'}`);
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
  level: { analyser:null, raf:0, gain:null, volume:1, muted:false },
      makingOffer: false,
      ignoreOffer: false,
      polite: this._isPolite(this.userId, peerId),
      iceFailTimer: null,
    };

    // **Важно**: Добавляем треки только один раз и правильно
    if (this.localStream && this.localStream.getTracks().length > 0){
      // Добавляем каждый трек только один раз
      for (const track of this.localStream.getTracks()) {
        try { 
          pc.addTrack(track, this.localStream); 
          this._log(`✅ Добавлен ${track.kind} трек для ${peerId.slice(0,8)}`); 
        }
        catch(e){ 
          this._log(`❌ addTrack(${track.kind}) error → ${peerId.slice(0,8)}: ${e}`); 
        }
      }
    } else {
      // Если нет локального потока, создаем только recvonly transceivers
      try{ 
        pc.addTransceiver("audio", { direction:"recvonly" }); 
        this._log(`Добавлен recvonly audio transceiver для ${peerId.slice(0,8)}`);
      }catch(e){
        this._log(`❌ addTransceiver(audio) error → ${peerId.slice(0,8)}: ${e}`); 
      }
    }

    pc.addEventListener("icecandidate", (e)=>{
      if (e.candidate) sendSignal(this.ws, "ice-candidate", { candidate: e.candidate }, this.userId, peerId);
    });

    pc.addEventListener("track", (e)=>{
      this._log(`Получен трек от ${peerId.slice(0,8)}: ${e.track.kind} (enabled:${e.track.enabled})`);
      if (e.track && !state.stream.getTracks().some(t=>t.id===e.track.id)) state.stream.addTrack(e.track);
      if (state.handlers?.onTrack) state.handlers.onTrack(state.stream);
  if (e.track?.kind === 'audio') this._setupPeerLevel(peerId, state);
    });

    pc.addEventListener("negotiationneeded", async ()=>{
      // В Perfect Negotiation оффер может делать и «вежливый», но мы защищаемся makingOffer
      try{
        if (state.makingOffer) return;
        state.makingOffer = true;
        const offer = await pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
        await pc.setLocalDescription(offer);
        sendSignal(this.ws, 'offer', { sdp: offer.sdp }, this.userId, peerId);
        this._log(`📤 Sent offer → ${peerId.slice(0,8)} (negotiationneeded)`);
      }catch(e){ this._log(`negotiationneeded(${peerId.slice(0,8)}): ${e?.name||e}`); }
      finally{ state.makingOffer = false; }
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
        clearTimeout(state.iceFailTimer);
        state.iceFailTimer = null;
      }
    });

    pc.addEventListener("iceconnectionstatechange", ()=>{ this._log(`ICE(${peerId.slice(0,8)}) = ${pc.iceConnectionState}`); });

    this.peers.set(peerId, state);
    return state;
  }

  async _iceRestart(peerId){
    const st = this.peers.get(peerId);
    if (!st) return;
    this._log(`ICE-restart → ${peerId.slice(0,8)}`);
    try{
      const offer = await st.pc.createOffer({ iceRestart:true });
      await st.pc.setLocalDescription(offer);
      sendSignal(this.ws, 'offer', { sdp: offer.sdp }, this.userId, peerId);
    }catch(e){ this._log(`ICE-restart(${peerId.slice(0,8)}): ${e?.name||e}`); }
  }

  // публичные хуки UI
  bindPeerMedia(peerId, handlers){
    const st = this.peers.get(peerId);
    if (!st) return;
    st.handlers = handlers;
    // Если треки уже пришли до установки обработчиков — сразу передадим текущий stream в UI
    try{
      if (st.stream && st.stream.getTracks && st.stream.getTracks().length > 0) {
        handlers?.onTrack?.(st.stream);
      }
      // Если уже настроен аудио-пайплайн — отдадим контролы
      if (st.level?.gain && handlers?.onControl) {
        handlers.onControl(this._makeControlForPeer(st));
      }
    }catch{}
  }
  getPeer(peerId){ return this.peers.get(peerId); }

  // Диагностика состояния аудио/SDP/статов
  async diagnoseAudio(){
    this._log('=== 🔊 АУДИО ДИАГНОСТИКА ===');
    
    // Проверяем глобальный аудио контекст
    try {
      const ac = new AudioContext();
      this._log(`🎧 AudioContext state: ${ac.state}`);
      if (ac.state === 'suspended') {
        await ac.resume();
        this._log(`🎧 AudioContext resumed to: ${ac.state}`);
      }
      setTimeout(() => { try { ac.close(); } catch {} }, 100);
    } catch(e) {
      this._log(`❌ AudioContext error: ${e}`);
    }
    
    if (this.localStream) {
      const audioTracks = this.localStream.getAudioTracks();
      this._log(`📱 Локальный поток: ${audioTracks.length} аудио треков`);
      audioTracks.forEach((t,i)=> this._log(`🎤 Трек ${i}: enabled=${t.enabled}, readyState=${t.readyState}, muted=${t.muted}`));
    } else {
      this._log('❌ НЕТ локального потока!');
    }
    this._log(`🔗 Активных соединений: ${this.peers.size}`);

    for (const [peerId, st] of this.peers){
      const pc = st.pc;
      this._log(`--- Peer ${peerId.slice(0,8)} ---`);
      this._log(`📊 Состояние: ${pc.connectionState}`);
      this._log(`🧊 ICE: ${pc.iceConnectionState}`);
      this._log(`� Signaling: ${pc.signalingState}`);

      const senders = pc.getSenders(); 
      const receivers = pc.getReceivers();
      this._log(`📤 Отправляем треков: ${senders.length}`);
      senders.forEach((s,i)=> {
        if (s.track) {
          this._log(`Sender ${i}: ${s.track.kind}, enabled=${s.track.enabled}, readyState=${s.track.readyState}`);
        } else {
          this._log(`Sender ${i}: ❌ НЕТ ТРЕКА`);
        }
      });
      
      this._log(`📥 Получаем треков: ${receivers.length}`);
      receivers.forEach((r,i)=> {
        if (r.track) {
          this._log(`Receiver ${i}: ${r.track.kind}, enabled=${r.track.enabled}, readyState=${r.track.readyState}`);
        } else {
          this._log(`Receiver ${i}: ❌ НЕТ ТРЕКА`);
        }
      });
      
      const tracks = st.stream.getTracks();
      this._log(`🌊 В потоке треков: ${tracks.length}`);
      tracks.forEach((t,i)=> this._log(`Stream трек ${i}: ${t.kind}, enabled=${t.enabled}, readyState=${t.readyState}, muted=${t.muted}`));

      if (pc.connectionState === 'connected') {
        try{
          const stats = await pc.getStats();
          let inA=0,outA=0;
          stats.forEach(r=>{
            if (r.type==='inbound-rtp' && r.kind==='audio') inA++;
            if (r.type==='outbound-rtp' && r.kind==='audio') outA++;
          });
          this._log(`📈 Stats - Inbound audio: ${inA}, Outbound audio: ${outA}`);
        }catch(e){ this._log(`📈 Stats error: ${e}`); }
      }
    }
    this._log('=== КОНЕЦ ДИАГНОСТИКИ ===');
  }

  async handleSignal(msg, mediaBinder){
    if (msg?.fromUserId && this.userId && msg.fromUserId === this.userId) return;
    if (msg?.targetUserId && this.userId && msg.targetUserId !== this.userId) return;

    const peerId = msg.fromUserId;
    if (!peerId) return;

    if (!this.localStream) { this._log('КРИТИЧНО: Нет локального потока при обработке сигнала!'); return; }

    const peer = await this._ensurePeer(peerId);
    const pc = peer.pc;

    if (mediaBinder && !peer.handlers){
      mediaBinder(peerId, { onTrack: ()=>{}, onLevel: ()=>{} });
    }

    if (msg.signalType === 'offer'){
      const desc = { type:'offer', sdp: msg.sdp };
      const offerCollision = peer.makingOffer || pc.signalingState !== "stable";
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer) { this._log(`⏭️ Ignore offer from ${peerId.slice(0,8)} (impolite collision)`); return; }

      try{
        if (offerCollision) await pc.setLocalDescription({ type:'rollback' });
        await pc.setRemoteDescription(desc);
        peer.remoteSet = true;
        await this._flushQueuedCandidates(peerId);

        const answer = await pc.createAnswer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
        await pc.setLocalDescription(answer);
        sendSignal(this.ws, 'answer', { sdp: answer.sdp }, this.userId, peerId);
        this._log(`📤 Answered offer from ${peerId.slice(0,8)}`);
      }catch(e){ this._log(`SRD(offer)[${peerId.slice(0,8)}]: ${e?.name||e}`); }

    } else if (msg.signalType === 'answer'){
      if (pc.signalingState !== 'have-local-offer'){ this._log(`Ignore answer in ${pc.signalingState}`); return; }
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
    if (!this.localStream) { this._log('КРИТИЧНО: Нет локального потока для startOffer!'); return; }
    const st = await this._ensurePeer(peerId);
    if (st.makingOffer) return;
    if (st.pc.signalingState !== 'stable'){ this._log(`Skip startOffer(${peerId.slice(0,8)}) in ${st.pc.signalingState}`); return; }
    try{
      st.makingOffer = true;
      const offer = await st.pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
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

  async toggleCam(){
    if (!this.localStream) { this._log('Нет локального потока для камеры'); return false; }
    let tr = this.localStream.getVideoTracks()[0];
    if (!tr){
      try{
        const vs = await navigator.mediaDevices.getUserMedia({
          video: this.preferred.camId ? { deviceId: { exact: this.preferred.camId } } : true,
          audio: false
        });
        const [vt] = vs.getVideoTracks();
        if (!vt) return false;
        this.localStream.addTrack(vt);
        if (this.localVideo){ this.localVideo.srcObject = this.localStream; }
        // negotiationneeded сработает сам
        this._log('Камера включена');
        return true;
      }catch(e){ this._log(`Camera init: ${e?.name||e}`); return false; }
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
  try{ await this.audioCtx?.close(); }catch{}
  this.audioCtx = null;
    this._log('WebRTC соединения закрыты');
  }

  _setupPeerLevel(peerId, state){
    try{
      if (!window.AudioContext || !state.stream?.getAudioTracks().length) return;
      if (state.level.raf) cancelAnimationFrame(state.level.raf);
      if (!this.audioCtx) this.audioCtx = new AudioContext();
      try { this.audioCtx.resume(); } catch {}
      const src = this.audioCtx.createMediaStreamSource(state.stream);
      state.level.analyser = this.audioCtx.createAnalyser();
      state.level.analyser.fftSize = 256;
      state.level.gain = this.audioCtx.createGain();
      state.level.volume = 1;
      state.level.muted = false;
      // Параллель: в анализатор и в выход с контролем громкости
      src.connect(state.level.analyser);
      src.connect(state.level.gain);
      try { state.level.gain.connect(this.audioCtx.destination); } catch {}
      const data = new Uint8Array(state.level.analyser.frequencyBinCount);
      const loop = ()=>{
        if (!state.level.analyser) return;
        state.level.analyser.getByteTimeDomainData(data);
        let sum=0; for (let i=0;i<data.length;i++){ const v=(data[i]-128)/128; sum+=v*v; }
        const rms = Math.sqrt(sum/data.length);
        if (state.handlers?.onLevel) state.handlers.onLevel(rms);
        state.level.raf = requestAnimationFrame(loop);
      };
      state.level.raf = requestAnimationFrame(loop);
      // Сообщим UI про контролы громкости/мьюта
      if (state.handlers?.onControl) {
        try { state.handlers.onControl(this._makeControlForPeer(state)); } catch {}
      }
      this._log(`Настроен аудио анализатор для ${peerId.slice(0,8)}`);
    }catch(e){ this._log(`level[${peerId.slice(0,8)}]: ${e?.name||e}`); }
  }

  _makeControlForPeer(state){
    const apply = ()=>{
      if (!state.level?.gain) return;
      const vol = Math.max(0, Math.min(1, state.level.volume ?? 1));
      state.level.gain.gain.value = state.level.muted ? 0 : vol;
    };
    // Инициализация
    apply();
    return {
      setVolume: (v)=>{ state.level.volume = isFinite(v) ? Math.max(0, Math.min(1, v)) : 1; apply(); },
      setMuted: (m)=>{ state.level.muted = !!m; apply(); },
      getVolume: ()=> state.level?.gain?.gain?.value ?? 1,
      getMuted: ()=> !!state.level?.muted,
    };
  }
}
