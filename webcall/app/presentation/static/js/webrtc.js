// webrtc.js - RTCPeerConnection handling
import { sendSignal } from './signal.js';
import { getIceServers } from './api.js';

export class WebRTCManager {
  constructor(opts) {
    this.localVideo = opts.localVideo;
    this.remoteVideo = opts.remoteVideo;
  this.outputDeviceId = opts.outputDeviceId || null;
    this.onLog = opts.onLog || (()=>{});
    this.onConnected = opts.onConnected || (()=>{});
    this.onDisconnected = opts.onDisconnected || (()=>{});
  // signaling helpers
  this._remoteSet = false;
  this._candidateQueue = [];
  this._started = false;
  }

  async getMediaStreamWithFallback() {
    // Пытаемся получить и аудио, и видео; при ошибке пробуем по отдельности
    const tryGet = async (constraints) => {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints);
      } catch (e) {
  this.onLog(`getUserMedia error: ${e?.name || e}`);
        return null;
      }
    };

    // 1) audio+video (с разумными констрейнтами для голоса)
    this.onLog('Trying getUserMedia: audio+video');
    let stream = await tryGet({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: true,
    });
    if (stream) return stream;

  // 2) только аудио
  this.onLog('Trying getUserMedia: audio only');
  stream = await tryGet({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (stream) return stream;

    // 3) только видео
    this.onLog('Trying getUserMedia: video only');
    stream = await tryGet({ audio: false, video: true });
    if (stream) return stream;

    // 4) ничего — продолжаем без локальных треков
    this.onLog('Нет доступных устройств. Продолжаем без микрофона/камеры.');
    return null;
  }

  async init(ws, userId) {
    this.ws = ws;
    this.userId = userId;
    if (!this.pc) {
      const { iceServers } = await getIceServers().catch(()=>({iceServers:[{urls:['stun:stun.l.google.com:19302']}]}));
      this.pc = new RTCPeerConnection({ iceServers });

      const stream = await this.getMediaStreamWithFallback();
      this.localStream = stream;
      if (stream) {
        this.onLog(`Local tracks: a=${stream.getAudioTracks().length} v=${stream.getVideoTracks().length}`);
        if (this.localVideo) this.localVideo.srcObject = stream;
        for (const track of stream.getTracks()) {
          this.onLog(`Add local track: kind=${track.kind} id=${track.id}`);
          this.pc.addTrack(track, stream);
        }
      }
      // Гарантируем приём аудио даже без локального микрофона
      const hasLocalAudio = this.pc.getSenders().some(s => s.track && s.track.kind === 'audio');
      if (!hasLocalAudio) {
        try { this.pc.addTransceiver('audio', { direction: 'recvonly' }); } catch {}
        this.onLog('No local mic: added audio transceiver recvonly');
      }
      // Гарантируем приём видео даже без локальной камеры
      const hasLocalVideo = this.pc.getSenders().some(s => s.track && s.track.kind === 'video');
      if (!hasLocalVideo) {
        try { this.pc.addTransceiver('video', { direction: 'recvonly' }); } catch {}
        this.onLog('No local camera: added video transceiver recvonly');
      }

      this.pc.onicecandidate = (e) => {
        if (e.candidate) sendSignal(this.ws, 'ice-candidate', { candidate: e.candidate }, this.userId);
      };
      this.pc.onconnectionstatechange = () => {
        this.onLog(`PC state: ${this.pc.connectionState}`);
        if (this.pc.connectionState === 'connected') this.onConnected();
        if (['disconnected','failed','closed'].includes(this.pc.connectionState)) this.onDisconnected();
      };
      this.pc.ontrack = (e) => {
        this.onLog(`ontrack: kind=${e.track?.kind} id=${e.track?.id} streams=${e.streams?.length||0}`);
        const stream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
        this.remoteVideo.srcObject = stream;
        // На некоторых платформах требуется явный вызов play()
        try {
          this.remoteVideo.muted = false;
          this.remoteVideo.volume = 1.0;
          // Направляем звук на выбранный аудиовыход, если поддерживается
          if (this.outputDeviceId && typeof this.remoteVideo.setSinkId === 'function') {
            this.remoteVideo.setSinkId(this.outputDeviceId).catch(err=>this.onLog(`setSinkId error: ${err?.name||err}`));
          }
          const p = this.remoteVideo.play();
          if (p && typeof p.then === 'function') p.catch(err=>this.onLog(`remote play error: ${err?.name||err}`));
        } catch (e) { this.onLog(`remote playback setup error: ${e?.name||e}`); }
      };
    }
  }

  async start(ws, userId){
    if (this._started) return;
    this._started = true;
    await this.init(ws, userId);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    sendSignal(this.ws, 'offer', { sdp: offer.sdp }, this.userId);
  }

  async handleSignal(msg){
    if (msg.signalType === 'offer') {
      await this.init(this.ws, this.userId);
      const offer = { type: 'offer', sdp: msg.sdp };
      // Если это эхо нашего же оффера (шина вернула обратно), игнорируем
      if (this.pc.localDescription?.type === 'offer' && this.pc.localDescription?.sdp === msg.sdp) {
        this.onLog('Self-offer echo ignored');
        return;
      }
      // Glare handling: if not stable, rollback our local offer before applying remote offer
      if (this.pc.signalingState !== 'stable') {
        try { await this.pc.setLocalDescription({ type: 'rollback' }); }
        catch (e) { this.onLog(`rollback failed: ${e?.name||e}`); }
      }
      // If already have this remote offer applied, ignore
      if (this.pc.currentRemoteDescription && this.pc.currentRemoteDescription.sdp === msg.sdp) {
        this.onLog('Duplicate offer ignored');
        return;
      }
      await this.pc.setRemoteDescription(offer);
      this._remoteSet = true;
      // flush queued ICE
      await this._flushQueuedCandidates();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      sendSignal(this.ws, 'answer', { sdp: answer.sdp }, this.userId);
  } else if (msg.signalType === 'answer') {
      // Apply answer only when we have local offer pending
      if (!this.pc) return;
      if (this.pc.signalingState !== 'have-local-offer') {
        this.onLog(`Ignore answer in state ${this.pc.signalingState}`);
        return;
      }
      if (this.pc.currentRemoteDescription?.type === 'answer') {
        this.onLog('Duplicate answer ignored');
        return;
      }
      await this.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      this._remoteSet = true;
      await this._flushQueuedCandidates();
    } else if (msg.signalType === 'ice-candidate') {
  if (fromSelf) { /* игнорируем собственные ICE */ return; }
      // Buffer ICE until remote description is set
      if (!this._remoteSet) {
        this._candidateQueue.push(msg.candidate);
      } else if (this.pc) {
        try { await this.pc.addIceCandidate(msg.candidate); }
        catch (e) { this.onLog(`addIceCandidate failed: ${e?.name||e}`); }
      }
    }
  }

  async _flushQueuedCandidates(){
    if (!this.pc) return;
    while (this._candidateQueue.length) {
      const c = this._candidateQueue.shift();
      try { await this.pc.addIceCandidate(c); }
      catch (e) { this.onLog(`flush ICE failed: ${e?.name||e}`); }
    }
  }

  toggleMic(){
    if (!this.localStream) return false;
    const audio = this.localStream.getAudioTracks()[0];
    if (!audio) return false;
    audio.enabled = !audio.enabled;
    return audio.enabled;
  }

  toggleCam(){
    if (!this.localStream) return false;
    const video = this.localStream.getVideoTracks()[0];
    if (!video) return false;
    video.enabled = !video.enabled;
    return video.enabled;
  }

  async close(){
    try{ this.ws?.close(); }catch{}
    try{ this.pc?.close(); }catch{}
    this.pc = null; this.ws = null;
    if (this.localStream){ this.localStream.getTracks().forEach(t=>t.stop()); }
  this.localStream = null;
  this._remoteSet = false;
  this._candidateQueue = [];
  this._started = false;
  }
}
