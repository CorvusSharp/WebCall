// diagnostics.js — диагностика аудио/видео и трансиверов
export class DiagnosticsManager {
  constructor({ logger } = {}) {
    this._logger = logger || (()=>{});
    this._env = { getLocalStream: ()=>null, getPeers: ()=> new Map() };
  }
  bindEnvironment(env){
    this._env = Object.assign(this._env, env||{});
  }
  _log(m){ try { this._logger(m); } catch {} }

  async diagnoseAudio(){
    const localStream = this._env.getLocalStream();
    const peers = this._env.getPeers();
    this._log('=== 🔊 АУДИО ДИАГНОСТИКА ===');
    if (localStream){
      const ats = localStream.getAudioTracks();
      this._log(`📱 Локальный поток: ${ats.length} аудио треков`);
      ats.forEach((t,i)=> this._log(`🎤 Трек ${i}: enabled=${t.enabled}, readyState=${t.readyState}, muted=${t.muted}`));
    } else {
      this._log('❌ НЕТ локального потока!');
    }
    this._log(`🔗 Активных соединений: ${peers.size}`);

    for (const [peerId, st] of peers){
      const pc = st.pc;
      this._log(`--- Peer ${peerId.slice(0,8)} ---`);
      this._log(`📊 Состояние: ${pc.connectionState}`);
      this._log(`🧊 ICE: ${pc.iceConnectionState}`);
      this._log(`📡 Signaling: ${pc.signalingState}`);
      try {
        const localSdp = pc.localDescription?.sdp || ''; const remoteSdp = pc.remoteDescription?.sdp || '';
        const mAudioLocal = (localSdp.match(/^m=audio /gm)||[]).length;
        const mAudioRemote = (remoteSdp.match(/^m=audio /gm)||[]).length;
        this._log(`📝 SDP m=audio local=${mAudioLocal} remote=${mAudioRemote}`);
      } catch {}
      try {
        pc.getTransceivers().filter(t=> t.receiver?.track?.kind==='audio' || t.sender?.track?.kind==='audio').forEach((t,idx)=>{
          this._log(`🔁 TR#a${idx} mid=${t.mid} dir=${t.direction} cur=${t.currentDirection} hasSender=${!!t.sender?.track} hasRecv=${!!t.receiver?.track}`);
        });
      } catch {}
      // Статистика
      try {
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
      } catch(e){ this._log(`❌ Ошибка получения статистики: ${e}`); }
    }
    this._log('=== КОНЕЦ ДИАГНОСТИКИ ===');
  }

  async diagnoseVideo(){
    const localStream = this._env.getLocalStream();
    const peers = this._env.getPeers();
    this._log('=== 🎥 ВИДЕО ДИАГНОСТИКА ===');
    if (localStream){
      const vts = localStream.getVideoTracks();
      this._log(`📱 Локальный поток: ${vts.length} видео трек(а)`);
      vts.forEach((t,i)=> this._log(`📸 Трек ${i}: id=${t.id}, label="${t.label}", state=${t.readyState}, enabled=${t.enabled}`));
    } else {
      this._log('❌ НЕТ локального потока (video)');
    }
    for (const [peerId, st] of peers){
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
