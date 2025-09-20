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
  this.peers = new Map();

  this._offerLocks = new Map(); // <— анти-дубль createOffer() по пиру
  this._videoSender = null; // RTCRtpSender для локального видео
  this._currentVideoKind = 'none'; // none | camera | screen
  this._screenStream = null; // отдельный stream для шаринга
  this.videoConstraints = {
    camera: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
    screen: { frameRate: 15 }
  };
  this.onVideoState = opts.onVideoState || (()=>{}); // callback(kind:'none'|'camera'|'screen', track)
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

  async _getLocalMedia() {
    const baseAudio = {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      deviceId: this.preferred.micId ? { exact: this.preferred.micId } : undefined,
    };
    try {
      this._log('Запрашиваем разрешение на микрофон...');
      const s = await navigator.mediaDevices.getUserMedia({ audio: baseAudio, video: false });
      this._log('Разрешение на микрофон получено');
      return s;
    } catch (e) {
      this._log(`getUserMedia failed: ${e?.name || e}`);
      // Fallback: пробуем дефолтное устройство без deviceId
      if (e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError') {
        try {
          this._log('Повторный запрос аудио без deviceId…');
          const s2 = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          this._log('Микрофон получен по умолчанию');
          return s2;
        } catch (e2) {
          this._log(`Повторный gUM не удался: ${e2?.name || e2}`);
        }
      }
      return null;
    }
  }


  async init(ws, userId, { micId, camId } = {}) {
    this.ws = ws;
    this.userId = userId;
    if (micId) this.preferred.micId = micId;
    if (camId) this.preferred.camId = camId;

    if (!this.iceConfig) {
      try {
        this.iceConfig = await getIceServers();
      } catch (e) {
        this._log(`ICE config error: ${e}`);
        this.iceConfig = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
      }
    }

    if (this.localStream) return;

    const stream = await this._getLocalMedia();
    this.localStream = stream;
    if (stream && this.localVideo) {
      this.localVideo.srcObject = stream;
    }
    this._log(`WebRTC инициализирован. Аудио: ${stream && stream.getAudioTracks().length ? 'есть' : 'нет'}`);

    // Гарантированно пробросим локальный аудио-трек во всех уже созданных пиров
    if (this.localStream) { await this.updateAllPeerTracks(); }
  }

  _isPolite(myId, peerId){
    // инициатор — у кого id строкой меньше; «вежливый» тот, у кого больше
    return String(myId) > String(peerId);
  }


