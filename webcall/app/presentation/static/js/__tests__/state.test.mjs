import { describe, it, expect } from 'vitest';
import { appState, resetTransient } from '../modules/core/state.js';

describe('state', () => {
  it('appState has expected basic props', () => {
    expect(appState).toHaveProperty('special');
    expect(appState.special).toMatchObject({ active: false, playing: false, session: 0 });
  });

  it('resetTransient clears transient maps', () => {
    appState.recentOffer.set('x', 1);
    appState.pendingIncomingInvites.set('r1', Date.now());
    resetTransient();
    expect(appState.recentOffer.size).toBe(0);
    expect(appState.pendingIncomingInvites.size).toBe(0);
  });
});
