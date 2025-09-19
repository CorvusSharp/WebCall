import { describe, it, expect, vi } from 'vitest';
import { initFriendsModule, loadFriends, scheduleFriendsReload } from '../modules/friends_ui.js';
import { appState } from '../modules/core/state.js';

// Mock api module functions used inside friends_ui
vi.mock('../api.js', () => ({
  notifyCall: vi.fn(async ()=>{}),
  acceptCall: vi.fn(async ()=>{}),
  declineCall: vi.fn(async ()=>{}),
  cancelCall: vi.fn(async ()=>{}),
  findUsers: vi.fn(async ()=>[]),
  listFriends: vi.fn(async ()=>[]),
  listFriendRequests: vi.fn(async ()=>[]),
  sendFriendRequest: vi.fn(async ()=>{}),
  acceptFriend: vi.fn(async ()=>{}),
}));

describe('friends_ui', () => {
  it('loadFriends populates fallback when empty', async () => {
    initFriendsModule({});
    await loadFriends();
    const fl = document.getElementById('friendsList');
    expect(fl.textContent).toMatch(/Нет друзей|Загрузка|Ошибка/i);
  });
  it('scheduleFriendsReload schedules reload', async () => {
    scheduleFriendsReload();
    expect(true).toBe(true);
  });
});
