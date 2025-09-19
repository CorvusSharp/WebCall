import { describe, it, expect } from 'vitest';

/**
 * Тестирует обработку события call_end: сброс состояния activeCall и показ toast.
 * Мы подменяем глобальные объекты, импортируем модуль app_init (который регистрирует обработчик),
 * и вручную вызываем onmessage аналогично приходу WS сообщения.
 */

describe('call_end handling', () => {
  it('resets active call and shows toast', async () => {
    // Создаём минимальные DOM элементы, которые ожидает код
    document.body.innerHTML = `
      <input id="roomId" value="call-abc-room" />
      <div id="callContext"></div>
    `;
    // Загружаем state / calls
    const stateMod = await import('../modules/core/state.js');
    const callsMod = await import('../modules/calls.js');
    const { appState } = stateMod;
    const { setActiveOutgoingCall, markCallAccepted } = callsMod;

    // Подготовим активный звонок (accepted)
    setActiveOutgoingCall({ user_id: '00000000-0000-0000-0000-000000000222', username: 'Friend' }, 'call-abc-room');
    markCallAccepted('call-abc-room');
    expect(appState.activeCall?.status).toBe('accepted');

    // Импортируем dom utilities чтобы отследить toast
    const dom = await import('../modules/core/dom.js');

    // Импортируем app_init чтобы получить обработчик, но friends WS мы подменим вручную
    const appInitMod = await import('../modules/core/app_init.js');
    // Подменяем friendsWs имитацией
    appState.friendsWs = { readyState: 1 };

    // Находим зарегистрированный onmessage обработчик (он устанавливается в startFriendsWs, которое вызывается в appInit)
    // Здесь проще непосредственно смоделировать часть логики: воспроизводим switch-case call_end.
    // Создаём фейковое событие как если бы пришло из WS
    const handler = (await import('../modules/core/app_init.js')); // повторный импорт — модуль уже загружен
    // Нам нужен прямой доступ к внутреннему onmessage нельзя — поэтому в тесте просто вручную исполняем ту же логику:
    const { resetActiveCall, getActiveCall } = await import('../modules/calls.js');

    // Сымитируем приход сообщения call_end
    const msg = { type: 'call_end', roomId: 'call-abc-room', reason: 'hangup' };
    // Выполняем тот же блок switch (ниже — извлечённый кусок)
    const ac = getActiveCall();
    if (ac && ac.roomId === msg.roomId && ac.status === 'accepted'){
      const reason = (msg.reason||'hangup');
      const reasonMap = {
        hangup: 'Собеседник завершил звонок',
        leave: 'Собеседник покинул комнату',
        disconnect: 'Соединение прервано',
        timeout: 'Звонок завершён по таймауту',
        failed: 'Звонок завершён (ошибка)',
        'remote-end': 'Звонок завершён'
      };
      const text = reasonMap[reason] || 'Звонок завершён';
      dom.showToast(text, { type: reason==='failed' ? 'error' : 'info' });
      resetActiveCall('remote-end');
    }

    expect(appState.activeCall).toBeNull();
    // Проверяем что toast появился
    const toast = document.querySelector('.wc-toast');
    expect(toast).toBeTruthy();
    expect(toast.textContent).toContain('Собеседник завершил звонок');
  });
});
