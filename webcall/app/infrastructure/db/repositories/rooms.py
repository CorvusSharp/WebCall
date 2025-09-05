from __future__ import annotations

from typing import Optional
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.domain.models import Room
from ....core.domain.values import RoomName
from ....core.ports.repositories import RoomRepository
from ..models import Rooms


class PgRoomRepository(RoomRepository):
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def add(self, room: Room) -> None:  # type: ignore[override]
        self.session.add(
            Rooms(id=room.id, name=str(room.name), owner_id=room.owner_id, is_private=room.is_private, created_at=room.created_at)
        )
        await self.session.commit()

    async def get(self, room_id: UUID) -> Optional[Room]:  # type: ignore[override]
        row = await self.session.get(Rooms, room_id)
        if not row:
            return None
        return Room(id=row.id, name=RoomName(row.name), owner_id=row.owner_id, is_private=row.is_private, created_at=row.created_at)

    async def list(self, owner_id: UUID | None = None, skip: int = 0, limit: int = 50) -> list[Room]:  # type: ignore[override]
        stmt = select(Rooms)
        if owner_id:
            stmt = stmt.where(Rooms.owner_id == owner_id)
        stmt = stmt.offset(skip).limit(limit)
        res = await self.session.execute(stmt)
        rows = res.scalars().all()
        return [Room(id=r.id, name=RoomName(r.name), owner_id=r.owner_id, is_private=r.is_private, created_at=r.created_at) for r in rows]

    async def delete(self, room_id: UUID) -> None:  # type: ignore[override]
        await self.session.execute(delete(Rooms).where(Rooms.id == room_id))
        await self.session.commit()
