// webrtc.js — RTCPeerConnection handling

import { sendSignal } from "./signal.js";
import { getIceServers } from "./api.js";

/**
 * Опции конструктора:
 * {
 *   localVideo: HTMLVideoElement|null,
 *   remoteVideo: HTMLMediaElement (audio или video),
 *   outputDeviceId?: string|null,       // динамики (setSinkId), опционально
 *   unmuteButton?: HTMLButtonElement,   // опционально (для явного включения звука)
 *   onLog?: (msg:string)=>void,
 *   onConnected?: ()=>void,
 *   onDisconnected?: ()=>void,
 * }
 */
export class WebRTCManager {
  constructor(opts) {
  this.localVideo = opts.localVideo || null;
  this.remoteVideo = opts.remoteVideo || null; // в мультипире может быть null
    this.outputDeviceId = opts.outputDeviceId || null;
    this.unmuteButton = opts.unmuteButton || null;

    this.onLog = opts.onLog || (() => {});
  this.onConnected = opts.onConnected || (() => {});
  this.onRemoteAudioLevel = opts.onRemoteAudioLevel || (() => {});
    this.onDisconnected = opts.onDisconnected || (() => {});

    // внутренние флаги
  this.ws = null;
  this.userId = null;
  this.localStream = null;
  // мультипир: per-peer PC and streams
  this.peers = new Map(); // peerId -> { pc, stream, candidates:[], remoteSet: bool, level:{ctx,analyser,raf}, handlers }

    this._remoteSet = false;
    this._candidateQueue = [];
    this._started = false;
    this._playbackArmed = false;
  this._audioCtx = null;
  this._analyser = null;
  this._raf = 0;

    // подготовка media-элемента
  if (this.remoteVideo) {
      this.remoteVideo.autoplay = true;
      this.remoteVideo.playsInline = true;
      this.remoteVideo.muted = false;
      this.remoteVideo.volume = 1.0;
    }

    // кнопка "включить звук", если передали
    if (this.unmuteButton) {
      this.unmuteButton.hidden = true;
      this.unmuteButton.disabled = true;
      this.unmuteButton.addEventListener("click", async () => {
        try {
          // Safari/Chrome: иногда нужен user-gesture для AudioContext
          if (window.AudioContext) {
            const ac = new AudioContext();
            if (ac.state === "suspended") await ac.resume();
          }
          await this.remoteVideo.play();
          this.unmuteButton.hidden = true;
          this.unmuteButton.disabled = true;
        } catch (e) {
          this._log(`Manual unmute failed: ${e?.name || e}`);
        }
      });
    }
  }

  _log(msg) {
    try { this.onLog(msg); } catch { /* noop */ }
  }

  async _setOutputSink(deviceId) {
    if (!this.remoteVideo) return;
    if (typeof this.remoteVideo.setSinkId !== "function") {
      this._log("setSinkId is not supported in this browser");
      return;
    }
    try {
      await this.remoteVideo.setSinkId(deviceId);
      this._log(`Using audiooutput: ${deviceId}`);
    } catch (e) {
      this._log(`setSinkId error: ${e?.name || e}`);
    }
  }

