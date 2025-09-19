import { describe, it, expect } from 'vitest';
import { loadVisitedRooms } from '../modules/visited_rooms.js';

// fetch is stubbed in setup. Provide minimal element.

describe('visited_rooms', () => {
  it('loadVisitedRooms handles missing token', async () => {
    localStorage.removeItem('wc_token');
    await loadVisitedRooms();
    const el = document.getElementById('visitedRooms');
    expect(el.innerHTML).toMatch(/Войдите|историю/i);
  });
});
