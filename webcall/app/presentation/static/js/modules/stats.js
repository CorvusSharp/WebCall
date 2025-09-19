// modules/stats.js
// Сбор периодической статистики WebRTC и эмит 'stats:sample' через event bus.

import { bus } from './core/event_bus.js';
import { appState } from './core/state.js';

/**
 * @typedef {Object} PeerStatSample
 * @property {string} peerId
 * @property {number} timestamp
 * @property {number} [outAudioBitrate]
 * @property {number} [inAudioBitrate]
 * @property {number} [rtt]
 * @property {number} [packetLossIn]
 * @property {number} [packetLossOut]
 */

/**
 * @typedef {Object} StatsSample
 * @property {number} ts
 * @property {PeerStatSample[]} peers
 */

let intervalId = null;
let lastTotals = new Map(); // peerId -> { bytesIn, bytesOut, ts }

/**
 * Запуск цикла сбора статистики.
 * @param {object} opts
 * @param {number} [opts.intervalMs=3000]
 * @param {(StatsSample)=>void} [opts.onSample]
 */
export function startStatsLoop(opts={}){
  stopStatsLoop();
  const intervalMs = opts.intervalMs ?? 3000;
  intervalId = setInterval(async ()=>{
    if (!appState.rtc) return;
    const samples = [];
    for (const [peerId, st] of appState.rtc.peers){
      const pc = st.pc; if (!pc) continue;
      try {
        const stats = await pc.getStats();
        let bytesIn = 0, bytesOut = 0, rtt = undefined, packetsRecv = 0, packetsLost = 0, packetsSent = 0, packetsSentLost = 0;
        stats.forEach(r=>{
          if (r.type === 'inbound-rtp' && r.kind === 'audio'){
            bytesIn += r.bytesReceived || 0; packetsRecv += r.packetsReceived||0; packetsLost += r.packetsLost||0;
          } else if (r.type === 'outbound-rtp' && r.kind === 'audio'){
            bytesOut += r.bytesSent || 0; packetsSent += r.packetsSent||0; // нет packetsLost у outbound, иногда отдельные отчёты
          } else if (r.type === 'remote-inbound-rtp' && r.kind === 'audio'){
            // удалённая сторона сообщает о потере наших пакетов
            packetsSentLost += r.packetsLost || 0; if (typeof r.roundTripTime === 'number') rtt = r.roundTripTime*1000;
          }
        });
        const now = Date.now();
        const prev = lastTotals.get(peerId) || { bytesIn, bytesOut, ts: now };
        const dt = (now - prev.ts)/1000 || 1;
        const outAudioBitrate = (bytesOut - prev.bytesOut) * 8 / dt; // bps
        const inAudioBitrate = (bytesIn - prev.bytesIn) * 8 / dt;
        lastTotals.set(peerId, { bytesIn, bytesOut, ts: now });
        const sample = {
          peerId,
          timestamp: now,
          outAudioBitrate: outAudioBitrate >=0 ? Math.round(outAudioBitrate) : undefined,
          inAudioBitrate: inAudioBitrate >=0 ? Math.round(inAudioBitrate) : undefined,
          rtt,
          packetLossIn: packetsRecv ? packetsLost/packetsRecv : undefined,
          packetLossOut: packetsSent ? packetsSentLost/packetsSent : undefined,
        };
        samples.push(sample);
      } catch {}
    }
    if (!samples.length) return;
    const payload = { ts: Date.now(), peers: samples };
    bus.emit('stats:sample', payload);
    if (opts.onSample) { try { opts.onSample(payload); } catch {} }
  }, intervalMs);
}

export function stopStatsLoop(){ if (intervalId){ clearInterval(intervalId); intervalId=null; } }

export function formatBitrate(v){ if (v==null) return '-'; if (v<1000) return v+'bps'; if (v<1e6) return (v/1000).toFixed(1)+'kbps'; return (v/1e6).toFixed(1)+'Mbps'; }
