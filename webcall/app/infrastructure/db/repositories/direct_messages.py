from __future__ import annotations

from typing import List
from uuid import UUID

from sqlalchemy import select, and_, desc
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.domain.models import DirectMessage
from ....core.ports.repositories import DirectMessageRepository
from .. import models as m


class PgDirectMessageRepository(DirectMessageRepository):
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def add(self, dm: DirectMessage) -> None:  # type: ignore[override]
        row = m.DirectMessages(
            id=dm.id,
            user_a_id=dm.user_a_id,
            user_b_id=dm.user_b_id,
            sender_id=dm.sender_id,
            ciphertext=dm.ciphertext,
            sent_at=dm.sent_at,
        )
        self.session.add(row)
        await self.session.flush()

    async def list_pair(self, user_a: UUID, user_b: UUID, limit: int = 50, before: UUID | None = None) -> List[DirectMessage]:  # type: ignore[override]
        a_s, b_s = str(user_a), str(user_b)
        if a_s <= b_s:
            ua, ub = user_a, user_b
        else:
            ua, ub = user_b, user_a
        stmt = select(m.DirectMessages).where(and_(m.DirectMessages.user_a_id == ua, m.DirectMessages.user_b_id == ub))
        if before:
            # Понадобится получить sent_at указанного сообщения и фильтровать по времени
            sub = select(m.DirectMessages.sent_at).where(m.DirectMessages.id == before).scalar_subquery()
            stmt = stmt.where(m.DirectMessages.sent_at < sub)
        stmt = stmt.order_by(desc(m.DirectMessages.sent_at)).limit(limit)
        rows = (await self.session.execute(stmt)).scalars().all()
        result: List[DirectMessage] = []
        for r in rows:
            result.append(DirectMessage(
                id=r.id,
                user_a_id=r.user_a_id,
                user_b_id=r.user_b_id,
                sender_id=r.sender_id,
                ciphertext=r.ciphertext,
                sent_at=r.sent_at,
            ))
        return result
