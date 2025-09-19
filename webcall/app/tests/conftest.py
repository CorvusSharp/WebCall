"""Минимальный тестовый bootstrap.

Цели:
 - Быстрый старт без Alembic (множество head ревизий ломает upgrade)
 - In‑memory SQLite (shared) + create_all из текущих ORM моделей
 - Быстрый PasswordHasher чтобы не тратить время на bcrypt
"""

import asyncio
import os
import sys
import pytest
from httpx import AsyncClient, ASGITransport
from uuid import UUID
from typing import Optional

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

os.environ.setdefault('JWT_SECRET', 'test-jwt-secret')
os.environ.setdefault('REGISTRATION_SECRET', 'test-registration')
os.environ.setdefault('DATABASE_URL', 'sqlite+aiosqlite:///file:memdb1?mode=memory&cache=shared')
os.environ.setdefault('REDIS_URL', 'redis://localhost:6379/0')

from app.infrastructure.config import get_settings  # noqa: E402
get_settings.cache_clear()  # type: ignore[attr-defined]
_ = get_settings()

from app.bootstrap.asgi import app  # noqa: E402
from app.presentation.api.deps.containers import get_password_hasher, get_user_repo  # noqa: E402
from app.core.ports.repositories import UserRepository  # noqa: E402
from app.core.domain.models import User  # noqa: E402


class _FastHasher:
    def hash(self, password: str) -> str:
        return 'h$' + password
    def verify(self, password: str, password_hash: str) -> bool:
        return password_hash == 'h$' + password


class _MemUserRepo(UserRepository):  # type: ignore[misc]
    def __init__(self):
        self._by_id: dict[UUID, User] = {}

    async def get_by_email(self, email: str) -> Optional[User]:  # type: ignore[override]
        for u in self._by_id.values():
            if str(u.email) == email:
                return u
        return None

    async def get_by_username(self, username: str) -> Optional[User]:  # type: ignore[override]
        for u in self._by_id.values():
            if str(u.username) == username:
                return u
        return None

    async def get_by_id(self, user_id: UUID) -> Optional[User]:  # type: ignore[override]
        return self._by_id.get(user_id)

    async def add(self, user: User) -> None:  # type: ignore[override]
        self._by_id[user.id] = user

    async def search(self, query: str, limit: int = 10) -> list[User]:  # type: ignore[override]
        q = query.lower()
        return [u for u in self._by_id.values() if q in str(u.username).lower() or q in str(u.email).lower()][:limit]


_mem_repo = _MemUserRepo()
app.dependency_overrides[get_password_hasher] = lambda: _FastHasher()
app.dependency_overrides[get_user_repo] = lambda: _mem_repo


# Создание схемы (для остальных репозиториев, если тесты их коснутся)
async def _init_schema():
    from app.infrastructure.db.session import ENGINE  # noqa: E402
    from app.infrastructure.db.base import Base  # noqa: E402
    from app.infrastructure import db as _models_import  # noqa: F401,E402
    async with ENGINE.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


asyncio.run(_init_schema())


@pytest.fixture(scope='session')
def anyio_backend():
    return 'asyncio'


@pytest.fixture()
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
