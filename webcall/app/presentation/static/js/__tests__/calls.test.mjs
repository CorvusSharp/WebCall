import { describe, it, expect } from 'vitest';

describe('calls module', () => {
  it('imports without throwing', async () => {
    const mod = await import('../modules/calls.js');
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });
});
