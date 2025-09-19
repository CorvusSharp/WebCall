import { describe, it, expect } from 'vitest';
import { emit, on, once, waitFor } from '../modules/core/event_bus.js';

describe('event_bus', () => {
  it('on/emit delivers detail', async () => {
    await new Promise(resolve => {
      const off = on('sample-evt', (d) => {
        expect(d.value).toBe(42);
        off();
        resolve();
      });
      emit('sample-evt', { value: 42 });
    });
  });

  it('once unsubscribes after first emit', async () => {
    let count = 0;
    const off = once('only-once', () => { count++; });
    emit('only-once');
    emit('only-once');
    expect(count).toBe(1);
    off(); // no-op
  });

  it('waitFor resolves', async () => {
    setTimeout(() => emit('later', { ok: true }), 10);
    const data = await waitFor('later', 500);
    expect(data.ok).toBe(true);
  });

  it('waitFor timeout', async () => {
    await expect(waitFor('never', 20)).rejects.toThrow(/timeout/i);
  });
});
