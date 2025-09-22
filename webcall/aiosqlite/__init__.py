"""Lightweight async wrapper around :mod:`sqlite3` for test environments.

This is not a full implementation of the upstream ``aiosqlite`` package, but
provides enough of the API surface for SQLAlchemy's ``sqlite+aiosqlite``
dialect that our test-suite relies on.  Operations execute synchronously while
protected by an :class:`asyncio.Lock`, which preserves the expected sequential
semantics without introducing background threads.

Only the pieces touched by the application (``connect`` returning an async
context manager, ``Connection``/``Cursor`` methods and attributes, and the
standard DB-API error types) are implemented.  The real library exposes more
helpers; if additional behaviour is required in future the module can be
extended incrementally.
"""

from __future__ import annotations

import asyncio
import sqlite3
from typing import Any, Iterable, Optional, Sequence

__all__ = [
    "connect",
    "Connection",
    "Cursor",
    "Row",
    "Error",
    "Warning",
    "InterfaceError",
    "DatabaseError",
    "DataError",
    "OperationalError",
    "IntegrityError",
    "InternalError",
    "ProgrammingError",
    "NotSupportedError",
    "sqlite_version",
    "sqlite_version_info",
]

# Re-export common sqlite error types so callers can rely on the standard
# DB-API exceptions exposed by the original library.
Error = sqlite3.Error
Warning = sqlite3.Warning
InterfaceError = sqlite3.InterfaceError
DatabaseError = sqlite3.DatabaseError
DataError = sqlite3.DataError
OperationalError = sqlite3.OperationalError
IntegrityError = sqlite3.IntegrityError
InternalError = sqlite3.InternalError
ProgrammingError = sqlite3.ProgrammingError
NotSupportedError = sqlite3.NotSupportedError

Row = sqlite3.Row
sqlite_version = sqlite3.sqlite_version
sqlite_version_info = sqlite3.sqlite_version_info


class Cursor:
    """Async wrapper over :class:`sqlite3.Cursor`."""

    def __init__(self, connection: "Connection", cursor: sqlite3.Cursor):
        self._connection = connection
        self._cursor = cursor

    # ---- standard cursor attributes ----
    @property
    def description(self):  # type: ignore[override]
        return self._cursor.description

    @property
    def rowcount(self) -> int:
        return self._cursor.rowcount

    @property
    def arraysize(self) -> int:
        return getattr(self._cursor, "arraysize", 1)

    @arraysize.setter
    def arraysize(self, value: int) -> None:
        try:
            self._cursor.arraysize = value
        except AttributeError:
            # ``sqlite3.Cursor`` always has ``arraysize``, but we guard just in case.
            pass

    @property
    def lastrowid(self) -> int:
        return self._cursor.lastrowid

    # ---- async helpers ----
    async def _run(self, func, *args, **kwargs):
        async with self._connection._lock:  # noqa: SLF001 - shared lock is intentional
            return func(*args, **kwargs)

    # ---- context manager protocol ----
    async def __aenter__(self) -> "Cursor":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()

    # ---- DB-API methods ----
    async def close(self) -> None:
        await self._run(self._cursor.close)

    async def execute(self, sql: str, parameters: Optional[Sequence[Any]] = None) -> "Cursor":
        if parameters is None:
            await self._run(self._cursor.execute, sql)
        else:
            await self._run(self._cursor.execute, sql, parameters)
        return self

    async def executemany(self, sql: str, seq_of_parameters: Iterable[Sequence[Any]]) -> "Cursor":
        await self._run(self._cursor.executemany, sql, seq_of_parameters)
        return self

    async def fetchone(self):
        return await self._run(self._cursor.fetchone)

    async def fetchmany(self, size: Optional[int] = None):
        n = size if size is not None else self.arraysize
        return await self._run(self._cursor.fetchmany, n)

    async def fetchall(self):
        return await self._run(self._cursor.fetchall)

    async def setinputsizes(self, *_sizes) -> None:
        # SQLite ignores setinputsizes – keep parity with the DB-API spec.
        return None

    def setoutputsize(self, _size, _column=None) -> None:
        return None

    async def callproc(self, *_args, **_kwargs):
        raise NotSupportedError("SQLite does not support stored procedures")

    async def nextset(self):
        return None

    def __aiter__(self):
        async def iterator():
            while True:
                row = await self.fetchone()
                if row is None:
                    break
                yield row

        return iterator()


