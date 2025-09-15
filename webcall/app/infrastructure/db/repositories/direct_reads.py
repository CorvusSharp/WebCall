from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.ports.repositories import DirectReadStateRepository
from ..models import DirectReadStates


class PgDirectReadStateRepository(DirectReadStateRepository):
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_last_read(self, user_id: UUID, friend_id: UUID) -> datetime | None:  # type: ignore[override]
        res = await self.session.execute(
            select(DirectReadStates).where(
                (DirectReadStates.owner_id == user_id) & (DirectReadStates.other_id == friend_id)
            )
        )
        row = res.scalars().first()
        return row.last_read_at if row else None

    async def set_last_read(self, user_id: UUID, friend_id: UUID, when: datetime) -> None:  # type: ignore[override]
        # upsert-поведение: попробуем загрузить, затем вставить/обновить
        res = await self.session.execute(
            select(DirectReadStates).where(
                (DirectReadStates.owner_id == user_id) & (DirectReadStates.other_id == friend_id)
            )
        )
        row = res.scalars().first()
        if row:
            row.last_read_at = when
        else:
            row = DirectReadStates(owner_id=user_id, other_id=friend_id, last_read_at=when)
            self.session.add(row)
        await self.session.commit()
