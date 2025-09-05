from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any
from uuid import UUID

from ..domain.models import Signal


class SignalBus(ABC):
    @abstractmethod
    async def publish(self, room_id: UUID, signal: Signal) -> None:
        raise NotImplementedError

    @abstractmethod
    async def subscribe(self, room_id: UUID):
        """Возвращает асинхронный итератор по сообщениям Signal."""
        raise NotImplementedError

    @abstractmethod
    async def update_presence(self, room_id: UUID, user_id: UUID, present: bool) -> None:
        raise NotImplementedError

    @abstractmethod
    async def list_presence(self, room_id: UUID) -> list[dict[str, Any]]:
        raise NotImplementedError


class PasswordHasher(ABC):
    @abstractmethod
    def hash(self, password: str) -> str:
        raise NotImplementedError

    @abstractmethod
    def verify(self, password: str, password_hash: str) -> bool:
        raise NotImplementedError


class TokenProvider(ABC):
    @abstractmethod
    def create_access_token(self, subject: str, expires_minutes: int) -> str:
        raise NotImplementedError

    @abstractmethod
    def decode_token(self, token: str) -> dict:
        raise NotImplementedError


class Clock(ABC):
    @abstractmethod
    def now(self) -> datetime:
        raise NotImplementedError


class IceConfigProvider(ABC):
    @abstractmethod
    async def get_servers(self) -> list[dict]:
        raise NotImplementedError
