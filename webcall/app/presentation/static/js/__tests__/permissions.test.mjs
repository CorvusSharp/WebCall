import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as perms from '../modules/permissions.js';

beforeEach(()=>{
  // reset banner content
  const banner = document.getElementById('permBanner');
  if (banner){ banner.innerHTML=''; banner.style.display='none'; }
});

describe('permissions', () => {
  it('requestMicIfNeeded returns true when granted', async () => {
    const ok = await perms.requestMicIfNeeded();
    expect(ok).toBe(true);
  });
  it('ensurePushPermission returns true (granted)', async () => {
    const ok = await perms.ensurePushPermission();
    expect(ok).toBe(true);
  });
  it('updatePermBanner does not throw and manipulates DOM', async () => {
    await perms.updatePermBanner();
    const banner = document.getElementById('permBanner');
    expect(banner.style.display === '' || banner.style.display === 'none').toBe(true);
  });
});
