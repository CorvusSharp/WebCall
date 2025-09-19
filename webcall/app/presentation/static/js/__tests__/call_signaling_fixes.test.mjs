// Тестовый файл для проверки исправлений звонков
import { describe, it, expect, beforeEach } from 'vitest';

// Mock зависимостей
global.window = {
  appState: {
    friendsWs: { readyState: WebSocket.OPEN },
  },
  showToast: () => {},
  WebSocket: { OPEN: 1 },
  crypto: { randomUUID: () => '12345678-1234-1234-1234-123456789abc' },
};

global.WebSocket = { OPEN: 1 };

// Моки API
const mockNotifyCall = (toUserId, roomId) => Promise.resolve({ room_id: roomId });

describe('Call Signaling Fixes', () => {
  let callsSignaling;
  let state;

  beforeEach(async () => {
    // Динамический импорт после установки мокав
    callsSignaling = await import('../modules/calls_signaling.js');
    
    // Инициализируем модуль
    callsSignaling.initCallSignaling({
      getAccountId: () => 'user123',
      connectRoom: () => {},
      unlockAudio: () => {},
    });
    
    // Ждем установки зависимостей
    await new Promise(resolve => setTimeout(resolve, 10));
  });

  it('should handle call_invite for outgoing caller correctly', async () => {
    const friend = { user_id: 'friend456', username: 'TestFriend' };
    
    // Подменяем notifyCall
    const originalFetch = global.fetch;
    global.fetch = () => Promise.resolve({
      ok: true,
      json: () => mockNotifyCall(friend.user_id, 'call-12345678-testfr')
    });

    // Инициируем звонок
    const result = callsSignaling.startOutgoingCall(friend);
    expect(result).toBe(true);

    // Симулируем получение call_invite от сервера для звонящего
    const callInviteMsg = {
      type: 'call_invite',
      fromUserId: 'user123',
      toUserId: 'friend456',
      roomId: 'call-12345678-testfr',
      fromUsername: 'Me',
      toUsername: 'TestFriend'
    };

    callsSignaling.handleWsMessage(callInviteMsg);

    // Проверяем что состояние правильно обновилось
    const currentState = callsSignaling.getCallState();
    expect(currentState.phase).toBe('outgoing_invite');
    expect(currentState.roomId).toBe('call-12345678-testfr');
    expect(currentState.otherUserId).toBe('friend456');

    global.fetch = originalFetch;
  });

  it('should handle call_invite for receiver correctly', async () => {
    // Симулируем получение call_invite от другого пользователя
    const callInviteMsg = {
      type: 'call_invite',
      fromUserId: 'caller789',
      toUserId: 'user123',
      roomId: 'call-87654321-caller',
      fromUsername: 'Caller',
      toUsername: 'Me'
    };

    callsSignaling.handleWsMessage(callInviteMsg);

    // Проверяем что состояние правильно обновилось для входящего звонка
    const currentState = callsSignaling.getCallState();
    expect(currentState.phase).toBe('incoming_invite');
    expect(currentState.roomId).toBe('call-87654321-caller');
    expect(currentState.otherUserId).toBe('caller789');
    expect(currentState.otherUsername).toBe('Caller');
  });

  it('should handle call_accept correctly', async () => {
    // Сначала установим состояние исходящего звонка
    callsSignaling.handleWsMessage({
      type: 'call_invite',
      fromUserId: 'user123',
      toUserId: 'friend456',
      roomId: 'call-test-room',
      fromUsername: 'Me',
      toUsername: 'Friend'
    });

    // Теперь симулируем принятие звонка
    const callAcceptMsg = {
      type: 'call_accept',
      fromUserId: 'friend456',
      toUserId: 'user123',
      roomId: 'call-test-room'
    };

    callsSignaling.handleWsMessage(callAcceptMsg);

    // Проверяем что звонок перешел в активное состояние
    const currentState = callsSignaling.getCallState();
    expect(currentState.phase).toBe('active');
    expect(currentState.roomId).toBe('call-test-room');
  });
});