from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.responses import RedirectResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

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

    # WS
    app.include_router(ws_rooms.router)

    # Static demo
    app.mount("/static", StaticFiles(directory="app/presentation/static"), name="static")

    # Friendly entrypoints instead of /static/index.html
    @app.get("/", include_in_schema=False)
    async def root_redirect():
        return RedirectResponse(url="/call", status_code=307)

    @app.get("/call", include_in_schema=False)
    async def call_page():
        return FileResponse("app/presentation/static/index.html")

    @app.get("/call/{room_id}", include_in_schema=False)
    async def call_page_room(room_id: str):  # room_id is used client-side from location
        return FileResponse("app/presentation/static/index.html")

    @app.get("/auth", include_in_schema=False)
    async def auth_page():
        return FileResponse("app/presentation/static/auth.html")

    @app.get("/healthz", tags=["health"])
    async def healthz():
        return {"status": "ok"}

    return app
