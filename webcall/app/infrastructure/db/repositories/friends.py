from __future__ import annotations

from typing import List, Optional
from uuid import UUID

from sqlalchemy import and_, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.domain.models import Friendship, FriendStatus
from ....core.ports.repositories import FriendshipRepository
from ..models import Friendships


def _order_pair(a: UUID, b: UUID) -> tuple[UUID, UUID]:
    return (a, b) if str(a) <= str(b) else (b, a)


class PgFriendshipRepository(FriendshipRepository):
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_pair(self, user_a: UUID, user_b: UUID) -> Optional[Friendship]:  # type: ignore[override]
        ua, ub = _order_pair(user_a, user_b)
        stmt = select(Friendships).where(and_(Friendships.user_a_id == ua, Friendships.user_b_id == ub))
        res = await self.session.execute(stmt)
        row = res.scalar_one_or_none()
        if not row:
            return None
        return Friendship(id=row.id, user_a_id=row.user_a_id, user_b_id=row.user_b_id, requested_by=row.requested_by, status=FriendStatus(row.status), created_at=row.created_at, updated_at=row.updated_at)

    async def list_friends(self, user_id: UUID, status: FriendStatus = FriendStatus.accepted) -> List[Friendship]:  # type: ignore[override]
        stmt = select(Friendships).where(and_(or_(Friendships.user_a_id == user_id, Friendships.user_b_id == user_id), Friendships.status == status.value))
        res = await self.session.execute(stmt)
        rows = res.scalars().all()
        return [Friendship(id=r.id, user_a_id=r.user_a_id, user_b_id=r.user_b_id, requested_by=r.requested_by, status=FriendStatus(r.status), created_at=r.created_at, updated_at=r.updated_at) for r in rows]

    async def list_requests(self, user_id: UUID) -> List[Friendship]:  # type: ignore[override]
        stmt = select(Friendships).where(and_(or_(Friendships.user_a_id == user_id, Friendships.user_b_id == user_id), Friendships.status == FriendStatus.pending.value, Friendships.requested_by != user_id))
        res = await self.session.execute(stmt)
        rows = res.scalars().all()
        return [Friendship(id=r.id, user_a_id=r.user_a_id, user_b_id=r.user_b_id, requested_by=r.requested_by, status=FriendStatus(r.status), created_at=r.created_at, updated_at=r.updated_at) for r in rows]

    async def add(self, f: Friendship) -> None:  # type: ignore[override]
        ua, ub = _order_pair(f.user_a_id, f.user_b_id)
        self.session.add(
            Friendships(
                id=f.id,
                user_a_id=ua,
                user_b_id=ub,
                requested_by=f.requested_by,
                status=f.status.value,
                created_at=f.created_at,
                updated_at=f.updated_at,
            )
        )
        await self.session.commit()

    async def update(self, f: Friendship) -> None:  # type: ignore[override]
        await self.session.execute(
            update(Friendships)
            .where(Friendships.id == f.id)
            .values(status=f.status.value, requested_by=f.requested_by, updated_at=f.updated_at)
        )
        await self.session.commit()
