import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const savedGlobals = {};

function setupFakeAudioEnvironment(){
  savedGlobals.windowExisted = typeof global.window !== 'undefined';
  savedGlobals.window = global.window;
  if (!savedGlobals.windowExisted){
    global.window = {};
  }
  savedGlobals.windowAudioContext = global.window?.AudioContext;
  savedGlobals.windowWebkitAudioContext = global.window?.webkitAudioContext;
  savedGlobals.windowMediaStream = global.window?.MediaStream;
  savedGlobals.MediaStream = global.MediaStream;
  savedGlobals.MediaRecorder = global.MediaRecorder;
  savedGlobals.AudioContext = global.AudioContext;
  savedGlobals.webkitAudioContext = global.webkitAudioContext;

  class FakeMediaStream {
    constructor(tracks = []){
      this._tracks = tracks;
    }
    getAudioTracks(){
      return this._tracks;
    }
  }

  class FakeSource {
    constructor(stream){
      this.stream = stream;
      this._connected = false;
    }
    connect(){ this._connected = true; }
    disconnect(){ this._connected = false; }
  }

  class FakeDestination {
    constructor(){
      this.stream = new FakeMediaStream();
    }
  }

  class FakeAudioContext {
    constructor(){
      this.state = 'running';
    }
    createMediaStreamDestination(){
      return new FakeDestination();
    }
    createMediaStreamSource(stream){
      return new FakeSource(stream);
    }
    close(){
      this.state = 'closed';
      return Promise.resolve();
    }
  }

  class FakeMediaRecorder {
    constructor(stream){
      this.stream = stream;
      this.state = 'inactive';
      this._timer = null;
    }
    start(){
      this.state = 'recording';
      this._timer = setTimeout(() => {
        if (!this.ondataavailable) return;
        const data = {
          size: 3,
          arrayBuffer: () => Promise.resolve(Uint8Array.from([1, 2, 3]).buffer),
        };
        this.ondataavailable({ data });
      }, 5);
    }
    requestData(){
      if (!this.ondataavailable) return;
      const data = {
        size: 3,
        arrayBuffer: () => Promise.resolve(Uint8Array.from([4, 5, 6]).buffer),
      };
      this.ondataavailable({ data });
    }
    stop(){
      if (this._timer){
        clearTimeout(this._timer);
        this._timer = null;
      }
      this.state = 'inactive';
    }
  }

  global.MediaStream = FakeMediaStream;
  global.MediaRecorder = FakeMediaRecorder;
  global.AudioContext = FakeAudioContext;
  global.webkitAudioContext = FakeAudioContext;
  if (global.window){
    global.window.MediaStream = FakeMediaStream;
    global.window.AudioContext = FakeAudioContext;
    global.window.webkitAudioContext = FakeAudioContext;
  }
}

function restoreAudioEnvironment(){
  if (savedGlobals.MediaStream === undefined){
    delete global.MediaStream;
    if (global.window) delete global.window.MediaStream;
  } else {
    global.MediaStream = savedGlobals.MediaStream;
    if (global.window) global.window.MediaStream = savedGlobals.windowMediaStream;
  }
  if (savedGlobals.MediaRecorder === undefined){
    delete global.MediaRecorder;
  } else {
    global.MediaRecorder = savedGlobals.MediaRecorder;
  }
  if (savedGlobals.AudioContext === undefined){
    delete global.AudioContext;
  } else {
    global.AudioContext = savedGlobals.AudioContext;
  }
  if (savedGlobals.webkitAudioContext === undefined){
    delete global.webkitAudioContext;
  } else {
    global.webkitAudioContext = savedGlobals.webkitAudioContext;
  }
  if (global.window){
    if (savedGlobals.windowAudioContext === undefined){
      delete global.window.AudioContext;
    } else {
      global.window.AudioContext = savedGlobals.windowAudioContext;
    }
    if (savedGlobals.windowWebkitAudioContext === undefined){
      delete global.window.webkitAudioContext;
    } else {
      global.window.webkitAudioContext = savedGlobals.windowWebkitAudioContext;
    }
    if (savedGlobals.windowMediaStream === undefined){
      delete global.window.MediaStream;
    } else {
      global.window.MediaStream = savedGlobals.windowMediaStream;
    }
  }
  if (!savedGlobals.windowExisted){
    delete global.window;
  } else {
    global.window = savedGlobals.window;
  }
}

describe('VoiceCaptureMixer', () => {
  let VoiceCaptureMixer;
  let mixer;
  let chunks;
  let track;
  let localStream;

  beforeEach(async () => {
    vi.useFakeTimers();
    setupFakeAudioEnvironment();
    chunks = [];
    track = { id: 'track-1', readyState: 'live', enabled: true };
    localStream = {
      getAudioTracks: () => [track],
    };
    ({ VoiceCaptureMixer } = await import('../modules/voice/capture_mixer.js'));
    mixer = new VoiceCaptureMixer({
      getLocalStream: () => localStream,
      getPeers: () => new Map(),
      chunkMs: 10,
      onChunk: (bytes) => chunks.push(bytes),
      onLog: () => {},
    });
  });

  afterEach(() => {
    try { mixer?.stop(); } catch {}
    restoreAudioEnvironment();
    vi.useRealTimers();
  });

  it('emits chunks after restart with the same tracks', async () => {
    mixer.start();
    await vi.advanceTimersByTimeAsync(6);
    await Promise.resolve();
    expect(chunks.length).toBeGreaterThan(0);

    mixer.stop();
    await Promise.resolve();

    mixer.start();
    await vi.advanceTimersByTimeAsync(6);
    await Promise.resolve();

    expect(chunks.length).toBeGreaterThan(1);
  });
});
