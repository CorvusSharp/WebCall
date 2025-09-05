from __future__ import annotations

import asyncio
import os
import sys
from typing import Optional

import asyncpg


def _to_asyncpg_dsn(url: str) -> str:
    # Convert SQLAlchemy async URL (postgresql+asyncpg://...) to asyncpg-compatible DSN
    if url.startswith("postgresql+asyncpg://"):
        return "postgresql://" + url.split("postgresql+asyncpg://", 1)[1]
    return url


async def wait_for_db(dsn: str, timeout: float = 60.0, interval: float = 1.0) -> None:
    deadline = asyncio.get_event_loop().time() + timeout
    last_err: Optional[BaseException] = None
    while True:
        try:
            conn = await asyncpg.connect(dsn)
        except Exception as e:  # pragma: no cover - best effort utility
            last_err = e
            if asyncio.get_event_loop().time() >= deadline:
                break
            await asyncio.sleep(interval)
        else:
            await conn.close()
            return
    # Timed out
    if last_err:
        print(f"wait_for_db: failed to connect within {timeout}s: {last_err}", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":  # pragma: no cover
    dsn = _to_asyncpg_dsn(os.environ.get("DATABASE_URL", "postgresql://postgres@postgres:5432/postgres"))
    asyncio.run(wait_for_db(dsn))
import asyncio

import asyncpg


async def main():
    dsn = "postgresql://webcall:secret@postgres:5432/webcall"
    for _ in range(30):
        try:
            conn = await asyncpg.connect(dsn)
            await conn.close()
            print("db ready")
            return
        except Exception:
            await asyncio.sleep(1)
    raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