class Connection:
    """Async wrapper over :class:`sqlite3.Connection`."""

    def __init__(self, connection: sqlite3.Connection):
        self._conn = connection
        self._lock = asyncio.Lock()

    async def _run(self, func, *args, **kwargs):
        async with self._lock:
            return func(*args, **kwargs)

    # ---- context manager protocol ----
    async def __aenter__(self) -> "Connection":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()

    # ---- high-level helpers ----
    async def cursor(self) -> Cursor:
        cursor = await self._run(self._conn.cursor)
        return Cursor(self, cursor)

    async def execute(self, sql: str, parameters: Optional[Sequence[Any]] = None) -> Cursor:
        cursor = await self.cursor()
        await cursor.execute(sql, parameters)
        return cursor

    async def executemany(self, sql: str, seq_of_parameters: Iterable[Sequence[Any]]) -> Cursor:
        cursor = await self.cursor()
        await cursor.executemany(sql, seq_of_parameters)
        return cursor

    async def executescript(self, script: str) -> Cursor:
        cursor = await self.cursor()
        await cursor._run(cursor._cursor.executescript, script)
        return cursor

    async def create_function(self, *args, **kwargs) -> None:
        await self._run(self._conn.create_function, *args, **kwargs)

    async def create_aggregate(self, *args, **kwargs) -> None:
        await self._run(self._conn.create_aggregate, *args, **kwargs)

    async def create_collation(self, *args, **kwargs) -> None:
        await self._run(self._conn.create_collation, *args, **kwargs)

    async def commit(self) -> None:
        await self._run(self._conn.commit)

    async def rollback(self) -> None:
        await self._run(self._conn.rollback)

    async def close(self) -> None:
        await self._run(self._conn.close)

    # ---- attribute proxies ----
    @property
    def row_factory(self):
        return self._conn.row_factory

    @row_factory.setter
    def row_factory(self, value):
        self._conn.row_factory = value

    @property
    def total_changes(self) -> int:
        return self._conn.total_changes

    @property
    def in_transaction(self) -> bool:
        return self._conn.in_transaction

    @property
    def isolation_level(self):
        return self._conn.isolation_level

    @isolation_level.setter
    def isolation_level(self, value):
        self._conn.isolation_level = value

    def __getattr__(self, item: str) -> Any:
        return getattr(self._conn, item)


class _ConnectFuture:
    """Awaitable helper that mirrors the behaviour of :func:`aiosqlite.connect`."""

    def __init__(self, database: str, args: tuple[Any, ...], kwargs: dict[str, Any]):
        self._database = database
        self._args = args
        self._kwargs = dict(kwargs)
        self.daemon = False  # SQLAlchemy flips this flag; we accept it for compatibility
        self._connection: Connection | None = None

    async def _ensure(self) -> Connection:
        if self._connection is None:
            params = dict(self._kwargs)
            if "check_same_thread" not in params:
                params["check_same_thread"] = False
            raw = sqlite3.connect(self._database, *self._args, **params)
            self._connection = Connection(raw)
        return self._connection

    def __await__(self):
        return self._ensure().__await__()

    async def __aenter__(self):
        return await self._ensure()

    async def __aexit__(self, exc_type, exc, tb):
        if self._connection is not None:
            await self._connection.close()
            self._connection = None


def connect(database: str, *args, **kwargs) -> _ConnectFuture:
    """Return an awaitable that yields a :class:`Connection`."""

    return _ConnectFuture(database, args, kwargs)

