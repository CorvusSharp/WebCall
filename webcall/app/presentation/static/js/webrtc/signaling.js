// signaling.js — оркестрация сигналинга (offer/answer/candidates, glare)
import { sendSignal } from '../signal.js';

export class SignalingOrchestrator {
  constructor({ logger, ensurePeer, getState, getLocalStream, userIdProvider, wsProvider, updateAllPeerTracks, forceVideoSenderSync, scheduleWatchdog }) {
    this._log = logger || (()=>{});
    this._ensurePeer = ensurePeer; // async (peerId)=> peerState
    this._getState = getState; // ()=> ({ userId, peersMap })
    this._getLocalStream = getLocalStream; // ()=> MediaStream|null
    this._userIdProvider = userIdProvider; // ()=> userId
    this._wsProvider = wsProvider; // ()=> ws
    this._updateAllPeerTracks = updateAllPeerTracks; // ()=> Promise<void>
    this._forceVideoSenderSync = forceVideoSenderSync; // ()=>void
    this._scheduleWatchdog = scheduleWatchdog; // (peerId)=>void
    this._pendingGlare = new Map(); // peerId -> { sdp, ts }
  }

  async handle(msg, mediaBinder){
    const myId = this._userIdProvider();
    if (msg?.fromUserId && myId && msg.fromUserId === myId) return;
    if (msg?.targetUserId && myId && msg.targetUserId !== myId) return;

    const ws = this._wsProvider();
    const peerId = msg.fromUserId;
    const peer = await this._ensurePeer(peerId);
    const pc = peer.pc;

    if (mediaBinder && !peer.handlers) {
      mediaBinder(peerId, { onTrack: ()=>{}, onLevel: ()=>{}, onSinkChange: ()=>{} });
    }

    if (msg.signalType === 'offer') {
      const desc = { type: 'offer', sdp: msg.sdp };
      this._log(`📥 Received OFFER from ${peerId.slice(0,8)}`);
      const offerCollision = peer.makingOffer || pc.signalingState !== 'stable';
      peer.ignoreOffer = !peer.polite && offerCollision;
      if (peer.ignoreOffer){
        this._log(`⏭️ Ignore offer (collision, impolite) from ${peerId.slice(0,8)}`);
        this._pendingGlare.set(peerId, { sdp: msg.sdp, ts: Date.now() });
        setTimeout(()=> this._retryGlare(peerId), 150);
        return;
      }
      try {
        if (offerCollision) await pc.setLocalDescription({ type: 'rollback' });
        await pc.setRemoteDescription(desc);
        peer.remoteSet = true;
        await this._flushCandidates(peerId);
        await this._prepareAudioBeforeAnswer(peerId, pc, peer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendSignal(ws, 'answer', { sdp: answer.sdp }, myId, peerId);
        this._log(`📤 Answered offer → ${peerId.slice(0,8)}`);
        if (this._getLocalStream()) await this._updateAllPeerTracks();
        this._scheduleWatchdog(peerId);
      } catch(e){ this._log(`SRD(offer)[${peerId.slice(0,8)}]: ${e?.name||e}`); }

    } else if (msg.signalType === 'answer') {
      if (pc.signalingState !== 'have-local-offer'){ this._log(`Ignore answer in ${pc.signalingState}`); return; }
      try {
        this._log(`📥 Received ANSWER from ${peerId.slice(0,8)}`);
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        peer.remoteSet = true;
        await this._flushCandidates(peerId);
        if (this._getLocalStream()) await this._updateAllPeerTracks();
        this._scheduleWatchdog(peerId);
      } catch(e){ this._log(`SRD(answer)[${peerId.slice(0,8)}]: ${e?.name||e}`); }

    } else if (msg.signalType === 'ice-candidate' || msg.signalType === 'ice_candidate') {
      this._log(`🧊 ICE from ${peerId.slice(0,8)}`);
      if (!peer.remoteSet) peer.candidates.push(msg.candidate);
      else {
        try { await pc.addIceCandidate(msg.candidate); }
        catch(e){ this._log(`addIce[${peerId.slice(0,8)}]: ${e?.name||e}`); }
      }
    }
  }

  async startOffer(peerId){
    const myId = this._userIdProvider();
    const ws = this._wsProvider();
    const st = await this._ensurePeer(peerId);
    const pc = st.pc;
    if (st.polite){ this._log(`Not initiator for ${peerId.slice(0,8)}`); return; }
    if (pc.signalingState !== 'stable'){ this._log(`Skip offer in ${pc.signalingState}`); return; }
    try {
      st.makingOffer = true;
      await this._prepareAudioForOffer(st, pc);
      this._forceVideoSenderSync();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal(ws, 'offer', { sdp: offer.sdp }, myId, peerId);
      this._log(`📤 Sent offer (manual) → ${peerId.slice(0,8)}`);
    } catch(e){
      this._log(`startOffer(${peerId.slice(0,8)}): ${e?.name||e}`);
    } finally { st.makingOffer = false; }
  }

  async _prepareAudioBeforeAnswer(peerId, pc, peer){
    try {
      let at = this._getLocalStream()?.getAudioTracks?.()[0];
      if (!at){ /* вызывающая сторона сама адаптирует */ }
      let tx = pc.getTransceivers().find(t => (t.receiver?.track?.kind==='audio') || t.mid === '0');
      if (!tx) tx = pc.addTransceiver('audio', { direction: 'sendrecv' });
      tx.direction = 'sendrecv';
      if (at) await tx.sender.replaceTrack(at);
      peer.audioTransceiver = tx;
    } catch(e){ this._log(`prepareAudioBeforeAnswer: ${e?.name||e}`); }
  }
  async _prepareAudioForOffer(st, pc){
    try {
      let at = this._getLocalStream()?.getAudioTracks?.()[0];
      let tx = pc.getTransceivers().find(t => t.sender?.track?.kind==='audio' || t.receiver?.track?.kind==='audio');
      if (!tx) tx = pc.addTransceiver('audio', { direction:'sendrecv'});
      else tx.direction = 'sendrecv';
      if (at) await tx.sender.replaceTrack(at);
      st.audioTransceiver = tx;
    } catch(e){ this._log(`prepareAudioForOffer: ${e?.name||e}`); }
  }

  async _flushCandidates(peerId){
    const st = await this._ensurePeer(peerId);
    while (st.candidates.length){
      const c = st.candidates.shift();
      try { await st.pc.addIceCandidate(c); } catch(e){ this._log(`flush ICE[${peerId.slice(0,8)}]: ${e?.name||e}`); }
    }
  }

  _retryGlare(peerId){
    try {
      const st = this._getState().peersMap.get(peerId) || this._ensurePeer(peerId);
      const pc = st.pc;
      if (pc.signalingState !== 'stable'){ setTimeout(()=> this._retryGlare(peerId), 120); return; }
      const pending = this._pendingGlare.get(peerId); if (!pending) return;
      this._pendingGlare.delete(peerId);
      this._log(`🔄 Retrying glare offer from ${peerId.slice(0,8)}`);
      this.handle({ signalType:'offer', fromUserId: peerId, sdp: pending.sdp, targetUserId: this._userIdProvider() }).catch(()=>{});
    } catch {}
  }
}
