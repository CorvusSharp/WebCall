// webrtc_manager.js — новый фасад поверх модульных менеджеров
// Цель: предоставить более компактный API и изолировать внутреннюю реализацию.
// Централизованные импорты из единой точки (webrtc/index.js)
import { 
  MediaManager,
  PeerConnectionManager,
  SignalingOrchestrator,
  CanvasCompositeManager,
  MetricsManager,
  AudioLevelAnalyzer,
  DiagnosticsManager,
  DefaultVideoAdaptationStrategy,
  EventBus
} from './webrtc/index.js';
import { sendSignal } from './signal.js';
import { getIceServers } from './api.js';

export class WebCallClient {
  constructor(opts = {}){
    this._opts = opts;
    this.onLog = opts.onLog || (()=>{});
  // Legacy колбеки (сохраняем ради обратной совместимости)
  this.onPeerState = opts.onPeerState || (()=>{});
  this.onVideoState = opts.onVideoState || (()=>{});
  // EventBus как новая точка подписки
  this.events = new EventBus((m)=> this._log(m));
    this.localVideo = opts.localVideo || null;
    this.outputDeviceId = opts.outputDeviceId || null;

    // state
    this.ws = null; this.userId = null; this.iceConfig = null;
    this.localStream = null; this.preferred = { micId: undefined, camId: undefined };
    this.peers = new Map();
    this._cameraTrack = null; this._screenTrack = null; this._currentVideoKind='none';
    this._cameraSender=null; this._screenSender=null; this._videoSender=null;

    // managers
  this._media = new MediaManager({ logger: m=> this._log(m), onVideoState: (k,t)=> { this._safe(()=> this.onVideoState(k,t)); this.events.emit('video:state', { kind:k, track:t }); } });
    this._peers = new PeerConnectionManager({
      logger: m=> this._log(m),
      iceConfigProvider: async ()=>{ if(!this.iceConfig){ try{ this.iceConfig = await getIceServers(); }catch{ this.iceConfig = { iceServers:[{ urls:'stun:stun.l.google.com:19302'}] }; } } return this.iceConfig; },
  onPeerState: (pid,key,val)=> { this._safe(()=> this.onPeerState(pid,key,val)); this.events.emit('peer:state', { peerId:pid, key, value:val }); },
      isPoliteFn: (a,b)=> String(a)>String(b)
    });
    this._signaling = new SignalingOrchestrator({
      logger: m=> this._log(m),
      ensurePeer: (pid)=> this._ensurePeer(pid),
      getState: ()=> ({ userId: this.userId, peersMap: this.peers }),
      getLocalStream: ()=> this.localStream,
      userIdProvider: ()=> this.userId,
      wsProvider: ()=> this.ws,
      updateAllPeerTracks: ()=> this.updateAllPeerTracks(),
      forceVideoSenderSync: ()=> this._ensureExistingVideoSenders(),
      scheduleWatchdog: (pid)=> this._peers.scheduleRemoteVideoWatchdog?.(pid, { hasLocalVideo:!!(this._cameraTrack || this._screenTrack) })
    });
    this._metrics = new MetricsManager({ logger: m=> this._log(m) });
    this._metrics.bindEnvironment({ getTracks: ()=> ({ cameraTrack: this._cameraTrack?.readyState==='live'?this._cameraTrack:null, screenTrack: this._screenTrack?.readyState==='live'?this._screenTrack:null, kind: this._currentVideoKind }) });
    this._audioLevel = new AudioLevelAnalyzer({ logger: m=> this._log(m) });
    this._diagnostics = new DiagnosticsManager({ logger: m=> this._log(m) });
    this._diagnostics.bindEnvironment({ getLocalStream: ()=> this.localStream, getPeers: ()=> this.peers });
    this._composite = new CanvasCompositeManager({ logger: m=> this._log(m), getTracks: ()=> ({ cam: this._cameraTrack, scr: this._screenTrack }), onCompositeTrack: (track)=> this._attachOrReplaceVideoSender(track) });
    // Стратегия адаптации видео (пока заглушка, но точка расширения)
    this._videoStrategy = (opts.videoStrategy instanceof Function) ? new opts.videoStrategy({
      getSender: ()=> this._videoSender,
      getCameraTrack: ()=> this._cameraTrack,
      logger: (msg)=> this._log(msg)
    }) : new DefaultVideoAdaptationStrategy({
      getSender: ()=> this._videoSender,
      getCameraTrack: ()=> this._cameraTrack,
      logger: (msg)=> this._log(msg)
    });

    this._media.bindEnvironment({
      getOrCreateLocalStream: async ()=>{ if(!this.localStream){ const s = await this._getLocalMedia(); this.localStream = s|| new MediaStream(); if(this.localVideo) this.localVideo.srcObject = this.localStream; } return this.localStream; },
      attachVideoTrack: (track)=> this._attachOrReplaceVideoSender(track),
      updateLocalPreview: ()=> this._updateLocalPreview()
    });
  }

  _safe(fn){ try { fn(); } catch {} }
  _log(m){ this._safe(()=> this.onLog(m)); }

