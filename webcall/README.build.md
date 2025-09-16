Сборка фронтенда

Этот проект использует простой скрипт сборки на `esbuild` для получения единого минифицированного бандла `app/presentation/static/js/bundle.js`.

Установка и сборка (на Windows, PowerShell):

1) Установите зависимости (предпочтительно в virtual Node.js environment):

```powershell
cd webcall
npm install
npm run build
```

2) После сборки сервер будет отдавать уже минифицированный `bundle.js` вместо отдельных модулей.

Примечание: сборка отключает source maps (`--sourcemap=false`) чтобы минимизировать видимость исходных файлов в продакшене.
