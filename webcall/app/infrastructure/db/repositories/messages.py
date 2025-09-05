from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.domain.models import Message
from ....core.ports.repositories import MessageRepository
from ..models import Messages


class PgMessageRepository(MessageRepository):
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def add(self, message: Message) -> None:  # type: ignore[override]
        self.session.add(
            Messages(
                id=message.id,
                room_id=message.room_id,
                author_id=message.author_id,
                content=message.content,
                sent_at=message.sent_at,
            )
        )
        await self.session.commit()

    async def list(self, room_id: UUID, skip: int = 0, limit: int = 50) -> list[Message]:  # type: ignore[override]
        stmt = select(Messages).where(Messages.room_id == room_id).order_by(Messages.sent_at.asc()).offset(skip).limit(limit)
        res = await self.session.execute(stmt)
        rows = res.scalars().all()
        return [Message(id=r.id, room_id=r.room_id, author_id=r.author_id, content=r.content, sent_at=r.sent_at) for r in rows]
