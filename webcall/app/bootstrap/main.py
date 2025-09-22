from __future__ import annotations

import logging
import time
import uuid
try:
    from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST, Gauge as _Gauge
except Exception:  # pragma: no cover - prometheus optional until dependency installed
    Counter = Histogram = None  # type: ignore
    _Gauge = None  # type: ignore
    def generate_latest():  # type: ignore
        return b""
    CONTENT_TYPE_LATEST = "text/plain"
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.responses import RedirectResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os
from pathlib import Path
# use FastAPI's http middleware decorator instead of importing starlette types

from ..infrastructure.config import get_settings
from ..infrastructure.logging import configure_logging
from ..presentation.docs import get_openapi_tags
from ..presentation.api.routers import auth as auth_router
from ..presentation.api.routers import rooms as rooms_router
from ..presentation.api.routers import participants as participants_router
from ..presentation.api.routers import messages as messages_router
from ..presentation.api.routers import webrtc as webrtc_router
from ..presentation.api.routers import friends as friends_router
from ..presentation.api.routers import push as push_router
from ..presentation.api.routers import users as users_router
from ..presentation.api.routers import direct as direct_router
from ..presentation.api.deps.containers import (
    get_user_repo,
    get_room_repo,
    get_participant_repo,
    get_message_repo,
    get_password_hasher,
    get_token_provider,
    get_signal_bus,
    get_ice_provider,
)
from ..presentation.ws import rooms as ws_rooms
from ..presentation.ws import friends as ws_friends
from ..presentation.ws import voice_capture as ws_voice
from ..presentation.api.deps.db import get_db_session
from ..infrastructure.db.repositories.users import PgUserRepository
from ..infrastructure.db.repositories.rooms import PgRoomRepository
from ..infrastructure.db.repositories.participants import PgParticipantRepository
from ..infrastructure.db.repositories.messages import PgMessageRepository
from ..infrastructure.security.jwt_provider import JoseTokenProvider
from ..infrastructure.security.password_hasher import BcryptPasswordHasher
from ..infrastructure.messaging.redis_bus import RedisSignalBus
from ..infrastructure.ice.provider import EnvIceConfigProvider
from ..presentation.errors import setup_error_handlers
from redis.asyncio import from_url as redis_from_url
from ..infrastructure.rate_limit.redis_rate_limiter import RedisRateLimiter, parse_rate

