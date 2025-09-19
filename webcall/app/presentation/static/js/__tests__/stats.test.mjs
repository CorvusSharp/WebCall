import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { startStatsLoop, stopStatsLoop } from '../modules/stats.js';
import { appState } from '../modules/core/state.js';

function makeFakePeer(id){
  return {
    pc: {
      async getStats(){
        return new Map([
          ['out1',{ type:'outbound-rtp', kind:'audio', bytesSent: 4000, packetsSent: 50 }],
          ['in1',{ type:'inbound-rtp', kind:'audio', bytesReceived: 8000, packetsReceived: 100, packetsLost: 2 }],
          ['rtt',{ type:'remote-inbound-rtp', kind:'audio', packetsLost: 3, roundTripTime: 0.05 }],
        ]);
      }
    }
  };
}

describe('stats', () => {
  beforeEach(() => {
    appState.rtc = { peers: new Map([['peer1', makeFakePeer('peer1')]]) };
  });
  afterEach(() => { stopStatsLoop(); appState.rtc = null; });

  it('emits samples via onSample callback', async () => {
    const got = [];
    await new Promise(resolve => {
      startStatsLoop({ intervalMs: 10, onSample: (s)=>{ got.push(s); if (got.length>=1){ resolve(); } } });
    });
    expect(got.length).toBeGreaterThan(0);
    expect(got[0].peers[0]).toHaveProperty('outAudioBitrate');
  });
});
