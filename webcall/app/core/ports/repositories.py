from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Iterable, Optional
from datetime import datetime
from uuid import UUID

from ..domain.models import Message, Participant, Room, User


class UserRepository(ABC):
    @abstractmethod
    async def get_by_email(self, email: str) -> Optional[User]:
        raise NotImplementedError

    @abstractmethod
    async def get_by_username(self, username: str) -> Optional[User]:
        raise NotImplementedError

    @abstractmethod
    async def get_by_id(self, user_id: UUID) -> Optional[User]:
        raise NotImplementedError

    @abstractmethod
    async def add(self, user: User) -> None:
        raise NotImplementedError


class RoomRepository(ABC):
    @abstractmethod
    async def add(self, room: Room) -> None:
        raise NotImplementedError

    @abstractmethod
    async def get(self, room_id: UUID) -> Optional[Room]:
        raise NotImplementedError

    @abstractmethod
    async def get_many(self, ids: Iterable[UUID]) -> list[Room]:
        """Fetch multiple rooms by ids in a single call (order not guaranteed)."""
        raise NotImplementedError

    @abstractmethod
    async def list(self, owner_id: UUID | None = None, skip: int = 0, limit: int = 50) -> list[Room]:
        raise NotImplementedError

    @abstractmethod
    async def delete(self, room_id: UUID) -> None:
        raise NotImplementedError


class ParticipantRepository(ABC):
    @abstractmethod
    async def get(self, room_id: UUID, user_id: UUID) -> Optional[Participant]:
        raise NotImplementedError

    @abstractmethod
    async def get_active(self, room_id: UUID, user_id: UUID) -> Optional[Participant]:
        """Return active (left_at is NULL) participant record for the user in room, if any."""
        raise NotImplementedError

    @abstractmethod
    async def list_active(self, room_id: UUID) -> list[Participant]:
        raise NotImplementedError

    @abstractmethod
    async def add(self, participant: Participant) -> None:
        raise NotImplementedError

    @abstractmethod
    async def update(self, participant: Participant) -> None:
        raise NotImplementedError

    @abstractmethod
    async def remove(self, room_id: UUID, user_id: UUID) -> None:
        raise NotImplementedError

    @abstractmethod
    async def list_visited_rooms(self, user_id: UUID, skip: int = 0, limit: int = 50) -> list[tuple[UUID, datetime]]:
        """Return distinct rooms visited by user with last seen timestamp, ordered by last_seen desc.

        Items are tuples of (room_id, last_seen_at).
        """
        raise NotImplementedError


class MessageRepository(ABC):
    @abstractmethod
    async def add(self, message: Message) -> None:
        raise NotImplementedError

    @abstractmethod
    async def list(self, room_id: UUID, skip: int = 0, limit: int = 50) -> list[Message]:
        raise NotImplementedError
