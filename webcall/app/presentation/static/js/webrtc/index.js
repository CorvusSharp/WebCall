// index.js — централизованный реэкспорт всех модулей WebRTC слоя
export { MediaManager } from './media.js';
export { PeerConnectionManager } from './peers.js';
export { SignalingOrchestrator } from './signaling.js';
export { CanvasCompositeManager } from './composite.js';
export { MetricsManager, AudioLevelAnalyzer } from './metrics.js';
export { DiagnosticsManager } from './diagnostics.js';
export { DefaultVideoAdaptationStrategy } from './strategies/video_adaptation.js';
export { EventBus } from './event_bus.js';
