# Исправления проблем со звонками

## Обнаруженные проблемы

### 1. **Звонящий не видит статус звонка**

**Проблема**: В функции `startOutgoingCall` в `calls_signaling.js` состояние устанавливалось в `outgoing_invite` сразу, но когда приходило WebSocket сообщение `call_invite` от сервера, обработчик проверял `if (state.phase === 'idle')`, что уже было неверно.

**Код с ошибкой**:
```javascript
// В startOutgoingCall:
setState({ phase:'outgoing_invite', roomId: room, otherUserId: friend.user_id, otherUsername: friend.username });

// В handleWsMessage:
} else if (isMine){
  if (state.phase==='idle'){ // ❌ Это условие никогда не выполнялось!
    setState({ phase:'outgoing_invite', roomId: msg.roomId, otherUserId: msg.toUserId, otherUsername: msg.toUsername });
  }
}
```

### 2. **Рассинхронизация между старым и новым слоями звонков**

**Проблема**: 
- `friends_ui.js` использует `getActiveCall()` из старого `calls.js` (состояние в `appState.activeCall`)
- Новая система `calls_signaling.js` использует локальную переменную `state`
- Эти состояния не синхронизировались, поэтому UI не отображал правильное состояние

### 3. **Отсутствие обратной связи при ошибках**

**Проблема**: Если friends WebSocket не готов или API возвращает ошибку, пользователь не получал никаких уведомлений.

## Примененные исправления

### 1. Исправление обработки `call_invite` для звонящего

**Файл**: `calls_signaling.js`

```javascript
// Добавили обработку case когда состояние уже outgoing_invite
} else if (isMine){
  if (state.phase==='idle'){
    setState({ phase:'outgoing_invite', roomId: msg.roomId, otherUserId: msg.toUserId, otherUsername: msg.toUsername });
  } else if (state.phase==='outgoing_invite' && state.roomId === msg.roomId){
    // ✅ Обновляем информацию о получателе, когда приходит подтверждение от сервера
    setState({ otherUsername: msg.toUsername });
  }
}
```

### 2. Исправление логики инициации звонка

**Файл**: `calls_signaling.js`

```javascript
// Убрали преждевременную установку состояния
notifyCall(friend.user_id, room).then(()=> {
  dbg('notifyCall ok');
  // ✅ Устанавливаем состояние только после успешного API вызова
  if (state.phase === 'idle') {
    setState({ phase:'outgoing_invite', roomId: room, otherUserId: friend.user_id, otherUsername: friend.username });
  }
}).catch(e=> {
  dbg('notifyCall error', e);
  // ✅ Показываем ошибку пользователю
  try {
    if (window.showToast) {
      window.showToast('Не удалось инициировать звонок: ' + e.message, 'error');
    } else {
      alert('Не удалось инициировать звонок');
    }
  } catch {}
});
```

### 3. Добавление синхронизации между слоями

**Файл**: `calls_signaling.js`

```javascript
// Добавили синхронизацию с legacy calls.js
function setState(patch){
  // ... existing code ...
  
  // ✅ Синхронизируем с legacy calls.js для совместимости UI
  try {
    syncWithLegacyCalls(state, prev);
  } catch (e) {
    dbg('legacy sync error', e);
  }
  
  emit();
}

// ✅ Функция синхронизации состояний
async function syncWithLegacyCalls(currentState, prevState) {
  if (typeof window === 'undefined' || !window.appState) return;
  
  try {
    const { setActiveOutgoingCall, setActiveIncomingCall, markCallAccepted, markCallDeclined, resetActiveCall } = await import('./calls.js');
    
    if (currentState.phase === 'outgoing_invite' && prevState.phase !== 'outgoing_invite' && currentState.otherUserId && currentState.roomId) {
      setActiveOutgoingCall(
        { user_id: currentState.otherUserId, username: currentState.otherUsername }, 
        currentState.roomId
      );
    } else if (currentState.phase === 'incoming_invite' && prevState.phase !== 'incoming_invite' && currentState.otherUserId && currentState.roomId) {
      setActiveIncomingCall(currentState.otherUserId, currentState.otherUsername, currentState.roomId);
    } else if (currentState.phase === 'active' && prevState.phase !== 'active' && currentState.roomId) {
      markCallAccepted(currentState.roomId);
    } else if (currentState.phase === 'ended' && prevState.phase !== 'ended' && currentState.roomId) {
      markCallDeclined(currentState.roomId);
    } else if (currentState.phase === 'idle' && prevState.phase !== 'idle') {
      resetActiveCall('idle');
    }
  } catch (e) {
    // Игнорируем ошибки import для совместимости
  }
}
```

### 4. Улучшение обратной связи

**Файл**: `calls_signaling.js`

```javascript
// Улучшили сообщение когда WebSocket не готов
if (!ws || ws.readyState !== WebSocket.OPEN){
  dbg('friends WS not ready, abort startOutgoingCall');
  try { window.__CALL_DEBUG && window.__CALL_DEBUG.push({ ts:Date.now(), warn:'friends_ws_not_ready' }); } catch {}
  
  // ✅ Показываем уведомление пользователю
  try {
    if (typeof window !== 'undefined' && window.showToast) {
      window.showToast('Подключение не готово. Попробуйте позже.', 'warning');
    } else {
      alert('Подключение не готово. Попробуйте позже.');
    }
  } catch {}
  return false;
}
```

**Файл**: `app_init.js`

