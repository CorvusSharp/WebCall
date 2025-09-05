// webrtc.js — упрощённый мультипир WebRTC с гарантированным аудио
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
    //             isInitiator, negotiationInProgress, iceFailTimer }
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
      echoCancellation: true, 
      noiseSuppression: true, 
      autoGainControl: true,
      deviceId: this.preferred.micId ? { exact: this.preferred.micId } : undefined,
    };
    
    try {
      // Сначала пытаемся получить только аудио (основной приоритет)
      return await navigator.mediaDevices.getUserMedia({ audio: baseAudio, video: false });
    } catch(e) {
      this._log(`getUserMedia audio failed: ${e?.name||e}`);
      // Пробуем без конкретного устройства
      try {
        return await navigator.mediaDevices.getUserMedia({ 
          audio: { echoCancellation: true, noiseSuppression: true }, 
          video: false 
        });
      } catch(e2) {
        this._log(`Fallback getUserMedia failed: ${e2?.name||e2}`);
        return null;
      }
    }
  }

  async init(ws, userId, { micId, camId } = {}){
    this.ws = ws;
    this.userId = userId;
    if (micId) this.preferred.micId = micId;
    if (camId) this.preferred.camId = camId;

    if (!this.iceConfig) {
      try { 
        this.iceConfig = await getIceServers(); 
      } catch { 
        this.iceConfig = { 
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" }
          ] 
        }; 
      }
    }

    // ВСЕГДА получаем аудио поток при инициализации
    if (!this.localStream) {
      const stream = await this._getLocalMedia();
      this.localStream = stream;
      if (stream && this.localVideo) {
        this.localVideo.srcObject = stream;
      }
    }

    this._log(`WebRTC инициализирован. Аудио: ${this.localStream ? 'есть' : 'нет'}`);
  }

  _isInitiator(myId, peerId){
    // Инициатор - у кого ID лексикографически меньше
    return String(myId) < String(peerId);
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
      level: { ctx: null, analyser: null, raf: 0 },
      isInitiator: this._isInitiator(this.userId, peerId),
      negotiationInProgress: false,
      iceFailTimer: null,
    };

    // ПРОСТОЕ И ПРЯМОЕ добавление треков
    if (this.localStream) {
      // Добавляем ВСЕ треки из локального потока
      this.localStream.getTracks().forEach(track => {
        try {
          pc.addTrack(track, this.localStream);
          this._log(`✅ Добавлен ${track.kind} трек для ${peerId.slice(0,8)}`);
        } catch(e) {
          this._log(`❌ Ошибка добавления ${track.kind} трека для ${peerId}: ${e}`);
        }
      });
    } else {
      this._log(`🚨 КРИТИЧНО: Нет локального потока при создании peer ${peerId.slice(0,8)}`);
    }

    pc.addEventListener("icecandidate", (e) => {
      if (e.candidate) {
        sendSignal(this.ws, "ice-candidate", { candidate: e.candidate }, this.userId, peerId);
      }
    });

    pc.addEventListener("track", (e) => {
      this._log(`Получен трек от ${peerId.slice(0,8)}: ${e.track.kind} (enabled: ${e.track.enabled})`);
      
      if (e.track && !state.stream.getTracks().some(t => t.id === e.track.id)) {
        state.stream.addTrack(e.track);
        this._log(`Трек ${e.track.kind} добавлен в поток ${peerId.slice(0,8)}`);
      }
      
      // Вызываем onTrack сразу при получении каждого трека
      if (state.handlers?.onTrack) {
        state.handlers.onTrack(state.stream);
      }
      
      if (e.track?.kind === 'audio') {
        this._setupPeerLevel(peerId, state);
        this._log(`Настроен аудио анализатор для ${peerId.slice(0,8)}`);
      }
    });

    // Упрощённая логика renegotiation - только если мы инициатор
    pc.addEventListener("negotiationneeded", async () => {
      if (!state.isInitiator || state.negotiationInProgress) return;
      
      try {
        state.negotiationInProgress = true;
        await this._createAndSendOffer(peerId, state);
      } catch(e) {
        this._log(`negotiationneeded error for ${peerId}: ${e}`);
      } finally {
        state.negotiationInProgress = false;
      }
    });

    // ICE connection monitoring
    pc.addEventListener("connectionstatechange", () => {
      const s = pc.connectionState;
      this.onPeerState(peerId, 'net', s);
      this._log(`PC(${peerId}) = ${s}`);
      
      if (s === 'failed') {
        this._handleIceFailure(peerId, state);
      } else if (s === 'disconnected') {
        clearTimeout(state.iceFailTimer);
        state.iceFailTimer = setTimeout(() => {
          if (pc.connectionState === 'disconnected') {
            this._handleIceFailure(peerId, state);
          }
        }, 3000);
      } else if (s === 'connected' || s === 'completed') {
        clearTimeout(state.iceFailTimer);
        state.iceFailTimer = null;
      }
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      this._log(`ICE(${peerId}) = ${pc.iceConnectionState}`);
    });

    this.peers.set(peerId, state);
    return state;
  }

  async _createAndSendOffer(peerId, state) {
    try {
      const offer = await state.pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
        voiceActivityDetection: false  // Отключаем VAD для стабильности
      });
      await state.pc.setLocalDescription(offer);
      sendSignal(this.ws, 'offer', { sdp: offer.sdp }, this.userId, peerId);
      this._log(`📤 Sent offer to ${peerId.slice(0,8)}`);
    } catch(e) {
      this._log(`❌ Failed to create/send offer to ${peerId.slice(0,8)}: ${e}`);
    }
  }

  async _handleIceFailure(peerId, state) {
    this._log(`ICE failure for ${peerId}, attempting restart`);
    if (!state.isInitiator) return;
    
    try {
      const offer = await state.pc.createOffer({ iceRestart: true });
      await state.pc.setLocalDescription(offer);
      sendSignal(this.ws, 'offer', { sdp: offer.sdp }, this.userId, peerId);
    } catch(e) {
      this._log(`ICE restart failed for ${peerId}: ${e}`);
    }
  }

  // публичные хуки UI
  bindPeerMedia(peerId, handlers){ 
    const st = this.peers.get(peerId); 
    if (st) st.handlers = handlers; 
  }
  
  getPeer(peerId){ 
    return this.peers.get(peerId); 
  }

  // Диагностика состояния аудио
  diagnoseAudio() {
    this._log('=== 🔊 АУДИО ДИАГНОСТИКА ===');
    
    // Локальный поток
    if (this.localStream) {
      const audioTracks = this.localStream.getAudioTracks();
      this._log(`📱 Локальный поток: ${audioTracks.length} аудио треков`);
      audioTracks.forEach((track, i) => {
        this._log(`  🎤 Трек ${i}: enabled=${track.enabled}, readyState=${track.readyState}, muted=${track.muted}`);
      });
    } else {
      this._log('❌ НЕТ локального потока!');
    }
    
    // Проверяем глобальный аудио контекст
    try {
      const testCtx = new AudioContext();
      this._log(`🎧 AudioContext state: ${testCtx.state}`);
      testCtx.close();
    } catch(e) {
      this._log(`❌ AudioContext недоступен: ${e}`);
    }
    
    // Peer connections
    this._log(`🔗 Активных соединений: ${this.peers.size}`);
    for (const [peerId, state] of this.peers) {
      this._log(`--- Peer ${peerId.slice(0,8)} ---`);
      this._log(`  📊 Состояние: ${state.pc.connectionState}`);
      this._log(`  🧊 ICE: ${state.pc.iceConnectionState}`);
      this._log(`  📡 Signaling: ${state.pc.signalingState}`);
      
      // Исходящие треки
      const senders = state.pc.getSenders();
      this._log(`  📤 Отправляем треков: ${senders.length}`);
      senders.forEach((sender, i) => {
        if (sender.track) {
          this._log(`    Sender ${i}: ${sender.track.kind}, enabled=${sender.track.enabled}, readyState=${sender.track.readyState}`);
        } else {
          this._log(`    Sender ${i}: ❌ НЕТ ТРЕКА`);
        }
      });
      
      // Входящие треки
      const receivers = state.pc.getReceivers();
      this._log(`  📥 Получаем треков: ${receivers.length}`);
      receivers.forEach((receiver, i) => {
        if (receiver.track) {
          this._log(`    Receiver ${i}: ${receiver.track.kind}, enabled=${receiver.track.enabled}, readyState=${receiver.track.readyState}`);
        } else {
          this._log(`    Receiver ${i}: ❌ НЕТ ТРЕКА`);
        }
      });
      
      // Stream состояние
      const streamTracks = state.stream.getTracks();
      this._log(`  🌊 В потоке треков: ${streamTracks.length}`);
      streamTracks.forEach((track, i) => {
        this._log(`    Stream трек ${i}: ${track.kind}, enabled=${track.enabled}, readyState=${track.readyState}, muted=${track.muted}`);
      });
      
      // Проверяем stats
      if (state.pc.connectionState === 'connected') {
        state.pc.getStats().then(stats => {
          let audioInbound = 0, audioOutbound = 0;
          stats.forEach(stat => {
            if (stat.type === 'inbound-rtp' && stat.mediaType === 'audio') {
              audioInbound++;
            } else if (stat.type === 'outbound-rtp' && stat.mediaType === 'audio') {
              audioOutbound++;
            }
          });
          this._log(`  📈 Stats - Inbound audio: ${audioInbound}, Outbound audio: ${audioOutbound}`);
        }).catch(e => {
          this._log(`  📈 Stats error: ${e}`);
        });
      }
    }
    
    this._log('=== КОНЕЦ ДИАГНОСТИКИ ===');
  }

  async handleSignal(msg, mediaBinder){
    if (msg?.fromUserId && this.userId && msg.fromUserId === this.userId) return;
    if (msg?.targetUserId && this.userId && msg.targetUserId !== this.userId) return;

    const peerId = msg.fromUserId;
    if (!peerId) return;

    // НЕ вызываем повторную инициализацию здесь!
    // Убеждаемся, что у нас есть локальный поток
    if (!this.localStream) {
      this._log('КРИТИЧНО: Нет локального потока при обработке сигнала!');
      return;
    }
    
    const peer = await this._ensurePeer(peerId);
    const pc = peer.pc;

    if (mediaBinder && !peer.handlers){
      mediaBinder(peerId, { onTrack: () => {}, onLevel: () => {} });
    }

    if (msg.signalType === 'offer'){
      try {
        const desc = { type: 'offer', sdp: msg.sdp };
        await pc.setRemoteDescription(desc);
        peer.remoteSet = true;
        await this._flushQueuedCandidates(peerId);

        const answer = await pc.createAnswer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true,
          voiceActivityDetection: false  // Отключаем VAD для стабильности
        });
        await pc.setLocalDescription(answer);
        sendSignal(this.ws, 'answer', { sdp: answer.sdp }, this.userId, peerId);
        this._log(`📤 Answered offer from ${peerId.slice(0,8)}`);
      } catch(e) {
        this._log(`❌ Failed to handle offer from ${peerId.slice(0,8)}: ${e}`);
      }

    } else if (msg.signalType === 'answer'){
      if (pc.signalingState !== 'have-local-offer'){
        this._log(`Ignoring answer from ${peerId} - wrong state: ${pc.signalingState}`);
        return;
      }
      
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        peer.remoteSet = true;
        await this._flushQueuedCandidates(peerId);
        this._log(`Processed answer from ${peerId}`);
      } catch(e) {
        this._log(`Failed to handle answer from ${peerId}: ${e}`);
      }

    } else if (msg.signalType === 'ice-candidate'){
      if (!peer.remoteSet) {
        peer.candidates.push(msg.candidate);
      } else {
        try { 
          await pc.addIceCandidate(msg.candidate); 
        } catch(e) { 
          this._log(`Failed to add ICE candidate from ${peerId}: ${e}`); 
        }
      }
    }
  }

  async _flushQueuedCandidates(peerId){
    const peer = this.peers.get(peerId);
    if (!peer?.pc) return;
    
    while (peer.candidates.length){
      const candidate = peer.candidates.shift();
      try { 
        await peer.pc.addIceCandidate(candidate); 
      } catch(e) { 
        this._log(`Failed to flush ICE candidate for ${peerId}: ${e}`); 
      }
    }
  }

  async startOffer(peerId){
    // НЕ вызываем повторную инициализацию
    if (!this.localStream) {
      this._log('КРИТИЧНО: Нет локального потока для startOffer!');
      return;
    }
    
    const state = await this._ensurePeer(peerId);
    
    if (!state.isInitiator) {
      this._log(`Not initiator for ${peerId.slice(0,8)}, skipping offer`);
      return;
    }
    
    if (state.negotiationInProgress) {
      this._log(`Negotiation already in progress for ${peerId.slice(0,8)}`);
      return;
    }
    
    if (state.pc.signalingState !== 'stable'){
      this._log(`Cannot start offer for ${peerId.slice(0,8)} - signaling state: ${state.pc.signalingState}`);
      return;
    }
    
    try {
      state.negotiationInProgress = true;
      await this._createAndSendOffer(peerId, state);
    } catch(e) {
      this._log(`Failed to start offer for ${peerId.slice(0,8)}: ${e}`);
    } finally {
      state.negotiationInProgress = false;
    }
  }

  toggleMic(){
    if (!this.localStream) {
      this._log('Нет локального потока для переключения микрофона');
      return false;
    }
    const track = this.localStream.getAudioTracks()[0];
    if (!track) {
      this._log('Нет аудио трека для переключения');
      return false;
    }
    track.enabled = !track.enabled;
    this._log(`Микрофон ${track.enabled ? 'включён' : 'выключен'}`);
    return track.enabled;
  }

  async toggleCam(){
    if (!this.localStream) {
      this._log('Нет локального потока для камеры');
      return false;
    }
    
    let videoTrack = this.localStream.getVideoTracks()[0];
    
    if (!videoTrack) {
      // Камера ещё не включена, пытаемся получить видео поток
      try {
        const videoStream = await navigator.mediaDevices.getUserMedia({
          video: this.preferred.camId ? { deviceId: { exact: this.preferred.camId } } : true,
          audio: false
        });
        
        const [newVideoTrack] = videoStream.getVideoTracks();
        if (newVideoTrack) {
          this.localStream.addTrack(newVideoTrack);
          
          // Обновляем видео элемент
          if (this.localVideo) {
            this.localVideo.srcObject = this.localStream;
          }
          
          // Добавляем видео трек ко всем существующим peer connections
          for (const [peerId, state] of this.peers) {
            try {
              const videoSender = state.pc.getSenders().find(s => s.track?.kind === 'video');
              if (videoSender) {
                await videoSender.replaceTrack(newVideoTrack);
              } else {
                state.pc.addTrack(newVideoTrack, this.localStream);
              }
            } catch(e) {
              this._log(`Ошибка добавления видео трека для ${peerId}: ${e}`);
            }
          }
          
          this._log('Камера включена');
          return true;
        }
      } catch(e) {
        this._log(`Ошибка включения камеры: ${e?.name||e}`);
        return false;
      }
    } else {
      // Камера уже есть, просто переключаем
      videoTrack.enabled = !videoTrack.enabled;
      this._log(`Камера ${videoTrack.enabled ? 'включена' : 'выключена'}`);
      return videoTrack.enabled;
    }
    
    return false;
  }

  async close(){
    try { this.ws?.close(); } catch {}
    
    for (const [peerId, state] of this.peers){
      try { state.pc?.close(); } catch {}
      if (state.level?.raf) cancelAnimationFrame(state.level.raf);
      if (state.level?.ctx) {
        try { state.level.ctx.close(); } catch {}
      }
      clearTimeout(state.iceFailTimer);
    }
    this.peers.clear();
    
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
    }
    this.localStream = null;
    this._log('WebRTC соединения закрыты');
  }

  _setupPeerLevel(peerId, state){
    try {
      if (!window.AudioContext || !state.stream?.getAudioTracks().length) return;
      
      // Закрываем предыдущий контекст, если есть
      if (state.level.ctx) {
        try { state.level.ctx.close(); } catch {}
      }
      if (state.level.raf) {
        cancelAnimationFrame(state.level.raf);
      }
      
      state.level.ctx = new AudioContext();
      const source = state.level.ctx.createMediaStreamSource(state.stream);
      state.level.analyser = state.level.ctx.createAnalyser();
      state.level.analyser.fftSize = 256;
      source.connect(state.level.analyser);
      
      const dataArray = new Uint8Array(state.level.analyser.frequencyBinCount);
      
      const updateLevel = () => {
        if (!state.level.analyser) return;
        
        state.level.analyser.getByteTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const normalized = (dataArray[i] - 128) / 128;
          sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        
        if (state.handlers?.onLevel) {
          state.handlers.onLevel(rms);
        }
        
        state.level.raf = requestAnimationFrame(updateLevel);
      };
      
      state.level.raf = requestAnimationFrame(updateLevel);
    } catch(e) {
      this._log(`Ошибка настройки аудио анализатора для ${peerId}: ${e}`);
    }
  }
}
