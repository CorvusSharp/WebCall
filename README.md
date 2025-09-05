# WebCall

Современный backend + минималистичный фронтенд для групповых WebRTC звонков: FastAPI, WebSocket сигналинг, комнаты, чат, управление участниками, визуальные эффекты, гибкая архитектура (onion / clean) и инфраструктурные адаптеры (PostgreSQL, Redis, TURN/STUN).

## ✨ Возможности
- Регистрация / вход по JWT (+ обязательный секретный код регистрации)
- Комнаты и подключение по WebSocket
- Сигналинг для WebRTC (обмен SDP / ICE)
- Отображение участников, их реальные имена
- Персональные регуляторы громкости по участнику
- Чат (стиль мессенджера: свои сообщения справа)
- Удаление «залежавшихся» пиров (очистка presence)
- Logout, отключение авто-подключения к дефолтной комнате
- Canvas «паутинка» фон на страницах
- TURN/STUN конфигурация из окружения

## 🧱 Архитектура слоёв
```
 presentation (REST, WS, static)
     ↓
 application (use cases, DTO)
     ↓
 core (domain models, ports, services, errors)
     ↓
 infrastructure (db, redis, jwt, security, messaging, ice)
```
Инверсия зависимостей: верхние слои знают только о портах (`core.ports`). Реализации внедряются через DI контейнеры в `presentation.api.deps`.

## 🗂 Основные каталоги
- `app/bootstrap` — создание FastAPI приложения / ASGI
- `app/presentation` — API роуты, WebSocketы, схемы, ошибки, статика
- `app/application` — DTO и сценарии (use-cases)
- `app/core` — доменные модели, порты, ошибки, сервисы домена
- `app/infrastructure` — адаптеры: БД, репозитории, Redis, JWT, пароль, ICE, messaging
- `alembic/` — миграции
- `docker/` — Dockerfile для API
- `tests/` — базовые и расширяемые тесты

## ⚙️ Переменные окружения (.env)
| Переменная | Назначение | Пример |
|------------|------------|--------|
| `APP_ENV` | окружение (dev/prod) | dev |
| `HOST` / `PORT` | bind адрес API | 0.0.0.0 / 8000 |
| `JWT_SECRET` | секрет JWT (обязателен) | (указать в .env) |
| `JWT_EXPIRES_MIN` | время жизни токена (мин) | 60 |
| `REGISTRATION_SECRET` | обязательный код регистрации | (указать в .env) |
| `DATABASE_URL` | строка подключения Postgres | postgresql+asyncpg://webcall:pwd@postgres:5432/webcall |
| `REDIS_URL` | строка Redis | redis://redis:6379/0 |
| `CORS_ORIGINS` | списком, запятые | http://localhost:5173,http://localhost:8000 |
| `STUN_SERVERS` | списком, запятые | stun:stun.l.google.com:19302 |
| `TURN_URLS` / `TURN_URL` | список или одиночный TURN | turn:your.turn:3478 |
| `TURN_USERNAME` / `TURN_PASSWORD` | креды TURN | webcall / secret |

Если заданы `TURN_URLS`, они используются; иначе при наличии `TURN_URL` он превращается в список.

## 🚀 Быстрый старт (Docker Compose)
```bash
cp .env.example .env
# Отредактируйте .env (REGISTRATION_SECRET, DATABASE_URL и т.д.)
docker compose up --build -d
# Применить миграции (если не включены авто):
docker compose exec api alembic upgrade head
```
Откройте:
- Swagger (если не скрыт): http://localhost:8000/docs
- Клиент: http://localhost:8000/static/index.html
- Страница авторизации: http://localhost:8000/static/auth.html

## 🧪 Локальная разработка (Poetry)
```bash
poetry install
poetry run alembic upgrade head
poetry run uvicorn app.bootstrap.asgi:app --reload
```
URLы те же (порт 8000).

## 🗄 База данных и миграции
SQLAlchemy + Alembic.
- Ревизии: `alembic/versions/*.py`
- Создать: `alembic revision -m "message" --autogenerate`
- Применить: `alembic upgrade head`

## 🔐 Аутентификация и регистрация
- Регистрация: `POST /api/v1/auth/register` (тело: email, username, password, secret)
- Логин: `POST /api/v1/auth/login` → JWT (`access_token`)
- Секрет обязателен; неверный — 403. Сменить можно через переменную `REGISTRATION_SECRET`.

## 📡 WebSocket сигналинг
Путь: `ws://<host>/ws/rooms/{room}?token=JWT`
Сообщения формата JSON (chat, signal, presence). Клиентские скрипты в `static/js/`.

## 🎧 WebRTC ICE
REST эндпоинт: `GET /api/v1/webrtc/ice-servers` возвращает `{"iceServers": [...]}`. Формируется из STUN/TURN переменных.

## 🗣 Чат и участники
- Сообщения форматируются на клиенте (свои справа)
- Имена берутся из регистрационных username
- Управление громкостью: слайдер на каждом участнике, применяется к получаемому медиапотоку.

## 🧩 Тестирование
Используются `pytest` + `pytest-asyncio` + `httpx`.
```bash
poetry run pytest -q
```
Пример теста проверки секрета: `app/tests/test_registration_secret.py`.

## 🧱 Логи и наблюдаемость
Сейчас structlog для форматирования. Метрики/Prometheus — TODO.

## 🪪 Ошибки
Централизованная обработка в `presentation.errors` (и локально в роутерах). Стандартные HTTP коды: 401/403/409/422.

## 🧠 Расширение
Идеи:
- Rate limiting / throttling
- Метрики и трассировка
- Запись звонков (SFU либо медиасервер)
- Файловые вложения в чат
- UI для управления TURN
- Админ-панель (бан/мут)

## 🏗 Принципы кода
- Use-case слой не знает о FastAPI/SQLAlchemy
- DI через функции в `presentation.api.deps`
- Pydantic v2 DTO на границе
- Константное сравнение секрета (hmac.compare_digest)

## 🔄 Обновление секрета регистрации
Измените `REGISTRATION_SECRET` в окружении и перезапустите сервис. Не редактируйте код — только конфиг.

## 🛡 Безопасность
- JWT срок жизни по настройке
- Секрет регистрации скрыт вне репозитория (override env)
- Минимальный набор заголовков (можно добавить CSP/SECURE в проде)

## 🌐 Продакшн набросок
1. Reverse proxy (Nginx / Caddy) → API:8000
2. HTTPS обязательный (Let’s Encrypt)
3. Настроить TURN (public IP, firewall UDP диапазон)
4. Настройки CORS с реальными доменами
5. Логи в stdout + централизованный сбор (Loki/ELK)
6. Backups Postgres (pg_dump + cron)

## 📜 Лицензия
MIT.

---
Все секреты (JWT, регистрационный, TURN, БД) задаются только через .env. В репозитории отсутствуют реальные значения.
