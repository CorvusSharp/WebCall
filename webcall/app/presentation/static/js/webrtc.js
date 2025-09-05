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
    this.remoteVideo = opts.remoteVideo; // обязателен
    this.outputDeviceId = opts.outputDeviceId || null;
    this.unmuteButton = opts.unmuteButton || null;

    this.onLog = opts.onLog || (() => {});
  this.onConnected = opts.onConnected || (() => {});
  this.onRemoteAudioLevel = opts.onRemoteAudioLevel || (() => {});
    this.onDisconnected = opts.onDisconnected || (() => {});

    // внутренние флаги
    this.ws = null;
    this.userId = null;
    this.pc = null;
    this.localStream = null;
    this.remoteStream = null;

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

    if (this.pc) return; // уже инициализировано

    // ICE servers
    const fallbackIce = { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] };
    let rtcCfg = fallbackIce;
    try {
      const { iceServers } = await getIceServers();
      rtcCfg = { iceServers };
    } catch {
      rtcCfg = fallbackIce;
    }

    this.pc = new RTCPeerConnection({
      ...rtcCfg,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    });

    // Локальные медиа
    const stream = await this.getMediaStreamWithFallback();
    this.localStream = stream;
    if (stream) {
      this._log(
        `Local tracks: a=${stream.getAudioTracks().length} v=${stream.getVideoTracks().length}`
      );
      if (this.localVideo) this.localVideo.srcObject = stream;
      for (const track of stream.getTracks()) {
        this._log(`Add local track: kind=${track.kind} id=${track.id}`);
        this.pc.addTrack(track, stream);
      }
    }

    // Гарантируем прием аудио/видео даже без локальных сендеров
    const hasLocalAudio = this.pc.getSenders().some((s) => s.track?.kind === "audio");
    if (!hasLocalAudio) {
      try { this.pc.addTransceiver("audio", { direction: "recvonly" }); } catch {}
      this._log("No local mic: added audio transceiver recvonly");
    }
    const hasLocalVideo = this.pc.getSenders().some((s) => s.track?.kind === "video");
    if (!hasLocalVideo) {
      try { this.pc.addTransceiver("video", { direction: "recvonly" }); } catch {}
      this._log("No local camera: added video transceiver recvonly");
    }

    // События
    this.pc.addEventListener("icecandidate", (e) => {
      if (e.candidate) {
        sendSignal(this.ws, "ice-candidate", { candidate: e.candidate }, this.userId);
      }
    });

    this.pc.addEventListener("icecandidateerror", (e) => {
      this._log(
        `ICE candidate error: url=${e.url || ""} errorCode=${e.errorCode || ""} errorText=${e.errorText || ""}`
      );
    });

    this.pc.addEventListener("iceconnectionstatechange", () => {
      this._log(`ICE state: ${this.pc.iceConnectionState}`);
    });

    this.pc.addEventListener("connectionstatechange", () => {
      this._log(`PC state: ${this.pc.connectionState}`);
      if (this.pc.connectionState === "connected") this.onConnected();
      if (["disconnected", "failed", "closed"].includes(this.pc.connectionState)) {
        this.onDisconnected();
      }
    });

    this.pc.addEventListener("track", (e) => {
      this._log(
        `ontrack: kind=${e.track?.kind} id=${e.track?.id} streams=${e.streams?.length || 0}`
      );

      if (!this.remoteStream) this.remoteStream = new MediaStream();
      if (e.track && !this.remoteStream.getTracks().some((t) => t.id === e.track.id)) {
        this.remoteStream.addTrack(e.track);
      }

      if (this.remoteVideo && this.remoteVideo.srcObject !== this.remoteStream) {
        this.remoteVideo.srcObject = this.remoteStream;
      }

      // Настройка sink (динамики), если требуется
      if (this.outputDeviceId) {
        this._setOutputSink(this.outputDeviceId);
      }

      // Попытка воспроизведения — автоплей может быть заблокирован
      const tryPlay = () => {
        const p = this.remoteVideo.play();
        if (p && typeof p.then === "function") {
          p.catch((err) => {
            this._log(`remote play error: ${err?.name || err}`);
            this._armPlaybackOnGesture();
          });
        }
      };

      if (this.remoteVideo.readyState >= 2) {
        tryPlay();
      } else {
        const once = () => {
          this.remoteVideo.removeEventListener("loadedmetadata", once);
          tryPlay();
        };
        this.remoteVideo.addEventListener("loadedmetadata", once, { once: true });
      }

      // Start measuring remote audio level when audio arrives
      if (e.track?.kind === 'audio') {
        this._setupAudioLevelMeter();
      }
    });
  }

  async start(ws, userId) {
    if (this._started) return;
    this._started = true;

    await this.init(ws, userId);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    sendSignal(this.ws, "offer", { sdp: offer.sdp }, this.userId);
  }

  async handleSignal(msg) {
    // Никогда не обрабатываем собственные сигналы
    if (msg?.fromUserId && this.userId && msg.fromUserId === this.userId) return;

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
      if (this.pc.signalingState !== "stable") {
        try { await this.pc.setLocalDescription({ type: "rollback" }); }
        catch (e) { this._log(`rollback failed: ${e?.name || e}`); }
      }

      // повторно не применяем тот же самый remote
      if (this.pc.currentRemoteDescription?.sdp === msg.sdp) {
        this._log("Duplicate offer ignored");
        return;
      }

      await this.pc.setRemoteDescription(offer);
      this._remoteSet = true;
      await this._flushQueuedCandidates();

      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      sendSignal(this.ws, "answer", { sdp: answer.sdp }, this.userId);

    } else if (msg.signalType === "answer") {
      if (!this.pc) return;

      if (this.pc.signalingState !== "have-local-offer") {
        this._log(`Ignore answer in state ${this.pc.signalingState}`);
        return;
      }

      if (this.pc.currentRemoteDescription?.type === "answer") {
        this._log("Duplicate answer ignored");
        return;
      }

      await this.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
      this._remoteSet = true;
      await this._flushQueuedCandidates();

    } else if (msg.signalType === "ice-candidate") {
      if (!this._remoteSet) {
        this._candidateQueue.push(msg.candidate);
      } else if (this.pc) {
        try { await this.pc.addIceCandidate(msg.candidate); }
        catch (e) { this._log(`addIceCandidate failed: ${e?.name || e}`); }
      }
    }
  }

  async _flushQueuedCandidates() {
    if (!this.pc) return;
    while (this._candidateQueue.length) {
      const c = this._candidateQueue.shift();
      try { await this.pc.addIceCandidate(c); }
      catch (e) { this._log(`flush ICE failed: ${e?.name || e}`); }
    }
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
        if (this.localVideo && this.localVideo.srcObject) {
          // обновить локальный preview
          const s = /** @type {MediaStream} */ (this.localVideo.srcObject);
          s.addTrack(videoTrack);
        } else if (this.localVideo) {
          const s2 = new MediaStream([...(this.localStream.getTracks())]);
          this.localVideo.srcObject = s2;
        }
        // добавить sender в PC
        try { this.pc.addTrack(videoTrack, this.localStream); } catch {}
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
    try { this.pc?.close(); } catch {}
    this.pc = null;
    this.ws = null;

    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
    }
    this.localStream = null;

    this._remoteSet = false;
    this._candidateQueue = [];
    this._started = false;

    this.remoteStream = null;
    if (this.remoteVideo) {
      try { this.remoteVideo.pause(); } catch {}
      this.remoteVideo.srcObject = null;
    }
  if (this._raf) cancelAnimationFrame(this._raf);
  this._raf = 0;
  try{ this._audioCtx?.close(); }catch{}
  this._audioCtx = null;
  this._analyser = null;
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

  _setupAudioLevelMeter(){
    try{
      if (!this.remoteStream || !this.remoteStream.getAudioTracks().length) return;
      if (!window.AudioContext) return;
      if (!this._audioCtx) this._audioCtx = new AudioContext();
      const src = this._audioCtx.createMediaStreamSource(this.remoteStream);
      this._analyser = this._audioCtx.createAnalyser();
      this._analyser.fftSize = 256;
      src.connect(this._analyser);
      const data = new Uint8Array(this._analyser.frequencyBinCount);
      const loop = ()=>{
        this._analyser.getByteTimeDomainData(data);
        // compute rms
        let sum = 0;
        for (let i=0;i<data.length;i++){
          const v = (data[i]-128)/128;
          sum += v*v;
        }
        const rms = Math.sqrt(sum/data.length); // 0..1
        this.onRemoteAudioLevel(rms);
        this._raf = requestAnimationFrame(loop);
      };
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = requestAnimationFrame(loop);
    }catch(e){ this._log(`level meter error: ${e?.name||e}`); }
  }
}
