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
    callsSignaling.forceResetCall();
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
    const { roomId } = callsSignaling.getCallState();
    const callInviteMsg = {
      type: 'call_invite',
      fromUserId: 'user123',
      toUserId: 'friend456',
      roomId,
      fromUsername: 'Me',
      toUsername: 'TestFriend'
    };

    callsSignaling.handleWsMessage(callInviteMsg);

    // Проверяем что состояние правильно обновилось
    const currentState = callsSignaling.getCallState();
    expect(currentState.phase).toBe('outgoing_ringing');
    expect(currentState.roomId).toBe(roomId);
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
    expect(currentState.phase).toBe('incoming_ringing');
    expect(currentState.roomId).toBe('call-87654321-caller');
    expect(currentState.otherUserId).toBe('caller789');
    expect(currentState.otherUsername).toBe('Caller');
  });

  it('should handle call_accept correctly', async () => {
    const friend = { user_id: 'friend456', username: 'Friend' };
    const originalFetch = global.fetch;
    global.fetch = () => Promise.resolve({
      ok: true,
      json: () => mockNotifyCall(friend.user_id, 'call-test-room')
    });

    callsSignaling.startOutgoingCall(friend);

    const { roomId: outgoingRoom } = callsSignaling.getCallState();

    callsSignaling.handleWsMessage({
      type: 'call_invite',
      fromUserId: 'user123',
      toUserId: 'friend456',
      roomId: outgoingRoom,
      fromUsername: 'Me',
      toUsername: 'Friend'
    });

    const callAcceptMsg = {
      type: 'call_accept',
      fromUserId: 'friend456',
      toUserId: 'user123',
      roomId: outgoingRoom
    };

    callsSignaling.handleWsMessage(callAcceptMsg);

    const currentState = callsSignaling.getCallState();
    expect(currentState.phase).toBe('active');
    expect(currentState.roomId).toBe(outgoingRoom);

    global.fetch = originalFetch;
  });
});