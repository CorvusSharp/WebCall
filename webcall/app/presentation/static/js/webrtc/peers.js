// peers.js — управление RTCPeerConnection экземплярами
import { sendSignal } from '../signal.js';

export class PeerConnectionManager {
  constructor({ logger, iceConfigProvider, onPeerState, isPoliteFn }) {
    this._log = logger || (()=>{});
    this._iceConfigProvider = iceConfigProvider; // async () => RTCConfiguration
    this._onPeerState = onPeerState || (()=>{});
    this._isPolite = isPoliteFn || ((myId, otherId) => String(myId) > String(otherId));
    this._peers = new Map(); // peerId -> state
    this._userId = null;
    this._ws = null;
  }

  bindSession({ userId, ws }) { this._userId = userId; this._ws = ws; }
  get peersMap() { return this._peers; }
  get(peerId){ return this._peers.get(peerId); }
  listIds(){ return Array.from(this._peers.keys()); }

  async ensurePeer(peerId, { onTrackCallback }) {
    if (this._peers.has(peerId)) return this._peers.get(peerId);
    const iceConfig = await this._iceConfigProvider();
    const pc = new RTCPeerConnection({ ...iceConfig, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    const state = {
      pc,
      stream: new MediaStream(),
      candidates: [],
      remoteSet: false,
      handlers: null,
      makingOffer: false,
      ignoreOffer: false,
      polite: this._isPolite(this._userId, peerId),
      iceFailTimer: null,
      audioTransceiver: null,
      videoWatchdogTimer: null,
    };

    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) {
        sendSignal(this._ws, 'ice-candidate', { candidate: e.candidate }, this._userId, peerId);
        this._log(`🧊 Sent ICE candidate to ${peerId.slice(0,8)}: ${e.candidate.candidate}`);
      }
    });

    pc.addEventListener('track', (e) => {
      try { this._log(`Получен трек от ${peerId.slice(0,8)}: ${e.track.kind}`); } catch {}
      if (e.track && !state.stream.getTracks().some(t=> t.id === e.track.id)) {
        state.stream.addTrack(e.track);
      }
      if (state.handlers?.onTrack) {
        try { state.handlers.onTrack(state.stream); } catch {}
      } else if (onTrackCallback) {
        try { onTrackCallback(peerId, state.stream); } catch {}
      }
    });

    pc.addEventListener('negotiationneeded', async () => {
      if (state.makingOffer) return;
      try {
        state.makingOffer = true;
        this._log(`⚙️ negotiationneeded → createOffer (polite=${state.polite}) for ${peerId.slice(0,8)}`);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal(this._ws, 'offer', { sdp: offer.sdp }, this._userId, peerId);
        this._log(`📤 Sent offer → ${peerId.slice(0,8)} (negotiationneeded)`);
      } catch(e){ this._log(`negotiationneeded(${peerId.slice(0,8)}): ${e?.name||e}`); }
      finally { state.makingOffer = false; }
    });

    pc.addEventListener('connectionstatechange', () => {
      const s = pc.connectionState;
      try { this._onPeerState(peerId, 'net', s); } catch {}
      this._log(`PC(${peerId.slice(0,8)}) = ${s}`);
      if (s === 'failed') {
        this.iceRestart(peerId).catch(()=>{});
      } else if (s === 'disconnected') {
        clearTimeout(state.iceFailTimer);
        state.iceFailTimer = setTimeout(()=>{ if (pc.connectionState === 'disconnected') this.iceRestart(peerId).catch(()=>{}); }, 2000);
      } else if (s === 'connected' || s === 'completed') {
        clearTimeout(state.iceFailTimer); state.iceFailTimer = null;
      }
    });

    // Превентивные transceivers
    try {
      const hasVideoTr = pc.getTransceivers().some(t=> t.receiver?.track?.kind==='video' || t.sender?.track?.kind==='video');
      if (!hasVideoTr) pc.addTransceiver('video', { direction: 'recvonly' });
      const hasAudioTr = pc.getTransceivers().some(t=> t.receiver?.track?.kind==='audio' || t.sender?.track?.kind==='audio');
      if (!hasAudioTr) {
        const atr = pc.addTransceiver('audio', { direction:'recvonly'});
        state.audioTransceiver = atr;
      }
    } catch {}

    this._peers.set(peerId, state);
    return state;
  }

  async iceRestart(peerId){
    const st = this._peers.get(peerId); if (!st) return;
    this._log(`ICE-restart → ${peerId.slice(0,8)}`);
    try {
      const offer = await st.pc.createOffer({ iceRestart: true });
      await st.pc.setLocalDescription(offer);
      sendSignal(this._ws, 'offer', { sdp: offer.sdp }, this._userId, peerId);
    } catch(e){ this._log(`ICE-restart(${peerId.slice(0,8)}): ${e?.name||e}`); }
  }

  scheduleRemoteVideoWatchdog(peerId, { hasLocalVideo }){
    try {
      const st = this._peers.get(peerId); if (!st) return;
      if (st.videoWatchdogTimer) clearTimeout(st.videoWatchdogTimer);
      if (!hasLocalVideo) return;
      st.videoWatchdogTimer = setTimeout(()=>{
        try {
          const pc = st.pc;
          const remoteVideoTracks = st.stream.getVideoTracks();
            if (remoteVideoTracks.length > 0) return;
            if (pc.signalingState !== 'stable') return;
            if (st.polite) return;
            this._log(`🛠 Watchdog: нет входящего видео от ${peerId.slice(0,8)} → форсируем повторный offer`);
            pc.createOffer().then(of=> pc.setLocalDescription(of).then(()=>{
              sendSignal(this._ws, 'offer', { sdp: of.sdp }, this._userId, peerId);
              this._log(`📤 Sent watchdog offer → ${peerId.slice(0,8)}`);
            })).catch(e=> this._log(`watchdogOffer(${peerId.slice(0,8)}): ${e?.name||e}`));
        } catch {}
      }, 2000);
    } catch {}
  }

  bindPeerMedia(peerId, handlers){
    const st = this._peers.get(peerId); if (!st) return;
    st.handlers = Object.assign({}, st.handlers||{}, handlers||{});
    if (st.stream && (st.stream.getAudioTracks().length || st.stream.getVideoTracks().length)){
      try { st.handlers?.onTrack?.(st.stream); } catch {}
    }
  }
}