  // Public API (минимальный «поверх» старого)
  async init(ws, userId, devices){
    this.ws = ws; this.userId = userId; devices = devices||{}; if(devices.micId) this.preferred.micId=devices.micId; if(devices.camId) this.preferred.camId=devices.camId;
    if(!this.localStream){ const s = await this._getLocalMedia(); this.localStream = s; if(s && this.localVideo) this.localVideo.srcObject = s; if(this.localStream) await this.updateAllPeerTracks(); }
    this._peers.bindSession({ manager:this, ws:this.ws, addLocalTracks:(pc)=> this._addLocalTracks(pc), ensureVideoSender:(pid,track)=> this.ensureVideoSender(pid,track) });
  }

  async handleSignal(msg, mediaBinder){ return this._signaling.handle(msg, mediaBinder); }
  async startOffer(peerId){ return this._signaling.startOffer(peerId); }

  getOutputDeviceId(){ return this.outputDeviceId; }
  setPreferredDevices({ mic, cam, spk }){ if(mic) this.preferred.micId=mic; if(cam) this.preferred.camId=cam; if(spk) this.outputDeviceId=spk; for(const [,st] of this.peers){ this._safe(()=> st.handlers?.onSinkChange?.(this.outputDeviceId)); } }

  async toggleMic(){
    if(this.localStream){ const tr = this.localStream.getAudioTracks()[0]; if(!tr) return false; tr.enabled = !tr.enabled; return tr.enabled; }
    const s = await this._getLocalMedia(); if(!s) return false; this.localStream=s; if(this.localVideo) this.localVideo.srcObject=s; await this.updateAllPeerTracks(); return true;
  }
  async toggleCameraStream(){ return this._media.toggleCamera(this.preferred.camId); }
  async startCamera(){ const track = await this._media.startCamera(this.preferred.camId); if(track){ try{ this._videoStrategy?.onTrackStarted(track); }catch{} this._afterCameraStartForceNegotiation(); } return !!track; }
  async startScreenShare(){ const t = await this._media.startScreenShare(); return !!t; }
  stopCamera(){ this._media.stopCamera(); }
  stopScreenShare(){ this._media.stopScreenShare(); }
  stopVideo(){ this.stopCamera(); this.stopScreenShare(); }
  async toggleScreenShare(){ return this._media.toggleScreenShare(); }
  async switchCamera(deviceId){ return this._switchCamera(deviceId); }
  async switchScreenShareWindow(){ return this._switchScreenShareWindow(); }

  enableComposite(canvas){ return this._composite.enable(canvas); }
  disableComposite(){ return this._composite.disable(); }
  toggleComposite(canvas){ return this._composite.toggle(canvas); }

  async close(){ try{ this.ws?.close(); }catch{}; for(const [,st] of this.peers){ try{ st.pc.onicecandidate=null; st.pc.close(); }catch{}; if(st.level?.raf) cancelAnimationFrame(st.level.raf); clearTimeout(st.iceFailTimer); } this.peers.clear(); if(this.localStream) this.localStream.getTracks().forEach(t=> t.stop()); this.localStream=null; this._cameraTrack=null; this._screenTrack=null; this._cameraSender=null; this._screenSender=null; try{ this.disableComposite(); }catch{}; this._metrics.stopLoop(); try{ this.events.emit('session:closed',{}); this.events.clear(); }catch{} }
  async diagnoseAudio(){ const r = await this._diagnostics.diagnoseAudio(); try{ this.events.emit('diagnostics:audio', { result:r }); }catch{} return r; }
  async diagnoseVideo(){ const r = await this._diagnostics.diagnoseVideo(); try{ this.events.emit('diagnostics:video', { result:r }); }catch{} return r; }