async _ensurePeer(peerId) {
  if (this.peers.has(peerId)) return this.peers.get(peerId);

  const pc = new RTCPeerConnection({
    ...this.iceConfig,
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
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
    // ⚠️ Больше НЕ создаём тут свой audio transceiver. Дадим браузеру создать
    // его при SRD(offer), а потом "апгрейдим" именно его в handleSignal().
    audioTransceiver: null,
  };

  pc.addEventListener("icecandidate", (e) => {
    if (e.candidate) {
      sendSignal(this.ws, "ice-candidate", { candidate: e.candidate }, this.userId, peerId);
      this._log(`🧊 Sent ICE candidate to ${peerId.slice(0,8)}: ${e.candidate.candidate}`);
    }
  });

  pc.addEventListener("track", (e) => {
    this._log(`Получен трек от ${peerId.slice(0,8)}: ${e.track.kind} (enabled: ${e.track.enabled})`);
    if (e.track && !state.stream.getTracks().some(t => t.id === e.track.id)) {
      state.stream.addTrack(e.track);
    }
    e.track.addEventListener('mute', () => this._log(`(remote:${peerId.slice(0,8)}) ${e.track.kind} muted`));
    e.track.addEventListener('unmute', () => this._log(`(remote:${peerId.slice(0,8)}) ${e.track.kind} unmuted`));
    e.track.addEventListener('ended', () => this._log(`(remote:${peerId.slice(0,8)}) ${e.track.kind} ended`));

    if (state.handlers?.onTrack) {
      try { state.handlers.onTrack(state.stream); } catch {}
    }
    if (e.track?.kind === 'audio') this._setupPeerLevel(peerId, state);
  });

  pc.addEventListener("negotiationneeded", async () => {
    if (state.makingOffer) return;
    if (!state.polite) {
      try {
        state.makingOffer = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal(this.ws, 'offer', { sdp: offer.sdp }, this.userId, peerId);
        this._log(`📤 Sent offer → ${peerId.slice(0,8)} (negotiationneeded)\n${offer.sdp}`);
      } catch (e) {
        this._log(`negotiationneeded(${peerId.slice(0,8)}): ${e?.name || e}`);
      } finally { state.makingOffer = false; }
    }
  });

  pc.addEventListener("connectionstatechange", () => {
    const s = pc.connectionState;
    this.onPeerState(peerId, 'net', s);
    this._log(`PC(${peerId.slice(0,8)}) = ${s}`);
    if (s === 'failed') {
      this._iceRestart(peerId).catch(() => {});
    } else if (s === 'disconnected') {
      clearTimeout(state.iceFailTimer);
      state.iceFailTimer = setTimeout(() => {
        if (pc.connectionState === 'disconnected') this._iceRestart(peerId).catch(() => {});
      }, 2000);
    } else if (s === 'connected' || s === 'completed') {
      clearTimeout(state.iceFailTimer); state.iceFailTimer = null;
    }
  });

  pc.addEventListener("iceconnectionstatechange", () => {
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




async handleSignal(msg, mediaBinder) {
  if (msg?.fromUserId && this.userId && msg.fromUserId === this.userId) return;
  if (msg?.targetUserId && this.userId && msg.targetUserId !== this.userId) return;

  const peerId = msg.fromUserId;
  const peer = await this._ensurePeer(peerId);
  const pc = peer.pc;

  if (mediaBinder && !peer.handlers) {
    mediaBinder(peerId, { onTrack: ()=>{}, onLevel: ()=>{}, onSinkChange: ()=>{} });
  }

  if (msg.signalType === 'offer') {
    await this.init(this.ws, this.userId);
    const desc = { type: 'offer', sdp: msg.sdp };
    this._log(`📥 Received OFFER from ${peerId.slice(0,8)}:\n${msg.sdp}`);

    const offerCollision = peer.makingOffer || pc.signalingState !== "stable";
    peer.ignoreOffer = !peer.polite && offerCollision;
    if (peer.ignoreOffer) { this._log(`⏭️ Ignore offer from ${peerId.slice(0,8)} (impolite collision)`); return; }

    try {
      if (offerCollision) await pc.setLocalDescription({ type: 'rollback' });
      await pc.setRemoteDescription(desc);
      peer.remoteSet = true;
      await this._flushQueuedCandidates(peerId);

      // === КЛЮЧ: до createAnswer() делаем sendrecv + replaceTrack по МЭППИНГУ транссивера ===
      try {
        let at = this.localStream?.getAudioTracks?.()[0];
        if (!at) {
          const s = await this._getLocalMedia();
          if (s) { this.localStream = s; at = s.getAudioTracks()[0]; }
        }
        // ищем аудио-транссивер, соответствующий m=audio из оффера
        let tx = pc.getTransceivers().find(t => (t.receiver?.track?.kind === 'audio') || t.mid === '0');
        if (!tx) {
          // почти не должно случаться, но подстрахуемся
          tx = pc.addTransceiver('audio', { direction: 'sendrecv' });
        }
        tx.direction = 'sendrecv';
        if (at) await tx.sender.replaceTrack(at);
        peer.audioTransceiver = tx;
        this._log(`🔧 (answer) ensured sendrecv + local track for ${peerId.slice(0,8)}`);
      } catch (e) {
        this._log(`ensure sendrecv before answer: ${e?.name||e}`);
      }
      // ========================================================

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal(this.ws, 'answer', { sdp: answer.sdp }, this.userId, peerId);
      this._log(`📤 Answered offer from ${peerId.slice(0,8)}\n${answer.sdp}`);

      if (this.localStream) { await this.updateAllPeerTracks(); }
    } catch (e) {
      this._log(`SRD(offer)[${peerId.slice(0,8)}]: ${e?.name||e}`);
    }

  } else if (msg.signalType === 'answer') {
    if (pc.signalingState !== 'have-local-offer') {
      this._log(`Ignore answer in ${pc.signalingState}`); return;
    }
    try {
      this._log(`📥 Received ANSWER from ${peerId.slice(0,8)}:\n${msg.sdp}`);
      await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      peer.remoteSet = true;
      await this._flushQueuedCandidates(peerId);
      if (this.localStream) { await this.updateAllPeerTracks(); }
      this._log(`Processed answer from ${peerId.slice(0,8)}`);
    } catch (e) {
      this._log(`SRD(answer)[${peerId.slice(0,8)}]: ${e?.name||e}`);
    }

  } else if (msg.signalType === 'ice-candidate' || msg.signalType === 'ice_candidate') {
    this._log(`🧊 Received ICE candidate from ${peerId.slice(0,8)}: ${msg.candidate ? msg.candidate.candidate : '(null)'}`);
    if (!peer.remoteSet) peer.candidates.push(msg.candidate);
    else {
      try { await pc.addIceCandidate(msg.candidate); }
      catch (e) { this._log(`addIce[${peerId.slice(0,8)}]: ${e?.name||e}`); }
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
  const pc = st.pc;

  // анти-спам: не запускать параллельные офферы по одному пиру
  if (this._offerLocks.get(peerId)) {
    this._log(`startOffer(${peerId.slice(0,8)}): locked`);
    return;
  }

  // только "невежливый" инициирует
  if (st.polite) { this._log(`Not initiator for ${peerId.slice(0,8)}`); return; }
  if (pc.signalingState !== 'stable'){
    this._log(`Skip startOffer(${peerId.slice(0,8)}) in ${pc.signalingState}`); return;
  }

  try{
    this._offerLocks.set(peerId, true);
    st.makingOffer = true;

    // === КЛЮЧ: перед createOffer() гарантируем аудио-транссивер и локальный трек ===
    let at = this.localStream?.getAudioTracks?.()[0];
    if (!at) {
      const s = await this._getLocalMedia();
      if (s) { this.localStream = s; at = s.getAudioTracks()[0]; }
    }

    // найдём существующий аудио-транссивер или создадим
    let tx = pc.getTransceivers().find(t =>
      t.sender?.track?.kind === 'audio' || t.receiver?.track?.kind === 'audio'
    );
    if (!tx) {
      tx = pc.addTransceiver('audio', { direction: 'sendrecv' });
      this._log(`Added offer-side audio transceiver sendrecv for ${peerId.slice(0,8)}`);
    } else {
      tx.direction = 'sendrecv';
    }
    if (at) { await tx.sender.replaceTrack(at); }
    st.audioTransceiver = tx;
    // ============================================================================

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal(this.ws, 'offer', { sdp: offer.sdp }, this.userId, peerId);
    this._log(`📤 Sent offer → ${peerId.slice(0,8)} (startOffer)\n${offer.sdp}`);
  }catch(e){
    this._log(`startOffer(${peerId.slice(0,8)}): ${e?.name||e}`);
    // мягкий одноразовый ретрай через 300мс при OperationError/заминке ресурсов
    if (String(e?.name||'').includes('OperationError')) {
      setTimeout(()=>{ this._offerLocks.delete(peerId); this.startOffer(peerId).catch(()=>{}); }, 300);
    }
  }finally{
    st.makingOffer = false;
    this._offerLocks.delete(peerId);
  }
}


  async toggleMic(){
    if (this.localStream) {
      const tr = this.localStream.getAudioTracks()[0];
      if (!tr) { this._log('Нет аудио трека для переключения'); return false; }
      tr.enabled = !tr.enabled;
      this._log(`Микрофон ${tr.enabled ? 'включён' : 'выключен'}`);
      return tr.enabled;
    } else {
      this._log('Нет локального потока, пытаюсь получить...');
      const stream = await this._getLocalMedia();
      if (stream) {
        this.localStream = stream;
        if (this.localVideo) this.localVideo.srcObject = stream;
        await this.updateAllPeerTracks(); // Add this function
        this._log('Микрофон включён (поток получен)');
        return true;
      } else {
        this._log('Не удалось получить доступ к микрофону');
        return false;
      }
    }
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
        this._attachOrReplaceVideoSender(vt);
        if (this.localVideo) this.localVideo.srcObject = this.localStream;
        this._currentVideoKind = 'camera';
        this._log('Камера включена');
      }).catch(e=> this._log(`Camera init: ${e?.name||e}`));
      return true;
    }
    tr.enabled = !tr.enabled;
    this._log(`Камера ${tr.enabled ? 'включена' : 'выключена'}`);
    return tr.enabled;
  }

  _attachOrReplaceVideoSender(track){
    try {
      for (const [,peer] of this.peers){
        let sender = peer.pc.getSenders().find(s=> s.track && s.track.kind==='video');
        if (!sender){
          sender = peer.pc.addTrack(track, this.localStream);
        } else if (sender.track !== track){
          sender.replaceTrack(track).catch(()=>{});
        }
      }
      // Сохраняем ссылку на первого sender как основной
      const firstPeer = this.peers.values().next().value;
      if (firstPeer){
        this._videoSender = firstPeer.pc.getSenders().find(s=> s.track && s.track.kind==='video') || this._videoSender;
      }
    } catch {}
  }

  async startCamera(){
    if (this._currentVideoKind === 'camera' && this.localStream?.getVideoTracks()[0]){
      this._log('Камера уже активна');
      return true;
    }
    try {
      const base = this.preferred.camId ? { deviceId: { exact: this.preferred.camId }, ...this.videoConstraints.camera } : this.videoConstraints.camera;
      const gum = await navigator.mediaDevices.getUserMedia({ video: base, audio: false });
      const track = gum.getVideoTracks()[0];
      if (!track) { this._log('Нет video track после getUserMedia'); return false; }
      // Удаляем предыдущие video треки из localStream
      if (!this.localStream){ this.localStream = await this._getLocalMedia() || new MediaStream(); }
      this.localStream.getVideoTracks().forEach(t=>{ t.stop(); this.localStream.removeTrack(t); });
      this.localStream.addTrack(track);
      this._attachOrReplaceVideoSender(track);
      if (this.localVideo) this.localVideo.srcObject = this.localStream;
  try { this.localVideo?.play?.().catch(()=>{}); } catch {}
      this._currentVideoKind = 'camera';
      track.onended = () => { this._log('Камера трек завершён'); if (this._currentVideoKind==='camera') this.stopVideo(); };
      this._log('Камера запущена');
      this.onVideoState('camera', track);
      return true;
    } catch(e){ this._log(`startCamera error: ${e?.name||e}`); return false; }
  }

  async startScreenShare(){
    if (this._currentVideoKind === 'screen') { this._log('Screen share уже активен'); return true; }
    try {
      const ds = await navigator.mediaDevices.getDisplayMedia({ video: this.videoConstraints.screen, audio: false });
      const track = ds.getVideoTracks()[0];
      if (!track){ this._log('Нет трека экрана'); return false; }
      this._screenStream = ds;
      if (!this.localStream){ this.localStream = await this._getLocalMedia() || new MediaStream(); }
      // Заменяем текущий видеотрек
      this.localStream.getVideoTracks().forEach(t=>{ t.stop(); this.localStream.removeTrack(t); });
      this.localStream.addTrack(track);
      this._attachOrReplaceVideoSender(track);
      if (this.localVideo) this.localVideo.srcObject = this.localStream;
  try { this.localVideo?.play?.().catch(()=>{}); } catch {}
      this._currentVideoKind = 'screen';
      track.onended = () => {
        this._log('Screen share завершён пользователем');
        if (this._currentVideoKind === 'screen') {
          this._screenStream?.getTracks().forEach(t=>t.stop());
          this._screenStream = null;
          // Пытаемся вернуть камеру, если пользователь включал её ранее
          this.startCamera().catch(()=> this.stopVideo());
        }
      };
      this._log('Демонстрация экрана запущена');
      this.onVideoState('screen', track);
      return true;
    } catch(e){ this._log(`startScreenShare error: ${e?.name||e}`); return false; }
  }

  stopVideo(){
    try {
      if (!this.localStream) return;
      this.localStream.getVideoTracks().forEach(t=>{ try { t.stop(); } catch{}; this.localStream.removeTrack(t); });
      if (this.localVideo) {
        // Сохраняем аудио, но очистим video отображение
        this.localVideo.srcObject = this.localStream;
        try { this.localVideo?.play?.().catch(()=>{}); } catch {}
      }
      this._currentVideoKind = 'none';
      this._log('Видео выключено');
      this.onVideoState('none', null);
      // Обновляем senders: заменяем видеотрек на null
      for (const [,peer] of this.peers){
        const sender = peer.pc.getSenders().find(s=> s.track && s.track.kind==='video');
        if (sender){ sender.replaceTrack(null).catch(()=>{}); }
      }
    } catch(e){ this._log(`stopVideo error: ${e?.name||e}`); }
  }

  async toggleScreenShare(){
    if (this._currentVideoKind === 'screen'){
      this._log('Отключаем screen share');
      this.stopVideo();
      return false;
    } else {
      const ok = await this.startScreenShare();
      return ok;
    }
  }

  async switchCamera(deviceId){
    try {
      this.preferred.camId = deviceId;
      if (this._currentVideoKind !== 'camera'){ this._log('switchCamera: камера не активна, просто обновляем prefer'); return false; }
      const constraints = { video: { deviceId: { exact: deviceId }, ...this.videoConstraints.camera }, audio: false };
      const gum = await navigator.mediaDevices.getUserMedia(constraints);
      const newTrack = gum.getVideoTracks()[0]; if (!newTrack){ this._log('switchCamera: нет нового видеотрека'); return false; }
      const oldTracks = this.localStream?.getVideoTracks() || [];
      if (!this.localStream){ this.localStream = await this._getLocalMedia() || new MediaStream(); }
      oldTracks.forEach(t=>{ try { t.stop(); } catch{}; try { this.localStream.removeTrack(t); } catch{} });
      this.localStream.addTrack(newTrack);
      this._attachOrReplaceVideoSender(newTrack);
      if (this.localVideo) this.localVideo.srcObject = this.localStream;
      this._log('switchCamera: видеотрек заменён');
      this.onVideoState('camera', newTrack);
      return true;
    } catch(e){ this._log(`switchCamera error: ${e?.name||e}`); return false; }
  }

  async toggleCameraStream(){
    if (this._currentVideoKind === 'camera'){
      this._log('Отключаем камеру');
      this.stopVideo();
      return false;
    } else {
      const ok = await this.startCamera();
      return ok;
    }
  }


  async close(){
      try{ this.ws?.close(); }catch{}
      for (const [, st] of this.peers){
          try{ 
              // Останавливаем отправку ICE кандидатов при разрыве
              st.pc.onicecandidate = null;
              st.pc.close();
          }catch{}
          if (st.level?.raf) cancelAnimationFrame(st.level.raf);
          clearTimeout(st.iceFailTimer);
      }
      this.peers.clear();
      if (this.localStream) this.localStream.getTracks().forEach(t=>t.stop());
      this.localStream = null;
      this._log('WebRTC соединения закрыты');
  }

  async updateAllPeerTracks() {
      if (!this.localStream) return;
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (!audioTrack) return;

      this._log('Обновляю треки для всех пиров...');
    for (const [peerId, peer] of this.peers) {
      const sender = (peer.audioTransceiver?.sender) || peer.pc.getSenders().find(s => s.track?.kind === 'audio');
      if (!sender) continue;
      try {
        await sender.replaceTrack(audioTrack);
        this._log(`✅ Обновлен аудио-трек для ${peerId.slice(0,8)}`);
      } catch (e) {
        this._log(`❌ Ошибка обновления трека для ${peerId.slice(0,8)}: ${e}`);
      }
    }
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
          
          // Детальная информация о транспорте
          try{
              const stats = await pc.getStats();
              let hasActiveConnection = false;
              
              stats.forEach(r=>{
                  if (r.type === 'transport' && r.selectedCandidatePairId) {
                      const candidatePair = stats.get(r.selectedCandidatePairId);
                      if (candidatePair && candidatePair.state === 'succeeded') {
                          hasActiveConnection = true;
                          this._log(`🌐 Активное соединение: ${candidatePair.localCandidateId} ↔ ${candidatePair.remoteCandidateId}`);
                      }
                  }
                  if (r.type === 'inbound-rtp' && r.kind === 'audio') {
                      this._log(`📥 Входящий аудио: ${r.bytesReceived} bytes, ${r.packetsReceived} packets`);
                  }
                  if (r.type === 'outbound-rtp' && r.kind === 'audio') {
                      this._log(`📤 Исходящий аудио: ${r.bytesSent} bytes, ${r.packetsSent} packets`);
                  }
              });
              
              this._log(`✅ Активное соединение: ${hasActiveConnection ? 'Да' : 'Нет'}`);
              
          } catch(e) {
              this._log(`❌ Ошибка получения статистики: ${e}`);
          }
      }
      this._log('=== КОНЕЦ ДИАГНОСТИКИ ===');
  }
}