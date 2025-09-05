from __future__ import annotations

from typing import Optional
from uuid import UUID

from ...core.domain.models import Room
from ...core.ports.repositories import RoomRepository


class CreateRoom:
    def __init__(self, rooms: RoomRepository) -> None:
        self.rooms = rooms

    async def execute(self, name: str, owner_id: UUID, is_private: bool = False) -> Room:
        room = Room.create(name=name, owner_id=owner_id, is_private=is_private)
        await self.rooms.add(room)
        return room


class ListRooms:
    def __init__(self, rooms: RoomRepository) -> None:
        self.rooms = rooms

    async def execute(self, owner_id: Optional[UUID] = None, skip: int = 0, limit: int = 50) -> list[Room]:
        return await self.rooms.list(owner_id=owner_id, skip=skip, limit=limit)


class GetRoom:
    def __init__(self, rooms: RoomRepository) -> None:
        self.rooms = rooms

    async def execute(self, room_id: UUID) -> Optional[Room]:
        return await self.rooms.get(room_id)


class DeleteRoom:
    def __init__(self, rooms: RoomRepository) -> None:
        self.rooms = rooms

    async def execute(self, room_id: UUID) -> None:
        await self.rooms.delete(room_id)