  // --- Internal helpers (портированы из старого класса, минимизированы) ---
  async _getLocalMedia(){
    const baseAudio = { echoCancellation:true, noiseSuppression:true, autoGainControl:true, deviceId: this.preferred.micId? { exact:this.preferred.micId }: undefined };
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: baseAudio, video:false }); return s; } catch(e){ this._log('getUserMedia fail '+(e?.name||e)); return null; }
  }
  async _ensurePeer(peerId){
    const rec = await this._peers.ensurePeer(peerId, { onTrackCallback: (pid, stream)=>{ if(!this.peers.has(pid)) this.peers.set(pid, this._peers.get(pid)); const st = this.peers.get(pid); this._safe(()=> st.handlers?.onTrack?.(stream)); }});
    if(!this.peers.has(peerId)) this.peers.set(peerId, rec);
    if(this.localStream) this._addLocalTracks(rec.pc);
    this._ensureExistingVideoSenders();
    return rec;
  }
  async updateAllPeerTracks(){ if(!this.localStream) return; const at = this.localStream.getAudioTracks()[0]; if(!at) return; for(const [pid, st] of this.peers){ const sender = (st.audioTransceiver?.sender) || st.pc.getSenders().find(s=> s.track?.kind==='audio'); if(!sender) continue; try { await sender.replaceTrack(at); } catch{} } }
  _attachOrReplaceVideoSender(track){ try { for(const [pid, peer] of this.peers){ const senders = peer.pc.getSenders().filter(s=> s.track && s.track.kind==='video'); const type = track._wcType || (track.label.toLowerCase().includes('screen') ? 'screen':'camera'); let target = (type==='screen'? this._screenSender : this._cameraSender); if(target && !senders.includes(target)) target=null; if(!target){ let free = peer.pc.getSenders().find(s=> !s.track && s.transport); if(free){ free.replaceTrack(track).catch(()=>{}); target=free; try{ const trPromote = peer.pc.getTransceivers().find(t=> t.sender===free); if(trPromote && trPromote.direction==='recvonly'){ trPromote.direction='sendrecv'; } }catch{} } else { target = peer.pc.addTrack(track, this.localStream); } } else if(target.track !== track){ target.replaceTrack(track).catch(()=>{}); } if(type==='screen') this._screenSender=target; else this._cameraSender=target; this._ensureVideoFlow(pid, peer); this._peers.scheduleRemoteVideoWatchdog?.(pid, { hasLocalVideo:true }); } const firstPeer = this.peers.values().next().value; if(firstPeer){ this._videoSender = firstPeer.pc.getSenders().find(s=> s.track && s.track.kind==='video') || this._videoSender; } }catch{} }
  _ensureVideoFlow(peerId, peerState){ setTimeout(()=>{ try { const pc = peerState.pc; const hasVideoSender = pc.getSenders().some(s=> s.track && s.track.kind==='video'); if(!hasVideoSender) return; const sdp = pc.localDescription?.sdp||''; const mVideoCount = (sdp.match(/\nm=video /g)||[]).length; const anyActive = pc.getTransceivers().some(t=> t.sender?.track?.kind==='video' && /send/.test(t.currentDirection||'')); if(hasVideoSender && !anyActive && mVideoCount===0 && pc.signalingState==='stable'){ pc.createOffer().then(of=> pc.setLocalDescription(of).then(()=> sendSignal(this.ws,'offer',{ sdp: of.sdp }, this.userId, peerId))).catch(()=>{}); } } catch{} },220); }
  _updateLocalPreview(){ if(!this.localVideo) return; if(!this.localStream){ this.localVideo.srcObject=null; try{ this.localVideo.load(); }catch{} return; } const showTrack = this._screenTrack || this._cameraTrack; if(!showTrack){ this.localVideo.srcObject = null; try{ this.localVideo.load(); }catch{} return; } const ms = new MediaStream([showTrack]); this.localVideo.srcObject = ms; }
  _ensureExistingVideoSenders(){ try { const tracks=[]; if(this._cameraTrack?.readyState==='live') tracks.push(this._cameraTrack); if(this._screenTrack?.readyState==='live') tracks.push(this._screenTrack); if(!tracks.length) return; tracks.forEach(t=> this._attachOrReplaceVideoSender(t)); } catch {} }
  _afterCameraStartForceNegotiation(){ setTimeout(()=>{ for(const [pid, st] of this.peers){ const pc = st.pc; if(pc.signalingState==='stable'){ const hasVideoSender = pc.getSenders().some(s=> s.track && s.track.kind==='video'); const need = hasVideoSender && !pc.getTransceivers().some(t=> t.sender?.track?.kind==='video' && /send/.test(t.currentDirection||'')); if(need){ pc.createOffer().then(of=> pc.setLocalDescription(of).then(()=> sendSignal(this.ws,'offer',{ sdp: of.sdp }, this.userId, pid))).catch(()=>{}); } } } },500); }
  async _switchCamera(deviceId){ this.preferred.camId=deviceId; if(this._currentVideoKind!=='camera') return false; try{ const gum = await navigator.mediaDevices.getUserMedia({ video:{ deviceId:{ exact:deviceId } }, audio:false }); const newTrack = gum.getVideoTracks()[0]; if(!newTrack) return false; const oldTracks = this.localStream?.getVideoTracks()||[]; if(!this.localStream) this.localStream = await this._getLocalMedia() || new MediaStream(); oldTracks.forEach(t=>{ try{ t.stop(); }catch{}; try{ this.localStream.removeTrack(t); }catch{} }); this.localStream.addTrack(newTrack); this._attachOrReplaceVideoSender(newTrack); if(this.localVideo) this.localVideo.srcObject = this.localStream; return true; } catch { return false; } }
  async _switchScreenShareWindow(){ if(!this._screenTrack) return false; try{ const ds = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:false }); const newTrack = ds.getVideoTracks()[0]; if(!newTrack) return false; newTrack._wcType='screen'; const old = this._screenTrack; this._screenTrack = newTrack; if(this.localStream){ try{ if(old){ old.stop(); this.localStream.removeTrack(old); } }catch{} this.localStream.addTrack(newTrack); } this._attachOrReplaceVideoSender(newTrack); this._updateLocalPreview(); return true; } catch{ return false; } }
  _addLocalTracks(pc){ try { if(!this.localStream) return; const at = this.localStream.getAudioTracks()[0]; if(at){ const has = pc.getSenders().some(s=> s.track && s.track.kind==='audio'); if(!has) pc.addTrack(at, this.localStream); } } catch {}
  }
}
