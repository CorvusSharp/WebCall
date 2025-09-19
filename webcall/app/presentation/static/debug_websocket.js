// Диагностический скрипт для проверки WebSocket соединения
// Вставьте в консоль браузера для диагностики проблем со звонками

console.log('=== Диагностика WebSocket соединения ===');

// Проверяем основные компоненты
const checks = {
  token: localStorage.getItem('wc_token'),
  appState: typeof window.appState !== 'undefined',
  friendsWs: window.appState?.friendsWs,
  wsState: window.appState?.friendsWs?.readyState,
  showToast: typeof window.showToast === 'function',
  startFriendsWs: typeof window.startFriendsWs === 'function'
};

console.log('Проверки:', checks);

// Показываем состояние WebSocket
if (checks.friendsWs) {
  const states = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
  const stateName = states[checks.wsState] || 'UNKNOWN';
  console.log(`WebSocket состояние: ${checks.wsState} (${stateName})`);
} else {
  console.log('WebSocket не создан');
}

// Проверяем токен
if (!checks.token) {
  console.warn('❌ Токен авторизации не найден!');
  console.log('Войдите в систему для использования звонков');
} else {
  console.log('✅ Токен найден');
  try {
    const payload = JSON.parse(atob(checks.token.split('.')[1]));
    console.log('Токен содержит:', { sub: payload.sub, exp: new Date(payload.exp * 1000) });
  } catch (e) {
    console.warn('Не удалось разобрать токен:', e);
  }
}

// Попытка переподключения
if (!checks.friendsWs || checks.wsState !== 1) {
  console.log('Попытка переподключения...');
  if (checks.startFriendsWs) {
    try {
      window.appState.friendsWs = null; // Сбрасываем существующее соединение
      window.startFriendsWs();
      console.log('Инициировано переподключение');
    } catch (e) {
      console.error('Ошибка переподключения:', e);
    }
  }
}

// Проверяем серверную часть
console.log('Проверяем серверные endpoints...');
fetch('/ws/friends', { method: 'HEAD' })
  .then(r => console.log('WebSocket endpoint доступен:', r.status))
  .catch(e => console.error('WebSocket endpoint недоступен:', e));

fetch('/api/v1/auth/me', { 
  headers: { 'Authorization': `Bearer ${checks.token}` }
})
  .then(r => r.json())
  .then(data => console.log('Пользователь:', data))
  .catch(e => console.error('Ошибка проверки пользователя:', e));

console.log('=== Конец диагностики ===');