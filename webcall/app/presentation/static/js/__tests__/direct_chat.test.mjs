import { describe, it, expect, beforeEach } from 'vitest';
import { initDirectChatModule, selectDirectFriend, handleIncomingDirect, handleDirectCleared, bindSendDirect } from '../modules/direct_chat.js';
import { appState } from '../modules/core/state.js';

// Provide fake crypto functions (encrypt/decrypt) via dynamic module patch if needed.

beforeEach(() => {
  initDirectChatModule({ getAccountId: () => 'me', log: ()=>{} });
  const dm = document.getElementById('directMessages');
  if (dm) dm.innerHTML='';
  appState.currentDirectFriend = null;
  appState.directUnread.clear();
  appState.directSeenByFriend.clear();
});

describe('direct_chat', () => {
  it('selectDirectFriend sets friend and populates placeholder', async () => {
    await selectDirectFriend('friend1', 'Друг 1', { force:true });
    expect(appState.currentDirectFriend).toBe('friend1');
  });

  it('handleIncomingDirect increments unread when not selected', () => {
    handleIncomingDirect({ fromUserId: 'friend2', toUserId: 'me', content:'hello', id:'m1' });
    expect(appState.directUnread.get('friend2')).toBe(1);
  });

  it('handleDirectCleared resets chat', () => {
    appState.currentDirectFriend = 'friend3';
    handleDirectCleared({ userIds: ['friend3','me'] });
    expect(appState.directSeenByFriend.get('friend3')).toBeInstanceOf(Set);
  });

  it('bindSendDirect attaches listeners safely', () => {
    const btn = document.getElementById('btnDirectSend');
    bindSendDirect();
    // simulate click without current friend - should be no throw
    btn.click();
    expect(true).toBe(true);
  });
});
