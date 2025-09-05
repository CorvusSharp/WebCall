# app/scripts/wait_for_db.py
from __future__ import annotations

import asyncio
import os
import sys

import asyncpg


def _to_asyncpg_dsn(url: str) -> str:
    """
    Convert SQLAlchemy async URL (postgresql+asyncpg://...) to asyncpg-compatible DSN.
    """
    if url.startswith("postgresql+asyncpg://"):
        return "postgresql://" + url[len("postgresql+asyncpg://") :]
    return url


async def main() -> None:
    # Берём URL из окружения (как в .env). Фолбэк — только для локалки.
    env_url = os.getenv(
        "DATABASE_URL",
        "postgresql+asyncpg://webcall:secret@postgres:5432/webcall",
    )
    dsn = _to_asyncpg_dsn(env_url)

    # Подождём до 60 сек, печатая причину (чтобы было видно в логах почему ждём)
    last_err: Exception | None = None
    for attempt in range(60):
        try:
            conn = await asyncpg.connect(dsn)
            await conn.close()
            print("db ready")
            return
        except Exception as e:
            last_err = e
            print(f"[wait_for_db] attempt {attempt+1}/60: {e!r}")
            await asyncio.sleep(1)

    print("[wait_for_db] database is not ready, aborting", file=sys.stderr)
    if last_err:
        print(f"[wait_for_db] last error: {last_err!r}", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
