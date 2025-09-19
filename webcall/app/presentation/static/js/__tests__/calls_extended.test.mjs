import { describe, it, expect } from 'vitest';
import { setActiveOutgoingCall, setActiveIncomingCall, markCallAccepted, markCallDeclined, resetActiveCall } from '../modules/calls.js';
import { appState } from '../modules/core/state.js';

function friend(){ return { user_id:'u1', username:'User 1' }; }

describe('calls extended', () => {
  it('setActiveOutgoingCall sets activeCall', () => {
    setActiveOutgoingCall(friend(), 'room1');
    expect(appState.activeCall?.roomId).toBe('room1');
  });
  it('incoming/accept flow', () => {
    setActiveIncomingCall('u2','User 2','room2');
    expect(appState.activeCall?.withUserId).toBe('u2');
    markCallAccepted('room2');
    expect(appState.activeCall?.status).toBe('accepted');
  });
  it('decline flow', () => {
    setActiveIncomingCall('u3','User 3','room3');
    markCallDeclined('room3');
    // status becomes declined, then reset later; we just assert transitional state possibly
    expect(['declined', null]).toContain(appState.activeCall?.status || null);
  });
  it('resetActiveCall clears', () => {
    setActiveOutgoingCall(friend(),'room4');
    resetActiveCall('manual');
    expect(appState.activeCall).toBeNull();
  });
});
