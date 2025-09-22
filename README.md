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
| `AI_SUMMARY_MIN_CHARS` | Минимальное суммарное количество символов содержимого (без обвязки) для вызова внешнего AI; если меньше — формируется короткий fallback без полноценной AI выжимки | `60` |
| `TELEGRAM_BOT_TOKEN` | Токен бота для отправки выжимок | `None` |
| `TELEGRAM_CHAT_ID` | (DEPRECATED) Глобальный чат / канал / пользователь. Используется только как fallback если у инициатора нет персональной привязки | `None` |
| `OPENAI_API_KEY` | Ключ OpenAI для генерации выжимки | `None` |
| `AI_MODEL_FALLBACK` | Запасная модель если основная недоступна | `None` |

Механика (ручной триггер):

1. Сообщения чата (`type=chat`) и расщеплённый на предложения голосовой транскрипт (если включён voice capture) буферизуются в памяти.
2. Автоматическая генерация при уходе участников отключена.
3. Первый клик по кнопке «AI Agent» — подключает агент-присутствие и начинает поток голосовых чанков во `voice_capture` WebSocket.
4. Второй клик — останавливает запись, закрывает вспомогательные WS и через ~650 мс отправляет в основной room WebSocket сообщение `{"type":"agent_summary"}`.
5. Сервер по получении `agent_summary` собирает итог (voice > chat) и, если заданы Telegram переменные, отправляет отчёт (однократно per room).
6. Если общий объём контента < `AI_SUMMARY_MIN_CHARS`, внешний AI не вызывается — возвращается эвристический fallback с пометкой о короткой сессии.
7. При ручном триггере сервер ожидает до ~6 секунд готовности транскрипта (poll каждые 300мс) перед формированием отчёта. Если за это время транскрипт не появился и нет сообщений чата — результат пуст и можно повторить попытку (agent_summary снова).

Пример настройки для OpenAI:
```
AI_SUMMARY_ENABLED=true
AI_MODEL_PROVIDER=openai:gpt-4o-mini
OPENAI_API_KEY=sk-...  # НЕ коммитить в репозиторий
AI_MODEL_FALLBACK=gpt-4o-mini
```

## Персональная привязка Telegram

Реализована таблица `telegram_links` для привязки пользователя к своему `chat_id`.

Флоу:
1. Клиент запрашивает `POST /api/v1/telegram/link` — сервер возвращает токен и deep-link вида `https://t.me/<BOT>?start=<token>`.
2. Пользователь переходит по ссылке, бот получает `/start <token>` и отправляет webhook `POST /api/v1/telegram/webhook`.
3. Сервер помечает ссылку `status=confirmed`, сохраняет `chat_id`.
4. Клиент периодически опрашивает `GET /api/v1/telegram/status` пока `confirmed`.

### Отвязка Telegram

Если пользователь хочет отключить получение AI выжимок в Telegram:

1. Нажимает кнопку "Отвязать Telegram" в настройках (иконка шестерёнки в интерфейсе).
2. Клиент вызывает `DELETE /api/v1/telegram/link`.
3. Сервер помечает все `confirmed` записи пользователя как `revoked`.
4. Статус `GET /api/v1/telegram/status` вернётся `absent`. Для повторной привязки нужно снова пройти процедуру `/link` → `/start <token>`.

Это позволяет безопасно переключать устройства или отключать доставку отчётов.

## Кастомный AI System Prompt

По умолчанию для генерации итоговой выжимки используется системный prompt:

```
Ты ассистент, делающий краткую структурированную выжимку группового чата: 1) Основные темы 2) Принятые решения 3) Открытые вопросы. Пиши лаконично на русском, без лишних вступлений.
```

Пользователь может задать собственный prompt через API или UI:

* `GET  /api/v1/ai/prompt` — получить текущий (если кастом не задан, возвращается дефолт и `is_default=true`).
* `PUT  /api/v1/ai/prompt` — сохранить новый (`{"prompt": "..."}`), длина 10..4000.
* `DELETE /api/v1/ai/prompt` — сброс к стандартному.

Во фронтенде в панели настроек доступно поле редактирования prompt с кнопками "Сохранить" и "Сброс". Если ввести дефолтный текст без изменений — он не дублируется в БД (поле очищается).

При генерации summary (OpenAI провайдер) если инициатор ручного триггера имеет кастомный prompt — он используется как system message вместо дефолта.
5. При ручном триггере AI summary сервер отправляет отчёт ТОЛЬКО инициатору (его `chat_id`). Если привязки нет — пытается отправить всем подтверждённым (глобальный broadcast) или, в качестве устаревшего fallback, в `TELEGRAM_CHAT_ID`.

## Миграции / устранение multiple heads

Если при запуске контейнера возникает ошибка Alembic `Multiple head revisions are present`, причины:
- В БД остались ссылки на ревизии, которых больше нет в каталоге `alembic/versions`.
- Либо ранее существовал merge-point.

Решение (без потери данных):
1. Определить фактическое состояние таблиц (сравнить со схемой последней миграции).
2. Войти в контейнер: `docker compose exec api bash` (или `sh`).
3. Получить текущие ревизии: `alembic history --verbose | tail -n 40` и `alembic current -v` (если падает из-за multiple heads — перейти к ручному штампу).
4. Открыть `psql` и посмотреть содержимое `alembic_version`: `SELECT * FROM alembic_version;` (может быть несколько строк при split head scenario).
5. Сделать резервную копию (опционально): `pg_dump -U webcall -d webcall > /tmp/backup.sql`.
6. Проставить единый штамп на последнюю существующую ревизию из кода (например `0006_telegram_links`):
	- Удалить лишние строки: `DELETE FROM alembic_version;`
	- Вставить одну: `INSERT INTO alembic_version (version_num) VALUES ('0006_telegram_links');`
7. Запустить `alembic upgrade head` — он теперь ничего не применит (schema already up-to-date) и не будет жаловаться.

Если схема в БД не соответствует миграциям (рассинхронизация), используйте:
1. `alembic downgrade base` (если безопасно потерять данные) → затем `alembic upgrade head`.
2. Либо вручную примените недостающие изменения и затем `alembic stamp <revision>`.

Checklist после фикса:
- `alembic current` показывает одну ревизию.
- `alembic heads` == `alembic current`.
- Приложение стартует без ошибки.

Примечание: глобальный noop stub миграции удалён, цепочка линейная 0001 → 0006.

