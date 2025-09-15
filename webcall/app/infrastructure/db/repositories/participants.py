from __future__ import annotations

from typing import Optional
from uuid import UUID

from sqlalchemy import delete, select, update, func
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.domain.models import Participant, Role
from ....core.ports.repositories import ParticipantRepository
from ..models import Participants


class PgParticipantRepository(ParticipantRepository):
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get(self, room_id: UUID, user_id: UUID) -> Optional[Participant]:  # type: ignore[override]
        stmt = select(Participants).where(Participants.room_id == room_id, Participants.user_id == user_id)
        res = await self.session.execute(stmt)
        row = res.scalar_one_or_none()
        if row:
            return Participant(
                id=row.id,
                user_id=row.user_id,
                room_id=row.room_id,
                role=Role(row.role),
                muted=row.muted,
                joined_at=row.joined_at,
                left_at=row.left_at,
            )
        return None

    async def list_active(self, room_id: UUID) -> list[Participant]:  # type: ignore[override]
        stmt = select(Participants).where(Participants.room_id == room_id, Participants.left_at.is_(None))
        res = await self.session.execute(stmt)
        rows = res.scalars().all()
        return [
            Participant(id=r.id, user_id=r.user_id, room_id=r.room_id, role=Role(r.role), muted=r.muted, joined_at=r.joined_at, left_at=r.left_at)
            for r in rows
        ]

    async def get_active(self, room_id: UUID, user_id: UUID) -> Optional[Participant]:  # type: ignore[override]
        stmt = select(Participants).where(
            Participants.room_id == room_id, Participants.user_id == user_id, Participants.left_at.is_(None)
        )
        res = await self.session.execute(stmt)
        row = res.scalar_one_or_none()
        if row:
            return Participant(
                id=row.id,
                user_id=row.user_id,
                room_id=row.room_id,
                role=Role(row.role),
                muted=row.muted,
                joined_at=row.joined_at,
                left_at=row.left_at,
            )
        return None

    async def add(self, participant: Participant) -> None:  # type: ignore[override]
        self.session.add(
            Participants(
                id=participant.id,
                user_id=participant.user_id,
                room_id=participant.room_id,
                role=participant.role.value,
                muted=participant.muted,
                joined_at=participant.joined_at,
                left_at=participant.left_at,
            )
        )
        await self.session.commit()

    async def update(self, participant: Participant) -> None:  # type: ignore[override]
        await self.session.execute(
            update(Participants)
            .where(Participants.id == participant.id)
            .values(muted=participant.muted, left_at=participant.left_at)
        )
        await self.session.commit()

    async def remove(self, room_id: UUID, user_id: UUID) -> None:  # type: ignore[override]
        await self.session.execute(
            delete(Participants).where(Participants.room_id == room_id, Participants.user_id == user_id)
        )
        await self.session.commit()

    async def list_visited_rooms(self, user_id: UUID, skip: int = 0, limit: int = 50) -> list[tuple[UUID, datetime]]:  # type: ignore[override]
        # Для «последнего визита» возьмём max(joined_at, left_at) по каждой комнате
        # Если left_at NULL (ещё в комнате) — используем joined_at
        last_seen = func.coalesce(Participants.left_at, Participants.joined_at)
        stmt = (
            select(Participants.room_id, func.max(last_seen).label("last_seen"))
            .where(Participants.user_id == user_id)
            .group_by(Participants.room_id)
            .order_by(func.max(last_seen).desc())
            .offset(skip)
            .limit(limit)
        )
        res = await self.session.execute(stmt)
        rows = list(res.all())
        return [(r[0], r[1]) for r in rows]