# --- Prometheus metric singletons (to avoid duplicate registration in tests) ---
# They are created lazily inside create_app() only once; subsequent create_app calls reuse them.
REQUEST_COUNT = None
REQ_LATENCY = None
WS_CONNECTIONS = None
CALL_SIGNAL_EVENTS = None
ACTIVE_WS = None
ACTIVE_CALLS = None
PENDING_INVITES = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # here we could init DB/Redis connections if needed globally
    yield


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(logging.INFO)

    # В проде отключаем публичный доступ к документации и схеме
    is_docs_enabled = settings.APP_ENV in {"dev", "test"}
    app = FastAPI(
        title=settings.APP_NAME,
        description="WebRTC signaling server with REST and WebSocket",
        version="0.1.0",
        docs_url="/docs" if is_docs_enabled else None,
        redoc_url="/redoc" if is_docs_enabled else None,
        openapi_url="/openapi.json" if is_docs_enabled else None,
        openapi_tags=get_openapi_tags(),
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.CORS_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Security headers middleware: add common HTTP security headers to every response.
    @app.middleware("http")
    async def security_headers_middleware(request, call_next):
        response = await call_next(request)
        # Prevent MIME sniffing
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        # Clickjacking protection
        response.headers.setdefault("X-Frame-Options", "DENY")
        # Referrer policy
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        # HSTS — only enable when running over HTTPS in production
        if settings.APP_ENV not in {"dev", "test"}:
            # one year, include subdomains, preload
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload")
        # Content Security Policy — теперь без 'unsafe-inline' для скриптов.
        # Inline-скрипты вынесены в /static/js/boot.js. Разрешаем только self.
        # Оставляем 'unsafe-inline' в style-src временно из-за множества inline style атрибутов в HTML.
        # Для полного ужесточения можно будет удалить и его после рефакторинга inline style.
        csp = (
            "default-src 'self'; "
            "script-src 'self'; "
            "connect-src 'self' ws: wss:; "
            "img-src 'self' data:; "
            "style-src 'self' 'unsafe-inline'; "
            "font-src 'self' data:; "
            "object-src 'none'; base-uri 'none'; frame-ancestors 'none';"
        )
        response.headers.setdefault("Content-Security-Policy", csp)
        return response

    # Redis / Rate limiter init (lazy) — создаём один клиент
    redis_client = None
    rate_limiter: RedisRateLimiter | None = None
    if settings.RATE_LIMIT:
        try:
            redis_client = redis_from_url(settings.REDIS_URL, decode_responses=True)
            limit, window = parse_rate(settings.RATE_LIMIT)
            rate_limiter = RedisRateLimiter(redis_client, limit, window)
        except Exception as e:  # pragma: no cover - безопасная деградация
            logging.getLogger("app.rate").warning("RateLimiter init failed: %s", e)

    @app.middleware("http")
    async def rate_limit_middleware(request, call_next):  # type: ignore[override]
        if rate_limiter is None:
            return await call_next(request)
        try:
            # Определяем сущность: авторизованный user_id или IP
            user_id = getattr(getattr(request, 'state', None), 'auth_user_id', None)
            ident = user_id or request.headers.get('x-forwarded-for') or request.client.host  # type: ignore[attr-defined]
            path = request.url.path if hasattr(request, 'url') else 'unknown'
            bucket = f"{ident}:{path}" if ident else path
            allowed = await rate_limiter.allow(bucket)
            if not allowed:
                from fastapi import Response
                return Response(status_code=429, content='{"detail":"rate limit exceeded"}', media_type='application/json')
        except Exception:
            pass  # fail-open
        return await call_next(request)

    setup_error_handlers(app)

    # Observability middleware: assign request id & measure latency
    # Prometheus metrics objects (singletons) if library present
    global REQUEST_COUNT, REQ_LATENCY, WS_CONNECTIONS, CALL_SIGNAL_EVENTS, ACTIVE_WS, ACTIVE_CALLS, PENDING_INVITES
    if Counter and REQUEST_COUNT is None:
        try:
            REQUEST_COUNT = Counter('app_requests_total', 'Total HTTP requests', ['method', 'path', 'status'])
            REQ_LATENCY = Histogram('app_request_latency_ms', 'Request latency in ms', ['method', 'path']) if Histogram else None
            WS_CONNECTIONS = Counter('ws_connections_total', 'Total WS connections opened', ['channel'])
            CALL_SIGNAL_EVENTS = Counter('call_signal_events_total', 'Call signaling events', ['event'])
            if _Gauge:
                ACTIVE_WS = _Gauge('ws_active', 'Active WebSocket connections', ['channel'])
                ACTIVE_CALLS = _Gauge('calls_active', 'Active accepted calls')
                PENDING_INVITES = _Gauge('call_invites_pending', 'Pending call invites (approx)')
        except ValueError:
            # Already registered (e.g., in tests) – ignore and rely on existing collectors
            pass

    @app.middleware("http")
    async def request_id_timing_middleware(request, call_next):  # type: ignore[override]
        req_id = str(uuid.uuid4())
        start = time.perf_counter()
        # store in state for handlers/logging if needed
        request.state.request_id = req_id  # type: ignore[attr-defined]
        try:
            response = await call_next(request)
        finally:
            duration_ms = (time.perf_counter() - start) * 1000.0
            # Minimal structured log (structlog configured)
            logging.getLogger("app.request").info(
                "request",
                extra={
                    "request_id": req_id,
                    "method": getattr(request, 'method', '?'),
                    "path": getattr(request, 'url', '?'),
                    "duration_ms": round(duration_ms, 2),
                },
            )
            try:
                if REQUEST_COUNT and REQ_LATENCY:
                    path_label = request.url.path if hasattr(request, 'url') else '?'
                    REQUEST_COUNT.labels(getattr(request, 'method', '?'), path_label, getattr(response, 'status_code', 0)).inc()
                    REQ_LATENCY.labels(getattr(request, 'method', '?'), path_label).observe(duration_ms)
            except Exception:
                pass
        try:
            response.headers.setdefault("X-Request-ID", req_id)
            response.headers.setdefault("Server-Timing", f"app;dur={duration_ms:.2f}")
        except Exception:
            pass
        return response

    # Routers
    app.include_router(auth_router.router)
    app.include_router(rooms_router.router)
    app.include_router(participants_router.router)
    app.include_router(messages_router.router)
    app.include_router(webrtc_router.router)
    app.include_router(friends_router.router)
    app.include_router(push_router.router)
    app.include_router(users_router.router)
    app.include_router(direct_router.router)

    # WS
    app.include_router(ws_rooms.router)
    app.include_router(ws_friends.router)
    app.include_router(ws_voice.router)

    # Static demo — use absolute path to avoid cwd-related issues and accidental exposure
    static_dir = str(Path(__file__).resolve().parent.parent.joinpath('presentation', 'static'))
    if os.path.isdir(static_dir):
        app.mount("/static", StaticFiles(directory=static_dir), name="static")
    else:
        # fallback to relative path if layout is unexpected
        app.mount("/static", StaticFiles(directory="app/presentation/static"), name="static")

    # Friendly entrypoints instead of /static/index.html
    @app.get("/", include_in_schema=False)
    async def root_redirect():
        return RedirectResponse(url="/call", status_code=307)

    @app.get("/call", include_in_schema=False)
    async def call_page():
        path = Path(static_dir).joinpath('index.html') if 'static_dir' in locals() else Path('app/presentation/static/index.html')
        return FileResponse(str(path))

    @app.get("/call/{room_id}", include_in_schema=False)
    async def call_page_room(room_id: str):  # room_id is used client-side from location
        path = Path(static_dir).joinpath('index.html') if 'static_dir' in locals() else Path('app/presentation/static/index.html')
        return FileResponse(str(path))

    @app.get("/auth", include_in_schema=False)
    async def auth_page():
        path = Path(static_dir).joinpath('auth.html') if 'static_dir' in locals() else Path('app/presentation/static/auth.html')
        return FileResponse(str(path))

    @app.get("/healthz", tags=["health"])
    async def healthz():
        return {"status": "ok"}

    @app.get("/metrics", include_in_schema=False)
    async def metrics():  # type: ignore[override]
        # If prometheus_client not installed, return empty set so that readiness probes succeed
        data = generate_latest()
        from fastapi import Response
        return Response(content=data, media_type=CONTENT_TYPE_LATEST)

    return app
