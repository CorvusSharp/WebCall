from __future__ import annotations

from uuid import UUID

from ...core.domain.models import Message
from ...core.ports.repositories import MessageRepository


class PostMessage:
    def __init__(self, messages: MessageRepository) -> None:
        self.messages = messages

    async def execute(self, room_id: UUID, author_id: UUID, content: str) -> Message:
        msg = Message.post(room_id=room_id, author_id=author_id, content=content)
        await self.messages.add(msg)
        return msg


class ListMessages:
    def __init__(self, messages: MessageRepository) -> None:
        self.messages = messages

    async def execute(self, room_id: UUID, skip: int = 0, limit: int = 50) -> list[Message]:
        return await self.messages.list(room_id=room_id, skip=skip, limit=limit)
