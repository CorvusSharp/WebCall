from __future__ import annotations

import logging
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
        # Content Security Policy — conservative default that allows scripts/styles from self
        # If you use inline scripts/styles or external CDNs, adjust this policy accordingly.
        # Allow 'unsafe-inline' for scripts for now to preserve current inline loader & service worker registration.
        # Consider moving inline scripts to external files and introducing nonces for better security.
        csp = "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none';"
        response.headers.setdefault("Content-Security-Policy", csp)
        return response

    setup_error_handlers(app)

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

    return app
