// webrtc.js — thin compatibility wrapper. All real logic in WebCallClient (webrtc_manager.js)
// Используем фасад WebCallClient. При потребности можно также импортировать части из './webrtc/index.js'
import { WebCallClient } from './webrtc_manager.js';

export class WebRTCManager {
  constructor(opts){ this._client = new WebCallClient(opts); }
  init(...a){ return this._client.init(...a); }
  handleSignal(...a){ return this._client.handleSignal(...a); }
  startOffer(...a){ return this._client.startOffer(...a); }
  toggleMic(...a){ return this._client.toggleMic(...a); }
  toggleCameraStream(...a){ return this._client.toggleCameraStream(...a); }
  startCamera(...a){ return this._client.startCamera(...a); }
  startScreenShare(...a){ return this._client.startScreenShare(...a); }
  stopCamera(...a){ return this._client.stopCamera(...a); }
  stopScreenShare(...a){ return this._client.stopScreenShare(...a); }
  stopVideo(...a){ return this._client.stopVideo(...a); }
  toggleScreenShare(...a){ return this._client.toggleScreenShare(...a); }
  switchCamera(...a){ return this._client.switchCamera(...a); }
  switchScreenShareWindow(...a){ return this._client.switchScreenShareWindow(...a); }
  enableComposite(...a){ return this._client.enableComposite(...a); }
  disableComposite(...a){ return this._client.disableComposite(...a); }
  toggleComposite(...a){ return this._client.toggleComposite(...a); }
  updateAllPeerTracks(...a){ return this._client.updateAllPeerTracks(...a); }
  diagnoseAudio(...a){ return this._client.diagnoseAudio(...a); }
  diagnoseVideo(...a){ return this._client.diagnoseVideo(...a); }
  close(...a){ return this._client.close(...a); }
  setPreferredDevices(...a){ return this._client.setPreferredDevices(...a); }
  getOutputDeviceId(...a){ return this._client.getOutputDeviceId(...a); }
  bindPeerMedia(...a){ return this._client.bindPeerMedia(...a); }

  // === Back-compat property proxies (старый код обращается к этим полям напрямую) ===
  get peers(){ return this._client.peers; }
  get localStream(){ return this._client.localStream; }
  get preferred(){ return this._client.preferred; }
  get _currentVideoKind(){ return this._client._currentVideoKind; }
  get _cameraTrack(){ return this._client._cameraTrack; }
  get _screenTrack(){ return this._client._screenTrack; }
  // Не делаем сеттеры — изменение через возвращённые объекты (preferred.camId=) затронет оригинал.
}

export { WebCallClient };
