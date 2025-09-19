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

class PushNotifier(ABC):
    """Отправка push/webpush уведомлений.

    NOTE: Интерфейс восстановлен после очистки. Если останется неиспользованным в рабочем коде и тестах,
    может быть помечен как @deprecated перед финальным удалением в отдельном PR.
    """

    @abstractmethod
    async def notify_incoming_call(self, to_user_id: UUID, from_user_id: UUID, from_username: str | None, room_id: str) -> None:  # pragma: no cover - интерфейс
        raise NotImplementedError


class CallInviteService(ABC):
    """Сервис управления приглашениями к звонку (in-memory или внешнее хранилище)."""

    @abstractmethod
    async def invite(self, from_user_id: UUID, to_user_id: UUID, room_id: str, from_username: str | None, from_email: str | None) -> None:  # pragma: no cover - интерфейс
        raise NotImplementedError

    @abstractmethod
    async def accept(self, from_user_id: UUID, to_user_id: UUID, room_id: str) -> None:  # pragma: no cover
        raise NotImplementedError

    @abstractmethod
    async def decline(self, from_user_id: UUID, to_user_id: UUID, room_id: str) -> None:  # pragma: no cover
        raise NotImplementedError

    @abstractmethod
    async def cancel(self, from_user_id: UUID, to_user_id: UUID, room_id: str) -> None:  # pragma: no cover
        raise NotImplementedError

    @abstractmethod
    async def list_pending_for(self, user_id: UUID) -> list[dict]:  # pragma: no cover
        raise NotImplementedError
