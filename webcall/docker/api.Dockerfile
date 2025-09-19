# syntax=docker/dockerfile:1
## Build frontend in a node stage, then copy into python image
FROM node:20-alpine AS nodebuilder
WORKDIR /build
# copy dependency manifests
COPY package.json package-lock.json ./
# install dependencies deterministically
RUN apk add --no-cache libc6-compat \
    && npm ci --silent
# copy frontend sources (only the static JS folder to keep context small)
COPY app/presentation/static/js ./app/presentation/static/js
# debug list sources (can be removed later)
RUN find app/presentation/static/js -maxdepth 2 -type f -print
# build bundles (script defined in package.json)
RUN npm run build

FROM python:3.11-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=on \
    PYTHONPATH=/app

WORKDIR /app

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libpq-dev curl && rm -rf /var/lib/apt/lists/*

# Install Poetry
ENV POETRY_HOME=/opt/poetry \
    POETRY_VERSION=1.8.3
ENV PATH="$POETRY_HOME/bin:$PATH"
RUN curl -sSL https://install.python-poetry.org | python3 - && poetry --version

# Copy only dependency manifest first (README не обязателен на этом слое)
COPY pyproject.toml ./
RUN poetry config virtualenvs.create false \
    && poetry install --no-interaction --no-ansi --with dev

COPY . .

# Copy built frontend bundle from node stage (if present) into static folder
COPY --from=nodebuilder /build/app/presentation/static/js/bundle.js ./app/presentation/static/js/bundle.js
COPY --from=nodebuilder /build/app/presentation/static/js/api.bundle.js ./app/presentation/static/js/api.bundle.js

EXPOSE 8000

CMD ["uvicorn", "app.bootstrap.asgi:app", "--host", "0.0.0.0", "--port", "8000"]