  async getMediaStreamWithFallback() {
    const tryGet = async (constraints) => {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (e) {
        this._log(`getUserMedia error: ${e?.name || e}`);
        return null;
      }
    };

  // 1) по умолчанию ТОЛЬКО АУДИО (камера выключена)
    this._log("Trying getUserMedia: audio only");
  let stream = await tryGet({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    if (stream) return stream;

  // 2) попытка только видео (если нет микрофона)
    this._log("Trying getUserMedia: video only");
    stream = await tryGet({ audio: false, video: true });
    if (stream) return stream;

    // 4) ничего не удалось
    this._log("Нет доступных устройств. Продолжаем без микрофона/камеры.");
    return null;
  }

  async init(ws, userId) {
    this.ws = ws;
    this.userId = userId;
    if (this.localStream) return; // уже инициализировано медиа

    // ICE servers
    const fallbackIce = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };
    let rtcCfg = fallbackIce;
    try {
      const { iceServers } = await getIceServers();
      rtcCfg = { iceServers };
    } catch {
      rtcCfg = fallbackIce;
    }

    // Локальные медиа
    const stream = await this.getMediaStreamWithFallback();
    this.localStream = stream;
    if (stream) {
      this._log(
        `Local tracks: a=${stream.getAudioTracks().length} v=${stream.getVideoTracks().length}`
      );
      if (this.localVideo) this.localVideo.srcObject = stream;
    }
  }
  // Create or get a RTCPeerConnection for peerId
  async _ensurePeer(peerId) {
    if (this.peers.has(peerId)) return this.peers.get(peerId);
    // ICE servers
    const fallbackIce = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };
    let rtcCfg = fallbackIce;
    try {
      const { iceServers } = await getIceServers();
      rtcCfg = { iceServers };
    } catch { rtcCfg = fallbackIce; }
    const pc = new RTCPeerConnection({ ...rtcCfg, bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" });
    const state = { pc, stream: new MediaStream(), candidates: [], remoteSet: false, handlers: null, level: { ctx: null, analyser: null, raf: 0 } };
    // add local tracks (if any)
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    } else {
      try { pc.addTransceiver("audio", { direction: "recvonly" }); } catch {}
      try { pc.addTransceiver("video", { direction: "recvonly" }); } catch {}
    }
    pc.addEventListener("icecandidate", (e)=>{
      if (e.candidate) sendSignal(this.ws, "ice-candidate", { candidate: e.candidate }, this.userId, peerId);
    });
    pc.addEventListener("track", (e)=>{
      if (e.track && !state.stream.getTracks().some(t=>t.id===e.track.id)) state.stream.addTrack(e.track);
      // notify UI to attach media
      if (state.handlers?.onTrack) state.handlers.onTrack(state.stream);
      // setup level meter for this peer audio
      if (e.track?.kind === 'audio') this._setupPeerLevel(peerId, state);
    });
    pc.addEventListener("connectionstatechange", ()=>{
      this._log(`PC(${peerId}) state: ${pc.connectionState}`);
    });
    this.peers.set(peerId, state);
    return state;
  }

  async handleSignal(msg, mediaBinder) {
    // Никогда не обрабатываем собственные сигналы
    if (msg?.fromUserId && this.userId && msg.fromUserId === this.userId) return;
    // Если сервер передаёт адресата, а он не совпадает с нами — игнорируем
    if (msg?.targetUserId && this.userId && msg.targetUserId !== this.userId) return;
    const peerId = msg.fromUserId;
    const peer = await this._ensurePeer(peerId);
    if (mediaBinder && !peer.handlers) {
      // allow UI to attach media handlers
      peer.handlers = {};
      mediaBinder(peerId, {
        onTrack: (stream)=>{ /* UI will override this via binder; set placeholder */ },
        onLevel: ()=>{}
      });
    }

    if (msg.signalType === "offer") {
      await this.init(this.ws, this.userId);
      const offer = { type: "offer", sdp: msg.sdp };

      // защита от эха собственного оффера
      if (this.pc.localDescription?.type === "offer" &&
          this.pc.localDescription?.sdp === msg.sdp) {
        this._log("Self-offer echo ignored");
        return;
      }

      // glare-handling: если не stable, откатываем локальный оффер
      if (peer.pc.signalingState !== "stable") {
        try { await peer.pc.setLocalDescription({ type: "rollback" }); }
        catch (e) { this._log(`rollback failed: ${e?.name || e}`); }
      }

      // повторно не применяем тот же самый remote
      if (peer.pc.currentRemoteDescription?.sdp === msg.sdp) {
        this._log("Duplicate offer ignored");
        return;
      }

      try {
        await peer.pc.setRemoteDescription(offer);
      } catch(e) {
        this._log(`setRemoteDescription(offer)[${peerId}] failed in state ${peer.pc.signalingState}: ${e?.name||e}`);
        return;
      }
      peer.remoteSet = true;
      await this._flushQueuedCandidates(peerId);

      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      sendSignal(this.ws, "answer", { sdp: answer.sdp }, this.userId, peerId);

    } else if (msg.signalType === "answer") {
      if (!peer?.pc) return;

      if (peer.pc.signalingState !== "have-local-offer") {
        this._log(`Ignore answer[${peerId}] in state ${peer.pc.signalingState}`);
        return;
      }

      if (peer.pc.currentRemoteDescription?.type === "answer") {
        this._log("Duplicate answer ignored");
        return;
      }

      try {
        await peer.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      } catch(e) {
        this._log(`setRemoteDescription(answer)[${peerId}] failed in state ${peer.pc.signalingState}: ${e?.name||e}`);
        return;
      }
      peer.remoteSet = true;
      await this._flushQueuedCandidates(peerId);

  } else if (msg.signalType === "ice-candidate") {
      if (!peer.remoteSet) {
        peer.candidates.push(msg.candidate);
      } else if (peer.pc) {
        try { await peer.pc.addIceCandidate(msg.candidate); }
        catch (e) { this._log(`addIceCandidate[${peerId}] failed: ${e?.name || e}`); }
      }
    }
  }

  async _flushQueuedCandidates(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer?.pc) return;
    while (peer.candidates.length) {
      const c = peer.candidates.shift();
      try { await peer.pc.addIceCandidate(c); }
      catch (e) { this._log(`flush ICE[${peerId}] failed: ${e?.name || e}`); }
    }
  }

