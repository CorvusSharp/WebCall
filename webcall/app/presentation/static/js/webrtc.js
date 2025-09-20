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
  // Поддержка двух одновременных видеотреков (камера + экран)
  this._currentVideoKind = 'none'; // none | camera | screen | multi (для внутренней диагностики)
  this._cameraTrack = null;
  this._screenTrack = null;
  this._cameraSender = null;
  this._screenSender = null;
  this._screenStream = null; // отдельный stream для шаринга (оригинальный getDisplayMedia)
  this.videoConstraints = {
    camera: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
    screen: { frameRate: 15 }
  };
  this.onVideoState = opts.onVideoState || (()=>{}); // callback(kind:'none'|'camera'|'screen', track)
  // Canvas композиция (локальное превью):
  this._compositeEnabled = false;
  this._compositeCanvas = null; // назначается извне (index.html)
  this._compositeRaf = null;
  // Метрики локального видео (fps/разрешение)
  this._metricsTimer = null;
  this._metrics = { fps:0, width:0, height:0 };
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
    // Ранее офферы создавались только "impolite" стороной. Это ломало сценарии,
    // когда видеотрек добавлялся у polite участника (часто мобильный), и peers
    // так и не переходили к m=video. Теперь обе стороны могут инициировать,
    // но защищаемся от коллизий через стандартную collision logic в handleSignal().
    try {
      state.makingOffer = true;
      this._log(`⚙️ negotiationneeded → createOffer (polite=${state.polite}) for ${peerId.slice(0,8)}`);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal(this.ws, 'offer', { sdp: offer.sdp }, this.userId, peerId);
      this._log(`📤 Sent offer → ${peerId.slice(0,8)} (negotiationneeded, polite=${state.polite})`);
    } catch (e) {
      this._log(`negotiationneeded(${peerId.slice(0,8)}): ${e?.name || e}`);
    } finally { state.makingOffer = false; }
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
      for (const [pid,peer] of this.peers){
        // Для двух параллельных видеотреков нужно иметь ДО 2-х sender.
        const senders = peer.pc.getSenders().filter(s=> s.track && s.track.kind==='video');
        // Определим тип трека
        const type = track._wcType || (track.label.toLowerCase().includes('screen') ? 'screen' : 'camera');
        let targetSender = (type==='screen'? this._screenSender : this._cameraSender);
        if (targetSender && !senders.includes(targetSender)) targetSender = null; // устарел

        if (!targetSender){
          // Ищем свободный sender (без трека) или добавляем
            let free = peer.pc.getSenders().find(s=> !s.track && s.transport);
            if (free){
              free.replaceTrack(track).catch(()=>{});
              targetSender = free;
              this._log(`➕ reuse empty video sender → ${pid.slice(0,8)} (${type}, id=${track.id})`);
            } else {
              targetSender = peer.pc.addTrack(track, this.localStream);
              this._log(`➕ add video track → ${pid.slice(0,8)} (${type}, id=${track.id})`);
            }
        } else if (targetSender.track !== track){
          const oldId = targetSender.track?.id;
          targetSender.replaceTrack(track).then(()=>{
            this._log(`♻️ replace ${type} track → ${pid.slice(0,8)} (${oldId}→${track.id})`);
          }).catch(()=>{});
        } else {
          this._log(`↔️ ${type} track already set for ${pid.slice(0,8)} (id=${track.id})`);
        }

        if (type==='screen') this._screenSender = targetSender;
        else this._cameraSender = targetSender;
      }
      // Сохраняем ссылку на первого sender как основной
      const firstPeer = this.peers.values().next().value;
      if (firstPeer){
        this._videoSender = firstPeer.pc.getSenders().find(s=> s.track && s.track.kind==='video') || this._videoSender; // legacy
      }
    } catch {}
  }

  async startCamera(){
    if (this._cameraTrack && this._cameraTrack.readyState === 'live'){
      this._log('Камера уже активна');
      return true;
    }
    try {
      const base = this.preferred.camId ? { deviceId: { exact: this.preferred.camId }, ...this.videoConstraints.camera } : this.videoConstraints.camera;
      const gum = await navigator.mediaDevices.getUserMedia({ video: base, audio: false });
      const track = gum.getVideoTracks()[0];
      if (!track) { this._log('Нет video track после getUserMedia'); return false; }
      track._wcType = 'camera';
      if (!this.localStream){ this.localStream = await this._getLocalMedia() || new MediaStream(); }
      // Удалим старую камеру если была
      if (this._cameraTrack){ try { this._cameraTrack.stop(); } catch{}; try { this.localStream.removeTrack(this._cameraTrack); } catch{} }
      this._cameraTrack = track;
      this.localStream.addTrack(track);
      this._attachOrReplaceVideoSender(track);
      this._updateLocalPreview();
  try { this.localVideo?.play?.().catch(()=>{}); } catch {}
      this._refreshVideoKind();
      track.onended = () => { this._log('Камера трек завершён'); if (this._cameraTrack === track) this.stopCamera(); };
      this._log(`Камера запущена (track id=${track.id}, label="${track.label}")`);
      this.onVideoState('camera', track);

      // Авто-триггер renegotiation если браузер (редко) не выдал negotiationneeded
      setTimeout(()=>{
        for (const [pid, st] of this.peers){
          const pc = st.pc;
          if (pc.signalingState === 'stable'){
            const hasVideoSender = pc.getSenders().some(s=> s.track && s.track.kind==='video');
            const transHasVideo = pc.getTransceivers().some(t=> t.sender?.track?.kind==='video');
            // Если sender есть, но m=video ещё не ушло (можно косвенно судить по отсутствию currentDirection с send)
            const needForce = hasVideoSender && !pc.getTransceivers().some(t=> (t.sender?.track?.kind==='video' && /send/.test(t.currentDirection||'')));
            if (needForce){
              this._log(`⚠️ Force renegotiation (manual offer) for ${pid.slice(0,8)} — negotiationneeded не сработал`);
              st.pc.createOffer().then(of=>{
                return st.pc.setLocalDescription(of).then(()=>{
                  sendSignal(this.ws, 'offer', { sdp: of.sdp }, this.userId, pid);
                  this._log(`📤 Sent offer (forced video) → ${pid.slice(0,8)}`);
                });
              }).catch(e=> this._log(`forceOffer(${pid.slice(0,8)}): ${e?.name||e}`));
            }
          }
        }
      }, 500);
      return true;
    } catch(e){ this._log(`startCamera error: ${e?.name||e}`); return false; }
  }

  async startScreenShare(){
    if (this._screenTrack && this._screenTrack.readyState === 'live'){ this._log('Screen share уже активен'); return true; }
    try {
      const ds = await navigator.mediaDevices.getDisplayMedia({ video: this.videoConstraints.screen, audio: false });
      const track = ds.getVideoTracks()[0];
      if (!track){ this._log('Нет трека экрана'); return false; }
      this._screenStream = ds;
      track._wcType = 'screen';
      if (!this.localStream){ this.localStream = await this._getLocalMedia() || new MediaStream(); }
      if (this._screenTrack){ try { this._screenTrack.stop(); } catch{}; try { this.localStream.removeTrack(this._screenTrack); } catch{} }
      this._screenTrack = track;
      this.localStream.addTrack(track);
      this._attachOrReplaceVideoSender(track);
      this._updateLocalPreview();
  try { this.localVideo?.play?.().catch(()=>{}); } catch {}
      track.onended = () => {
        this._log('Screen share завершён пользователем');
        if (this._screenTrack === track) this.stopScreenShare();
      };
      this._log('Демонстрация экрана запущена');
      this._refreshVideoKind();
      this.onVideoState('screen', track);
      return true;
    } catch(e){ this._log(`startScreenShare error: ${e?.name||e}`); return false; }
  }

  stopCamera(){
    if (!this._cameraTrack) return;
    try { this._cameraTrack.stop(); } catch{}
    if (this.localStream){ try { this.localStream.removeTrack(this._cameraTrack); } catch{} }
    for (const [,peer] of this.peers){
      const sender = this._cameraSender && peer.pc.getSenders().includes(this._cameraSender) ? this._cameraSender : null;
      if (sender && sender.track){ sender.replaceTrack(null).catch(()=>{}); }
    }
    this._cameraTrack = null; this._cameraSender = null;
    this._updateLocalPreview();
    this._refreshVideoKind();
    this._log('Камера остановлена');
    this.onVideoState('camera', null);
  }

  stopScreenShare(){
    if (!this._screenTrack) return;
    try { this._screenTrack.stop(); } catch{}
    if (this.localStream){ try { this.localStream.removeTrack(this._screenTrack); } catch{} }
    for (const [,peer] of this.peers){
      const sender = this._screenSender && peer.pc.getSenders().includes(this._screenSender) ? this._screenSender : null;
      if (sender && sender.track){ sender.replaceTrack(null).catch(()=>{}); }
    }
    this._screenStream?.getTracks().forEach(t=>{ try { t.stop(); } catch{} });
    this._screenStream = null;
    this._screenTrack = null; this._screenSender = null;
    this._updateLocalPreview();
    this._refreshVideoKind();
    this._log('Screen share остановлен');
    this.onVideoState('screen', null);
  }

  stopVideo(){ // legacy: выключить всё
    this.stopCamera();
    this.stopScreenShare();
    if (!this._cameraTrack && !this._screenTrack){
      this._log('Все видео треки остановлены');
      this.onVideoState('none', null);
    }
  }

  async toggleScreenShare(){
    if (this._screenTrack){ this._log('Отключаем screen share'); this.stopScreenShare(); return false; }
    const ok = await this.startScreenShare();
    return ok;
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
    if (this._cameraTrack){ this._log('Отключаем камеру'); this.stopCamera(); return false; }
    const ok = await this.startCamera();
    return ok;
  }

  async switchScreenShareWindow(){
    if (!this._screenTrack){ this._log('switchScreenShareWindow: нет активного screen share'); return false; }
    try {
      const ds = await navigator.mediaDevices.getDisplayMedia({ video: this.videoConstraints.screen, audio: false });
      const newTrack = ds.getVideoTracks()[0]; if (!newTrack){ this._log('switchScreenShareWindow: нет нового трека'); return false; }
      newTrack._wcType = 'screen';
      const old = this._screenTrack;
      this._screenTrack = newTrack;
      if (this.localStream){
        try { if (old) { old.stop(); this.localStream.removeTrack(old); } } catch{}
        this.localStream.addTrack(newTrack);
      }
      this._attachOrReplaceVideoSender(newTrack);
      this._updateLocalPreview();
      this._log('switchScreenShareWindow: трек заменён');
      return true;
    } catch(e){ this._log(`switchScreenShareWindow error: ${e?.name||e}`); return false; }
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
      this._cameraTrack = null; this._screenTrack = null;
      this._cameraSender = null; this._screenSender = null;
    try { this.disableComposite(); } catch {}
    this._stopMetricsLoop();
    this._log('WebRTC соединения закрыты');
  }

  _updateLocalPreview(){
    if (!this.localVideo) return;
    if (!this.localStream){ this.localVideo.srcObject = null; return; }
    // Если есть экран — показываем его, иначе камеру, иначе очищаем
    let showTrack = this._screenTrack || this._cameraTrack;
    if (!showTrack){
      // Очистка кадра (убираем последний frame)
      this.localVideo.srcObject = null;
      try { this.localVideo.load(); } catch{}
      return;
    }
    // Собираем временный поток только с выбранным треком, чтобы не было артефактов
    const ms = new MediaStream([showTrack]);
    this.localVideo.srcObject = ms;
  }

  _refreshVideoKind(){
    const cam = !!this._cameraTrack && this._cameraTrack.readyState==='live';
    const scr = !!this._screenTrack && this._screenTrack.readyState==='live';
    if (cam && scr) this._currentVideoKind = 'multi';
    else if (scr) this._currentVideoKind = 'screen';
    else if (cam) this._currentVideoKind = 'camera';
    else this._currentVideoKind = 'none';
    // Адаптация качества камеры при одновременном шеринге экрана
    this._adaptVideoQualities().catch(()=>{});
    if (this._currentVideoKind === 'none') this._stopMetricsLoop(); else this._ensureMetricsLoop();
  }

  async _adaptVideoQualities(){
    try {
      const camLive = this._cameraTrack && this._cameraTrack.readyState==='live';
      const scrLive = this._screenTrack && this._screenTrack.readyState==='live';
      if (!camLive) return;
      if (scrLive){
        // Понижаем нагрузку камеры
        const target = { frameRate: 12, width: { ideal: 960 }, height: { ideal: 540 } };
        await this._cameraTrack.applyConstraints(target).catch(()=>{});
        this._log('Адаптация: камера снижена (fps≈12 960x540) при активном screen share');
      } else {
        // Восстанавливаем
        await this._cameraTrack.applyConstraints(this.videoConstraints.camera).catch(()=>{});
        this._log('Адаптация: камера восстановлена к стандартным ограничениям');
      }
    } catch(e){ this._log('adaptVideoQualities: '+(e?.name||e)); }
  }

  // === Canvas Composition (экран + камера PiP) ===
  enableComposite(canvas){
    try {
      if (!canvas) return false;
      this._compositeCanvas = canvas;
      this._compositeEnabled = true;
      canvas.style.display = '';
      if (this.localVideo) this.localVideo.style.opacity = '0'; // скрываем оригинал, но оставляем для звука (если бы был)
      this._runCompositeLoop();
      this._log('Composite canvas enabled');
      return true;
    } catch(e){ this._log('enableComposite error: '+(e?.name||e)); return false; }
  }
  disableComposite(){
    this._compositeEnabled = false;
    if (this._compositeRaf) cancelAnimationFrame(this._compositeRaf); this._compositeRaf=null;
    if (this._compositeCanvas){ this._compositeCanvas.getContext('2d')?.clearRect(0,0,this._compositeCanvas.width,this._compositeCanvas.height); this._compositeCanvas.style.display='none'; }
    if (this.localVideo) this.localVideo.style.opacity = '';
    this._log('Composite canvas disabled');
  }
  toggleComposite(canvas){
    if (this._compositeEnabled) this.disableComposite(); else this.enableComposite(canvas||this._compositeCanvas);
  }
  _runCompositeLoop(){
    if (!this._compositeEnabled || !this._compositeCanvas){ return; }
    const ctx = this._compositeCanvas.getContext('2d');
    if (!ctx){ return; }
    const W = this._compositeCanvas.width; const H = this._compositeCanvas.height;
    ctx.fillStyle = '#000'; ctx.fillRect(0,0,W,H);
    // Основной слой: экран если есть, иначе камера
    const screenTrack = (this._screenTrack && this._screenTrack.readyState==='live') ? this._screenTrack : null;
    const camTrack = (this._cameraTrack && this._cameraTrack.readyState==='live') ? this._cameraTrack : null;
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
        // PiP камера в правом нижнем углу
        const pipW = Math.round(W*0.22); const pipH = Math.round(pipW* (9/16));
        drawTrack(camTrack, W-pipW-24, H-pipH-24, pipW, pipH);
        // Рамка
        ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 3; ctx.strokeRect(W-pipW-24+1.5, H-pipH-24+1.5, pipW-3, pipH-3);
      }
    } else if (camTrack){
      drawTrack(camTrack, 0,0,W,H);
    } else {
      // Нет треков — отключаем композицию
      this.disableComposite();
      return;
    }
    this._compositeRaf = requestAnimationFrame(()=> this._runCompositeLoop());
  }

  _ensureMetricsLoop(){
    if (this._metricsTimer) return;
    const el = document.getElementById('localVideoMetrics');
    const update = ()=>{
      try {
        const track = this._screenTrack || this._cameraTrack;
        if (!track || track.readyState!=='live'){ this._stopMetricsLoop(); return; }
        let st = {};
        try { st = track.getSettings ? track.getSettings() : {}; } catch {}
        this._metrics.width = st.width || this._metrics.width;
        this._metrics.height = st.height || this._metrics.height;
        this._metrics.fps = st.frameRate ? Math.round(st.frameRate) : this._metrics.fps;
        if (el){
          el.style.display='';
          el.textContent = `${this._currentVideoKind} ${this._metrics.width||'?'}x${this._metrics.height||'?'} @${this._metrics.fps||0}fps`;
        }
      } catch {}
    };
    this._metricsTimer = setInterval(update, 1000);
    update();
  }
  _stopMetricsLoop(){ if (this._metricsTimer){ clearInterval(this._metricsTimer); this._metricsTimer=null; const el=document.getElementById('localVideoMetrics'); if (el){ el.style.display='none'; el.textContent='—'; } } }

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

  // Диагностика видео/транссиверов для случая асимметрии
  async diagnoseVideo(){
    this._log('=== 🎥 ВИДЕО ДИАГНОСТИКА ===');
    if (this.localStream){
      const vts = this.localStream.getVideoTracks();
      this._log(`📱 Локальный поток: ${vts.length} видео трек(а)`);
      vts.forEach((t,i)=> this._log(`📸 Трек ${i}: id=${t.id}, label="${t.label}", state=${t.readyState}, enabled=${t.enabled}`));
    } else {
      this._log('❌ НЕТ локального потока (video)');
    }
    for (const [peerId, st] of this.peers){
      const pc = st.pc;
      this._log(`--- Peer ${peerId.slice(0,8)} video ---`);
      try {
        const trans = pc.getTransceivers();
        trans.filter(t=> (t.sender?.track?.kind==='video') || (t.receiver?.track?.kind==='video')).forEach((t,idx)=>{
          this._log(`🔁 TX#${idx} mid=${t.mid} dir=${t.direction} cur=${t.currentDirection} senderTrack=${t.sender?.track?.id||'-'} recvTrack=${t.receiver?.track?.id||'-'}`);
        });
        const senders = pc.getSenders().filter(s=> s.track && s.track.kind==='video');
        senders.forEach(s=> this._log(`➡️ sender track=${s.track.id} rtcp=${s.transport?.state||'?'} params=${(s.getParameters().encodings||[]).length}enc`));
        const receivers = pc.getReceivers().filter(r=> r.track && r.track.kind==='video');
        receivers.forEach(r=> this._log(`⬅️ receiver track=${r.track.id} state=${r.track.readyState}`));
        if (st.stream){
          const remoteV = st.stream.getVideoTracks();
          this._log(`📥 remote stream video tracks=${remoteV.length}`);
          remoteV.forEach((t,i)=> this._log(`   [${i}] id=${t.id} ready=${t.readyState} muted=${t.muted}`));
        }
      } catch(e){ this._log(`diagnoseVideo error: ${e?.name||e}`); }
    }
    this._log('=== КОНЕЦ ВИДЕО ДИАГНОСТИКИ ===');
  }
}