// media.js — управление локальными медиа (камера, экран, адаптация)
// Этап 1: извлекаем часть логики из монолита WebRTCManager.

export class MediaManager {
  constructor({ logger, onVideoState, constraints } = {}) {
    this._log = typeof logger === 'function' ? logger : (()=>{});
    this.onVideoState = onVideoState || (()=>{});
    this.videoConstraints = constraints || {
      camera: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
      screen: { frameRate: 15 }
    };
    // Текущее состояние
    this._cameraTrack = null;
    this._screenTrack = null;
    this._screenStream = null;
    this._currentVideoKind = 'none'; // camera | screen | multi | none
    this._localStreamProvider = null; // функция получения/создания общего локального потока (инжектируется)
    this._attachVideoTrack = null; // стратегия присоединения/замены трека к пирам (инжектируется)
    this._updateLocalPreview = null; // колбек обновления DOM превью
    this._adaptationStrategy = this._defaultAdaptation.bind(this);
  }

  // Инъекция зависимостей (поздняя, чтобы не тянуть весь WebRTCManager внутрь)
  bindEnvironment({ getOrCreateLocalStream, attachVideoTrack, updateLocalPreview }) {
    this._localStreamProvider = getOrCreateLocalStream;
    this._attachVideoTrack = attachVideoTrack;
    this._updateLocalPreview = updateLocalPreview;
  }

  get cameraTrack() { return this._cameraTrack; }
  get screenTrack() { return this._screenTrack; }
  get currentKind() { return this._currentVideoKind; }

  async startCamera(preferredDeviceId) {
    if (this._cameraTrack && this._cameraTrack.readyState === 'live') {
      this._log('MediaManager: камера уже активна');
      return this._cameraTrack;
    }
    try {
      const base = preferredDeviceId ? { deviceId: { exact: preferredDeviceId }, ...this.videoConstraints.camera } : this.videoConstraints.camera;
      const gum = await navigator.mediaDevices.getUserMedia({ video: base, audio: false });
      const track = gum.getVideoTracks()[0];
      if (!track) throw new Error('Нет video track после getUserMedia');
      track._wcType = 'camera';
      const stream = await this._ensureLocalStream();
      if (this._cameraTrack) { try { this._cameraTrack.stop(); } catch {}; try { stream.removeTrack(this._cameraTrack); } catch {} }
      this._cameraTrack = track;
      stream.addTrack(track);
      await this._attachVideo(track);
      this._updatePreview();
      this._refreshKind();
      track.onended = () => { if (this._cameraTrack === track) this.stopCamera(); };
      this._log(`MediaManager: камера запущена id=${track.id}`);
      this._emitState('camera', track);
      return track;
    } catch (e) {
      this._log('MediaManager: startCamera error: ' + (e?.name || e));
      return null;
    }
  }

  stopCamera() {
    const track = this._cameraTrack;
    if (!track) return;
    try { track.stop(); } catch {}
    this._cameraTrack = null;
    const stream = this._safeLocalStream();
    if (stream) { try { stream.getVideoTracks().forEach(t => { if (t === track) stream.removeTrack(t); }); } catch {} }
    this._detachIfSender(track);
    this._updatePreview();
    this._refreshKind();
    this._log('MediaManager: камера остановлена');
    this._emitState(this._currentVideoKind, this._activeTrack());
  }

  async startScreenShare() {
    if (this._screenTrack && this._screenTrack.readyState === 'live') {
      this._log('MediaManager: screen share уже активен');
      return this._screenTrack;
    }
    try {
      const ds = await navigator.mediaDevices.getDisplayMedia({ video: this.videoConstraints.screen, audio: false });
      const track = ds.getVideoTracks()[0];
      if (!track) throw new Error('Нет screen трека');
      track._wcType = 'screen';
      this._screenStream = ds;
      const stream = await this._ensureLocalStream();
      if (this._screenTrack) { try { this._screenTrack.stop(); } catch {}; try { stream.removeTrack(this._screenTrack); } catch {} }
      this._screenTrack = track;
      stream.addTrack(track);
      await this._attachVideo(track);
      this._updatePreview();
      this._refreshKind();
      track.onended = () => { if (this._screenTrack === track) this.stopScreenShare(); };
      this._log('MediaManager: screen share запущен');
      this._emitState('screen', track);
      return track;
    } catch (e) {
      this._log('MediaManager: startScreenShare error: ' + (e?.name || e));
      return null;
    }
  }

  stopScreenShare() {
    const track = this._screenTrack;
    if (!track) return;
    try { track.stop(); } catch {}
    const stream = this._safeLocalStream();
    if (stream) { try { stream.removeTrack(track); } catch {} }
    this._screenStream?.getTracks().forEach(t => { try { t.stop(); } catch {} });
    this._screenStream = null;
    this._screenTrack = null;
    this._detachIfSender(track);
    this._updatePreview();
    this._refreshKind();
    this._log('MediaManager: screen share остановлен');
    this._emitState(this._currentVideoKind, this._activeTrack());
  }

  async toggleCamera(preferredDeviceId) {
    if (this._cameraTrack) { this.stopCamera(); return false; }
    return !!(await this.startCamera(preferredDeviceId));
  }

  async toggleScreenShare() {
    if (this._screenTrack) { this.stopScreenShare(); return false; }
    return !!(await this.startScreenShare());
  }

  // === Internal helpers ===
  async _ensureLocalStream() {
    if (!this._localStreamProvider) throw new Error('Local stream provider не инжектирован');
    return await this._localStreamProvider();
  }
  _safeLocalStream() { try { return this._localStreamProvider ? this._localStreamProvider() : null; } catch { return null; } }
  async _attachVideo(track) { if (this._attachVideoTrack) await this._attachVideoTrack(track); }
  _detachIfSender(/*track*/) { /* На этапе 1 делегируем отсоединение внешнему коду позже */ }
  _updatePreview() { if (this._updateLocalPreview) try { this._updateLocalPreview(); } catch {} }
  _emitState(kind, track) { try { this.onVideoState(kind, track); } catch {} }
  _activeTrack() { return this._screenTrack || this._cameraTrack || null; }
  _refreshKind() {
    const cam = !!(this._cameraTrack && this._cameraTrack.readyState === 'live');
    const scr = !!(this._screenTrack && this._screenTrack.readyState === 'live');
    this._currentVideoKind = scr && cam ? 'multi' : (scr ? 'screen' : (cam ? 'camera' : 'none'));
    this._adaptationStrategy();
  }
  async _defaultAdaptation() {
    try {
      const camLive = this._cameraTrack && this._cameraTrack.readyState === 'live';
      const scrLive = this._screenTrack && this._screenTrack.readyState === 'live';
      if (!camLive) return;
      if (scrLive) {
        await this._cameraTrack.applyConstraints({ frameRate: 12, width: { ideal: 960 }, height: { ideal: 540 } }).catch(()=>{});
        this._log('MediaManager: адаптация камеры при активном screen share');
      } else {
        await this._cameraTrack.applyConstraints(this.videoConstraints.camera).catch(()=>{});
        this._log('MediaManager: восстановлены ограничения камеры');
      }
    } catch {}
  }
}