```javascript
// ✅ Сделали showToast доступной глобально
try { window.showToast = showToast; } catch {}
```

## Диагностика проблем

### Сообщение "Подключение не готово. Попробуйте позже."

Это сообщение появляется когда WebSocket соединение для друзей не готово. Причины:

1. **Нет токена авторизации** - нужно войти в систему
2. **WebSocket не создан** - проблема с инициализацией
3. **WebSocket в состоянии CONNECTING** - соединение устанавливается
4. **WebSocket закрыт** - проблема с сервером или сетью
5. **Цикл переподключений** - WebSocket постоянно подключается и отключается (исправлено в v2)

### Сообщение "Устанавливается соединение. Попробуйте через несколько секунд."

Это улучшенное сообщение означает, что система попытается восстановить соединение автоматически.

### Диагностика через консоль браузера

Выполните в консоли браузера:
```javascript
window.debugWebSocket()
```

Или более подробную диагностику:
```javascript
// Скопируйте и выполните содержимое файла debug_websocket.js
```

### Возможные решения

1. **Обновите страницу** - перезапустится WebSocket подключение
2. **Проверьте авторизацию** - выйдите и войдите заново
3. **Проверьте консоль** - ищите ошибки WebSocket
4. **Принудительное переподключение**:
   ```javascript
   window.appState.friendsWs = null;
   window.startFriendsWs();
   ```

## Тестирование

Для тестирования исправлений создан файл `test_call_fixes.html`, который можно открыть в браузере для проверки:

1. Исходящие звонки теперь правильно обрабатываются 
2. Входящие звонки работают корректно
3. Ошибки WebSocket подключения показывают уведомления
4. Состояния синхронизируются между новым и старым слоями

## Ожидаемый результат

После применения исправлений:

1. ✅ **Звонящий видит статус звонка** - состояние правильно обновляется при получении подтверждения от сервера
2. ✅ **Получатель получает уведомления о звонке** - входящие звонки обрабатываются корректно  
3. ✅ **UI отображает правильное состояние** - синхронизация между слоями работает
4. ✅ **Пользователь получает обратную связь об ошибках** - показываются уведомления при проблемах

## Исправления v2 (проблема бесконечных переподключений)

### Обнаруженная проблема
Из серверных логов видно, что WebSocket соединения постоянно открываются и сразу закрываются, создавая бесконечный цикл переподключений:

```
INFO: connection open
INFO: connection closed
WS_REPLACE user=... old_ws=... new_ws=...
```

Также появилась ошибка "Устанавливается соединение. Попробуйте через несколько секунд" при попытках звонков.

### Примененные исправления v2

1. **Предотвращение множественных подключений** - добавлен флаг `friendsWsConnecting`
2. **Ограничение попыток переподключения** - максимум 10 попыток
3. **Увеличение интервалов переподключения** - от 5 до 30 секунд с экспоненциальным ростом
4. **Улучшенная логика onclose** - не переподключаться при нормальном закрытии или скрытой странице
5. **Обработчик beforeunload** - предотвращение переподключений при закрытии страницы

## Исправления v3 (доработка логики подключений)

### Дополнительные проблемы
- Флаг `friendsWsConnecting` иногда не сбрасывался, блокируя звонки
- Отсутствовал таймаут для подключений, что могло приводить к зависанию
- Недостаточно информативные сообщения об ошибках

### Примененные исправления v3

1. **Улучшенная логика состояний WebSocket**:
   - Проверка активности соединения перед созданием нового
   - Принудительное закрытие старых соединений
   - Таймаут подключения (10 секунд) с автоматическим сбросом флагов

2. **Исправление обработчиков ошибок**:
   - Упрощена логика onerror - не создает дополнительных переподключений
   - Корректное освобождение ресурсов при ошибках
   - Отмена автоматических ретраев при ошибках создания соединения

3. **Улучшенная проверка готовности в calls_signaling.js**:
   - Учет состояния `friendsWsConnecting` при проверке готовности
   - Более информативные сообщения пользователю
   - Предотвращение повторных попыток переподключения

4. **Расширенная диагностика**:
   - `window.debugWebSocket()` - детальная информация о состоянии
   - `window.debugCalls()` - полная системная диагностика
   - `window.forceReconnectWebSocket()` - безопасное переподключение

### Новые функции диагностики

- `window.debugWebSocket()` - показывает состояние соединения и счетчик попыток
- `window.debugCalls()` - полная диагностика системы звонков
- `window.forceReconnectWebSocket()` - принудительное переподключение с сбросом счетчика
- `websocket_debug_v2.html` - расширенная диагностическая страница

## Измененные файлы

1. `webcall/app/presentation/static/js/modules/calls_signaling.js` - **v3**: улучшенная логика проверки готовности WebSocket, учет состояния подключения
2. `webcall/app/presentation/static/js/modules/core/app_init.js` - **v3**: полная переработка логики WebSocket с таймаутами, корректным управлением состояниями и расширенной диагностикой
3. `webcall/app/presentation/static/test_call_fixes.html` - тестовая страница (новый файл)
4. `webcall/app/presentation/static/debug_websocket.js` - скрипт диагностики WebSocket (новый файл)
5. `webcall/app/presentation/static/websocket_test.html` - базовый тест WebSocket подключения (новый файл)
6. `webcall/app/presentation/static/reconnection_test.html` - тест логики переподключений (новый файл)
7. `webcall/app/presentation/static/websocket_debug_v2.html` - **НОВЫЙ**: расширенная диагностическая страница с автоматическими тестами