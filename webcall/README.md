# WebCall

Бэкенд для веб-созвонов на FastAPI с WebSocket-сигналингом (onion/clean architecture).

Слои: presentation → application → core. Инфраструктура внедряется через порты.

## Быстрый старт (Docker)

1. Создайте `.env` из примера:

```
cp .env.example .env
```

2. Поднимите стэк:

```
docker compose up --build
```

3. Примените миграции (в другом терминале):

```
docker compose exec api alembic upgrade head
```

4. Откройте Swagger: http://localhost:8000/docs

5. Демо-клиент: http://localhost:8000/static/index.html

## Локальный запуск

Требуется Python 3.11+ и Poetry.

```
poetry install
poetry run uvicorn app.bootstrap.asgi:app --reload
```

Миграции:

```
poetry run alembic upgrade head
```

## Структура

См. дерево в задаче. Важные части:
- app/bootstrap: создание приложения
- core: доменные сущности/порты/сервисы
- application: use-cases
- infrastructure: реализация портов (DB, Redis, JWT, bcrypt, ICE)
- presentation: REST и WS, схемы, ошибки, статика

## Definition of Done
- docker compose up поднимает Postgres, Redis, API
- alembic upgrade head проходит
- /docs доступен
- Регистрация/логин работают
- Создание комнат работает
- WS сигналинг показывает обмен сообщениями

## Примечания
- Rate limit для REST помечен как TODO
- Метрики/Prometheus — TODO хуки
