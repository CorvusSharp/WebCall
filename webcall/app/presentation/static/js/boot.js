// boot.js — загрузчик бандла и регистрации SW (замена inline скриптов для CSP)
(async () => {
  try {
    const resp = await fetch('/static/js/bundle.js', { method: 'HEAD' });
    if (resp.ok) {
      const s = document.createElement('script');
      s.type = 'module';
      s.src = '/static/js/bundle.js';
      document.body.appendChild(s);
    } else {
      const s2 = document.createElement('script');
      s2.type = 'module';
      s2.src = '/static/js/main.js?v=2';
      document.body.appendChild(s2);
    }
  } catch (e) {
    const s2 = document.createElement('script');
    s2.type = 'module';
    s2.src = '/static/js/main.js?v=2';
    document.body.appendChild(s2);
  }

  try {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/static/sw.js').catch(() => {});
    }
  } catch {}
})();