  // Proactively start an offer to a peer
  async startOffer(peerId){
    await this.init(this.ws, this.userId);
    const st = await this._ensurePeer(peerId);
    const pc = st.pc;
    // idempotent: only if stable and no current local offer
    if (pc.signalingState !== 'stable') {
      this._log(`Skip startOffer(${peerId}) in state ${pc.signalingState}`);
      return;
    }
    try{
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal(this.ws, 'offer', { sdp: offer.sdp }, this.userId, peerId);
    }catch(e){ this._log(`startOffer(${peerId}) failed: ${e?.name||e}`); }
  }

  isPeerEstablished(peerId){
    const st = this.peers.get(peerId);
    if (!st) return false;
    const s = st.pc.connectionState;
    return s === 'connected' || s === 'completed';
  }

  toggleMic() {
    if (!this.localStream) return false;
    const track = this.localStream.getAudioTracks()[0];
    if (!track) return false;
    track.enabled = !track.enabled;
    return track.enabled;
  }

  toggleCam() {
    if (!this.localStream) return false;
    let track = this.localStream.getVideoTracks()[0];
    if (!track) {
      // Ленивая инициализация камеры
      navigator.mediaDevices.getUserMedia({ video: true, audio: false }).then((camStream) => {
        const [videoTrack] = camStream.getVideoTracks();
        if (!videoTrack) return false;
        // добавить в локальный стрим
        this.localStream.addTrack(videoTrack);
        if (this.localVideo) {
          const s = this.localVideo.srcObject instanceof MediaStream ? this.localVideo.srcObject : new MediaStream();
          s.addTrack(videoTrack);
          this.localVideo.srcObject = s;
        }
        // добавить sender во все PC
        for (const { pc } of this.peers.values()) {
          try { pc.addTrack(videoTrack, this.localStream); } catch {}
        }
      }).catch((e)=>{
        this._log(`Camera init failed: ${e?.name||e}`);
      });
      return true;
    }
    track.enabled = !track.enabled;
    return track.enabled;
  }

  async close() {
    try { this.ws?.close(); } catch {}
    this.ws = null;
    for (const [pid, st] of this.peers) {
      try { st.pc?.close(); } catch {}
      if (st.level?.raf) cancelAnimationFrame(st.level.raf);
      if (st.level?.ctx) try{ st.level.ctx.close(); }catch{}
    }
    this.peers.clear();
    if (this.localStream) this.localStream.getTracks().forEach(t=>t.stop());
    this.localStream = null;
  }

  _armPlaybackOnGesture() {
    if (this._playbackArmed) return;
    this._playbackArmed = true;

    // Подсказка пользователю
    this._log("Нажмите в окно, чтобы включить звук (браузер блокирует автоплеи).");
    if (this.unmuteButton) {
      this.unmuteButton.hidden = false;
      this.unmuteButton.disabled = false;
    }

    const resume = async () => {
      try {
        if (window.AudioContext) {
          const ac = new AudioContext();
          if (ac.state === "suspended") await ac.resume();
        }
        await this.remoteVideo.play();
        if (this.unmuteButton) {
          this.unmuteButton.hidden = true;
          this.unmuteButton.disabled = true;
        }
      } catch {
        // пусть кнопка остаётся
      } finally {
        window.removeEventListener("click", resume);
        window.removeEventListener("keydown", resume);
        window.removeEventListener("touchstart", resume);
        this._playbackArmed = false;
      }
    };

    window.addEventListener("click", resume, { once: true });
    window.addEventListener("keydown", resume, { once: true });
    window.addEventListener("touchstart", resume, { once: true });
  }

  _setupPeerLevel(peerId, state){
    try{
      if (!state.stream || !state.stream.getAudioTracks().length) return;
      if (!window.AudioContext) return;
      if (!state.level.ctx) state.level.ctx = new AudioContext();
      const src = state.level.ctx.createMediaStreamSource(state.stream);
      state.level.analyser = state.level.ctx.createAnalyser();
      state.level.analyser.fftSize = 256;
      src.connect(state.level.analyser);
      const data = new Uint8Array(state.level.analyser.frequencyBinCount);
      const loop = ()=>{
        state.level.analyser.getByteTimeDomainData(data);
        let sum = 0; for (let i=0;i<data.length;i++){ const v=(data[i]-128)/128; sum += v*v; }
        const rms = Math.sqrt(sum/data.length);
        if (state.handlers?.onLevel) state.handlers.onLevel(rms);
        state.level.raf = requestAnimationFrame(loop);
      };
      if (state.level.raf) cancelAnimationFrame(state.level.raf);
      state.level.raf = requestAnimationFrame(loop);
    }catch(e){ this._log(`level meter[${peerId}] error: ${e?.name||e}`); }
  }

  // Allow UI to bind media handlers for a peer
  bindPeerMedia(peerId, handlers){
    const st = this.peers.get(peerId);
    if (st) st.handlers = handlers;
  }
}
