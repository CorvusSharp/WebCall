import asyncio
import os
import sys
import pathlib
import pytest
from httpx import AsyncClient, ASGITransport

# Добавляем корень (..\..) /webcall в sys.path чтобы 'app' был виден если тесты запускаются напрямую
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

# Минимальный набор env переменных до импорта приложения
os.environ.setdefault('JWT_SECRET', 'test-jwt-secret')
os.environ.setdefault('REGISTRATION_SECRET', 'test-registration')
# Абсолютный путь для sqlite чтобы alembic гарантированно писал туда же
_abs_db = pathlib.Path(ROOT).joinpath('test_app.db').resolve().as_posix()
os.environ.setdefault('DATABASE_URL', f'sqlite+aiosqlite:///{_abs_db}')
os.environ.setdefault('REDIS_URL', 'redis://localhost:6379/0')

from app.infrastructure.config import get_settings
get_settings.cache_clear()  # type: ignore[attr-defined]
_ = get_settings()  # прогреваем

from app.bootstrap.asgi import app  # noqa: E402
from app.presentation.api.deps.containers import get_password_hasher  # noqa: E402
from app.presentation.api.deps.containers import get_user_repo  # noqa: E402
from app.core.ports.repositories import UserRepository  # noqa: E402
from app.core.domain.models import User  # noqa: E402
from app.core.domain.values import Email, Username, PasswordHash  # noqa: E402
from uuid import UUID
from typing import Optional

# Ускоренный хэшер для тестов (bcrypt на Windows может быть медленным)
class _FastHasher:
    def hash(self, password: str) -> str:
        return 'h$' + password
    def verify(self, password: str, password_hash: str) -> bool:
        return password_hash == 'h$' + password

app.dependency_overrides[get_password_hasher] = lambda: _FastHasher()

# In-memory UserRepository (минимальный для auth тестов, без БД)
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
        res = [u for u in self._by_id.values() if q in str(u.username).lower() or q in str(u.email).lower()]
        return res[:limit]

_mem_repo = _MemUserRepo()
app.dependency_overrides[get_user_repo] = lambda: _mem_repo

# --- Прогон Alembic миграций (async) вместо ручного create_all ---
def _run_migrations_sync():
    from alembic.config import Config
    from alembic import command
    # Используем alembic.ini в корне webcall/ (относительно этого файла: ../../alembic.ini)
    ini_path = os.path.abspath(os.path.join(ROOT, 'alembic.ini'))
    print(f"[tests.migrate] Using alembic ini: {ini_path} (exists={os.path.exists(ini_path)})")
    print(f"[tests.migrate] DATABASE_URL={os.environ.get('DATABASE_URL')}")
    cfg = Config(ini_path)
    # Явно прописываем абсолютный путь до каталога alembic, т.к. pytest меняет рабочий каталог
    scripts_abs = os.path.abspath(os.path.join(ROOT, 'alembic'))
    cfg.set_main_option('script_location', scripts_abs)
    # В тестах окружение уже настроено через env vars; alembic/env.py дернет get_settings()
    command.upgrade(cfg, 'head')
    print('[tests.migrate] Alembic upgrade head completed')


db_url = os.environ.get('DATABASE_URL', '')
if db_url.startswith('sqlite'):
    # sqlite+aiosqlite:///./test_app.db -> путь после тройного слэша
    path_part = db_url.split('///', 1)[-1]
    # Удалим старый файл чтобы начинать с чистой схемы
    if path_part and not path_part.startswith(':memory:'):
        p = pathlib.Path(path_part)
        if p.exists():
            try:
                p.unlink()
            except OSError:
                pass

_migrated = False
try:
    _run_migrations_sync()
    _migrated = True
except Exception as e:  # pragma: no cover
    print('WARN: alembic migrations failed:', e)

if not _migrated:
    # Fallback: прямое создание схемы из текущих моделей (обходит конфликт heads в миграциях)
    try:
        from sqlalchemy import create_engine as _create_engine_sync
        from app.infrastructure.db.base import Base  # noqa: E402
        from app.infrastructure import db as _models_import  # noqa: F401,E402  # ensure models imported
        db_url_sync = os.environ['DATABASE_URL'].replace('+aiosqlite', '')
        eng = _create_engine_sync(db_url_sync)
        Base.metadata.create_all(eng)
        eng.dispose()
        # Пересоздаём async ENGINE после синхронного create_all чтобы исключить блокировки
        from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
        from sqlalchemy.orm import sessionmaker
        from app.infrastructure.db import session as db_session
        try:
            db_session.ENGINE.dispose()
        except Exception:
            pass
        db_session.ENGINE = create_async_engine(os.environ['DATABASE_URL'], pool_pre_ping=True)
        db_session.AsyncSessionLocal = sessionmaker(bind=db_session.ENGINE, class_=AsyncSession, expire_on_commit=False)  # type: ignore[attr-defined]
        print('[tests.schema] Metadata create_all completed (fallback, sync)')
    except Exception as e:  # pragma: no cover
        print('[tests.schema] Fallback create_all failed:', e)


@pytest.fixture(scope="session")
def anyio_backend():
    return 'asyncio'


@pytest.fixture()
async def client():
    # httpx>=0.27: pass ASGITransport instead of deprecated app= argument
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
