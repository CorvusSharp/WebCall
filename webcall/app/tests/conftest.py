"""Минимальный тестовый bootstrap.

Цели:
 - Быстрый старт без Alembic (множество head ревизий ломает upgrade)
 - In‑memory SQLite (shared) + create_all из текущих ORM моделей
 - Быстрый PasswordHasher чтобы не тратить время на bcrypt
"""

import asyncio
import os
import sys
from types import SimpleNamespace
from uuid import UUID, uuid4
from typing import Optional

import pytest
from httpx import AsyncClient, ASGITransport

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
from app.presentation.api.deps import rate_limit as rate_module  # noqa: E402
from app.core.ports.repositories import UserRepository  # noqa: E402
from app.core.domain.models import User  # noqa: E402
from app.core.domain.values import Email, PasswordHash, Username  # noqa: E402
from app.core.errors import ConflictError  # noqa: E402


class _FastHasher:
    _suffix = '$fakehash'

    def hash(self, password: str) -> str:
        # Вернём стабильный "хеш" достаточно длинный, чтобы пройти валидацию PasswordHash
        return 'h$' + password + self._suffix

    def verify(self, password: str, password_hash: str) -> bool:
        return password_hash == self.hash(password)


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

    async def update_profile(
        self,
        user_id: UUID,
        *,
        email: str | None = None,
        username: str | None = None,
    ) -> User | None:  # type: ignore[override]
        user = self._by_id.get(user_id)
        if not user:
            return None
        new_email = Email(email) if email is not None else user.email
        new_username = Username(username) if username is not None else user.username
        # проверка конфликтов
        for uid, existing in self._by_id.items():
            if uid == user_id:
                continue
            if email is not None and str(existing.email) == str(new_email):
                raise ConflictError('email taken')
            if username is not None and str(existing.username) == str(new_username):
                raise ConflictError('username taken')
        updated = User(
            id=user.id,
            email=new_email,
            username=new_username,
            password_hash=user.password_hash,
            created_at=user.created_at,
            public_key=user.public_key,
        )
        self._by_id[user_id] = updated
        return updated

    async def update_password(self, user_id: UUID, password_hash: str) -> bool:  # type: ignore[override]
        user = self._by_id.get(user_id)
        if not user:
            return False
        updated = User(
            id=user.id,
            email=user.email,
            username=user.username,
            password_hash=PasswordHash(password_hash),
            created_at=user.created_at,
            public_key=user.public_key,
        )
        self._by_id[user_id] = updated
        return True


_mem_repo = _MemUserRepo()
_test_hasher = _FastHasher()
app.dependency_overrides[get_password_hasher] = lambda: _test_hasher
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


@pytest.fixture()
async def async_client(client):
    # Некоторые тесты ожидают фикстуру async_client — сделаем алиас поверх client
    yield client


@pytest.fixture(autouse=True)
def reset_rate_limits():
    rate_module._login_limiter.events.clear()
    rate_module._register_limiter.events.clear()
    rate_module._room_create_limiter.events.clear()
    yield
    rate_module._login_limiter.events.clear()
    rate_module._register_limiter.events.clear()
    rate_module._room_create_limiter.events.clear()


def _unique_credentials(prefix: str = "user") -> tuple[str, str, str]:
    suffix = uuid4().hex[:8]
    email = f"{prefix}-{suffix}@example.com"
    username = f"{prefix}_{suffix}"
    password = f"pass{suffix}"
    return email, username, password


async def _ensure_registered(client: AsyncClient, email: str, username: str, password: str) -> None:
    secret = os.getenv('REGISTRATION_SECRET', 'test-registration')
    resp = await client.post(
        '/api/v1/auth/register',
        json={'email': email, 'username': username, 'password': password, 'secret': secret},
    )
    if resp.status_code not in (200, 201, 409):
        raise AssertionError(f"registration failed: {resp.status_code} {resp.text}")


@pytest.fixture()
async def registered_user_token(async_client: AsyncClient) -> str:
    email, username, password = _unique_credentials('primary')
    await _ensure_registered(async_client, email, username, password)
    login = await async_client.post('/api/v1/auth/login', json={'email': email, 'password': password})
    assert login.status_code == 200, login.text
    data = login.json()
    token = data.get('access_token')
    assert token, data
    return token


@pytest.fixture()
async def second_user(async_client: AsyncClient) -> SimpleNamespace:
    email, username, password = _unique_credentials('secondary')
    await _ensure_registered(async_client, email, username, password)
    return SimpleNamespace(email=email, username=username, password=password)
