// video_adaptation.js
// Стратегия адаптации видео: выделена точка расширения для будущих алгоритмов (битрейт, разрешение, фреймрейт).
// Текущая реализация — no-op (заглушка), поскольку в фасаде пока нет активной логики изменения параметров отправки.
// Будущая интеграция: слушать метрики (MetricsManager) и при ухудшении условий снижать encodings / constraints.

export class BaseVideoAdaptationStrategy {
  constructor(ctx){
    this.ctx = ctx; // { getSender, getCameraTrack, logger }
    this._active = true;
  }
  isActive(){ return this._active; }
  dispose(){ this._active = false; }
  // Вызывается после старта камеры или смены трека
  onTrackStarted(track){ /* override */ }
  // Периодический тик (можно вызывать из MetricsManager позже)
  onMetricsTick(sample){ /* override */ }
  // Сигнал деградации сети
  onNetworkDegradation(info){ /* override */ }
  // Восстановление сети
  onNetworkRecovery(info){ /* override */ }
}

// Простейшая стратегия: фиксирует факт наличия трека и может логировать базовое состояние.
export class DefaultVideoAdaptationStrategy extends BaseVideoAdaptationStrategy {
  onTrackStarted(track){
    try { this.ctx?.logger?.('VideoAdaptStrategy: track started '+(track?.label||'')); } catch{}
  }
  onMetricsTick(sample){ /* здесь можно анализировать sample.fps, sample.resolution */ }
}
