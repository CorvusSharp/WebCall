.PHONY: run up down migrate makemigrations test lint fmt precommit install

install:
	poetry install

run:
	poetry run uvicorn app.bootstrap.asgi:app --host 0.0.0.0 --port 8000 --reload

up:
	docker compose up --build

down:
	docker compose down -v

migrate:
	poetry run alembic upgrade head

makemigrations:
	poetry run alembic revision --autogenerate -m "auto"

test:
	poetry run pytest -q

lint:
	poetry run ruff check . && poetry run black --check . && poetry run isort --check-only .

fmt:
	poetry run ruff check . --fix; poetry run black .; poetry run isort .

precommit:
	poetry run pre-commit install -f --hook-type pre-commit
