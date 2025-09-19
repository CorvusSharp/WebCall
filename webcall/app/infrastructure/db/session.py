from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from ..config import get_settings


_settings = get_settings()
db_url = _settings.DATABASE_URL

engine_kwargs = {"pool_pre_ping": True}
# Для sqlite (особенно :memory: или aiosqlite) параметры пула не поддерживаются — пропустим
if not db_url.startswith("sqlite"):
    engine_kwargs.update({
        "pool_size": 5,
        "max_overflow": 10,
        "pool_timeout": 30,
    })

ENGINE: AsyncEngine = create_async_engine(db_url, **engine_kwargs)
AsyncSessionLocal = sessionmaker(bind=ENGINE, class_=AsyncSession, expire_on_commit=False)


@asynccontextmanager
async def get_session() -> AsyncIterator[AsyncSession]:
    async with AsyncSessionLocal() as session:  # type: ignore[misc]
        yield session
