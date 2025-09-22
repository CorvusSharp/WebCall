docker compose exec api alembic upgrade head
﻿# WebCall

Минималистичная платформа для аудио/WebRTC звонков и чата: FastAPI + WebSocket сигналинг, PostgreSQL, Redis, STUN/TURN, модульный frontend (vanilla ES modules).

## Основные возможности
- Регистрация / вход (JWT + секрет регистрации)
- Комнаты и многопользовательский WebRTC сигналинг
- Чат комнат + личные (direct) сообщения
- E2EE (клиентские ключи) + хранение публичных ключей
- Push уведомления (WebPush) для инвайтов / сообщений
- Управление участниками (роли, mute)
- Простая SPA (`/static`) без зависимостей фреймворков

## Архитектурные слои
```
presentation/  (REST, WS, схемы, статические файлы)
application/   (use-cases, DTO)
core/          (доменные модели, value objects, порты, ошибки)
infrastructure/(DB репозитории, Redis, security, messaging, services)
bootstrap/     (инициализация FastAPI, middleware, статик)
```
Принципы: зависимость направлена внутрь (presentation -> application -> core), infrastructure реализует порты core.

## Недавние технические улучшения
- Введение Value Object `Username` (валидация: 3-32 символа `[A-Za-z0-9_.-]`).
- Перенос проверки владельца комнаты в use-case `DeleteRoom` (чистая бизнес-логика, router стал тоньше).
- Observability middleware: `X-Request-ID`, Server-Timing, структурированные логи с латентностью.
- Prometheus метрики: `/metrics` (счётчик и гистограмма запросов).
- Простой in-memory rate limiting для `auth/register`, `auth/login`, `rooms` (создание).
- Рефактор спец-рингтона: переезд файла в `static/media/special_ringtone.mp3` + fallback.
- Housekeeping: `dump.bat` перемещён в `scripts/legacy/`.
- Добавлен `@ts-check` + JSDoc типы в модулях фронтенда (статический анализ без TS-транспиляции).
- Mypy усилен (строже конфиг), добавлен pre-commit hook; Value Objects типизированы.

## Безопасность / Hardening (сделано)
- SQL: параметризация через SQLAlchemy, helper `safe_like`, лимиты на `IN()`.
- XSS: отказ от небезопасных `innerHTML` для пользовательского контента.
- Headers: CSP (временно с `'unsafe-inline'`), HSTS (prod), X-Content-Type-Options, X-Frame-Options, Referrer-Policy.
- Auth: JWT + обязательный `REGISTRATION_SECRET`.
- Пароли: bcrypt (passlib).
- Rate limiting на чувствительных эндпоинтах (in-memory).
- Логирование: request id, латентность, унифицированный формат (готово к интеграции с ELK/Tempo).

## Следующие шаги (roadmap)
1. Ужесточить CSP — убрать `'unsafe-inline'`, вынеся inline скрипты.
2. Добавить semgrep / bandit в CI.
3. Redis/Cluster rate limit (горизонтальное масштабирование).
4. Redis-бэкенд для CallInviteService / очередь уведомлений.
5. E2E тесты WebRTC сигналинга (smoke) + нагрузочные сценарии.
6. Экспорт метрик в Grafana / Alerting (SLO latency, error rate).

## Запуск (локально)
```powershell
cp .env.example .env
docker compose up -d --build
docker compose exec api alembic upgrade head
```
Либо через poetry:
```powershell
poetry install
poetry run alembic upgrade head
poetry run uvicorn app.bootstrap.asgi:app --reload
```

Frontend (esbuild):
```powershell
cd webcall
npm ci
npm run build
```

Тесты:
```powershell
pytest -q
```

## Переменные окружения (ключевые)
`APP_ENV`, `PORT`, `JWT_SECRET`, `REGISTRATION_SECRET`, `DATABASE_URL`, `REDIS_URL`, `STUN_SERVERS`, `TURN_URLS`, `TURN_USERNAME`, `TURN_PASSWORD`, `CORS_ORIGINS`.

### Дополнительно (AI summary / Telegram)
| Переменная | Назначение | По умолчанию |
|------------|------------|--------------|
| `AI_SUMMARY_ENABLED` | Включает генерацию выжимки чата комнаты при завершении | `False` |
| `AI_MODEL_PROVIDER` | Идентификатор провайдера/модели (зарезервировано) | `None` |
| `AI_SUMMARY_MAX_MESSAGES` | Лимит сообщений, удерживаемых для суммаризации | `200` |
| `TELEGRAM_BOT_TOKEN` | Токен бота для отправки выжимок | `None` |
| `TELEGRAM_CHAT_ID` | Целевой чат / канал / пользователь | `None` |
| `OPENAI_API_KEY` | Ключ OpenAI для генерации выжимки | `None` |
| `AI_MODEL_FALLBACK` | Запасная модель если основная недоступна | `None` |

Механика: сообщения типа `chat` в WebSocket `/ws/rooms/{room_id}` буферизуются в in-memory коллекторе. При закрытии соединения выполняется попытка суммаризации:

1. Если `AI_SUMMARY_ENABLED=true` и указан `OPENAI_API_KEY`, а `AI_MODEL_PROVIDER` имеет вид `openai:<model>`, используется OpenAI Chat Completion.
2. Иначе применяется эвристический локальный анализ (подсчёт авторов + последние реплики).
3. Если заданы Telegram токен и chat id — результат отправляется через Bot API.

Пример настройки для OpenAI:
```
AI_SUMMARY_ENABLED=true
AI_MODEL_PROVIDER=openai:gpt-4o-mini
OPENAI_API_KEY=sk-...  # НЕ коммитить в репозиторий
AI_MODEL_FALLBACK=gpt-4o-mini
```

## Миграции / конфликт номеров
Дублирующий префикс `0003_` в Alembic — безопасно (уникальны `revision id`), задокументировано. Возможен squash в будущем.

