# syntax=docker/dockerfile:1
# Multi-stage production Dockerfile

#############################
# Frontend build (JS bundles)
#############################
FROM node:20-alpine AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --silent
COPY app/presentation/static/js ./app/presentation/static/js
RUN npm run build

#############################
# Python deps build layer
#############################
FROM python:3.11-slim AS pydeps
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=on
WORKDIR /app
# System build deps only for wheels compilation
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libpq-dev curl \
    && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml ./
# Use pip instead of poetry export (simpler) – could also: poetry export -f requirements.txt
RUN pip install --no-cache-dir poetry==1.8.3 \
    && poetry export -f requirements.txt --without-hashes -o requirements.txt \
    && pip install --no-cache-dir -r requirements.txt \
    && mkdir /install && cp -r /usr/local/lib/python3.11/site-packages /install/site-packages && cp -r /usr/local/bin /install/bin

#############################
# Final runtime image
#############################
FROM python:3.11-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app
WORKDIR /app
# Minimal runtime system libs
RUN apt-get update && apt-get install -y --no-install-recommends libpq5 curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r app && useradd -r -g app app
# Copy installed deps
COPY --from=pydeps /install/site-packages /usr/local/lib/python3.11/site-packages
COPY --from=pydeps /install/bin /usr/local/bin
# Copy application code (only what is needed)
COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./
COPY pyproject.toml ./
COPY monitoring ./monitoring
COPY docker ./docker
# Copy built frontend bundles
COPY --from=frontend /src/app/presentation/static/js/bundle.js ./app/presentation/static/js/bundle.js
COPY --from=frontend /src/app/presentation/static/js/api.bundle.js ./app/presentation/static/js/api.bundle.js
# Create non-root ownership
RUN chown -R app:app /app
USER app
EXPOSE 8000
# Healthcheck (simple)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -fsS http://localhost:8000/healthz || exit 1
# Run with multiple workers via gunicorn
# WEB_CONCURRENCY can be tuned (e.g. 2-4) depending on CPU
ENV WEB_CONCURRENCY=2
CMD gunicorn app.bootstrap.asgi:app -k uvicorn.workers.UvicornWorker -w ${WEB_CONCURRENCY} -b 0.0.0.0:8000 --graceful-timeout 30 --timeout 60 --log-level info
