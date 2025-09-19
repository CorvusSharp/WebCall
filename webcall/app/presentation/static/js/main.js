// main.js (фасад)
// Вся прежняя логика перенесена в modules/*. Здесь только:
// 1. Быстрый auth guard (редирект если нет токена)
// 2. Запуск appInit()
// 3. Обработка кастомного события wc:join-room (из истории посещённых комнат)

// ===== RUNTIME AUTH GUARD (минимальный) =====
try {
  const rawToken = localStorage.getItem('wc_token');
  let needAuth = !rawToken;
  if (rawToken) {
    try {
      const payload = JSON.parse(atob(rawToken.split('.')[1]));
      const now = Math.floor(Date.now()/1000);
      if (payload.exp && now >= payload.exp) needAuth = true;
    } catch { needAuth = true; }
  }
  if (needAuth) {
    const url = new URL(location.href);
    const params = new URLSearchParams({ redirect: '/call' });
    const room = url.searchParams.get('room');
    if (room) params.set('room', room);
    location.replace(`/auth?${params.toString()}`);
    throw new Error('__halt_main_init');
  }
} catch (e) {
  if (e?.message === '__halt_main_init') {
    // Прерываем дальнейшую инициализацию — пользователь отправлен на /auth
  } else {
    // Не блокируем работу при непредвиденной ошибке
  }
}

import { appInit, connectRoom, unlockAudioPlayback } from './modules/app_init.js';
import { bus } from './modules/core/event_bus.js';

// Запуск приложения (инициализация модулей, подписки и т.д.)
appInit();

// Подключение к комнате по событию из visited_rooms.js (через шину)
bus.on('join-room', () => {
  try { unlockAudioPlayback(); connectRoom(); } catch {}
});

// Ничего не экспортируем в window — если потребуется совместимость с legacy-кодом,
// можно добавить адаптеры здесь.
