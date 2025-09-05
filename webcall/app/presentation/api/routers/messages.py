from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends

from ....application.dto.messages import MessageDTO, PostMessageInput
from ....application.use_cases.messages import ListMessages, PostMessage
from ....core.ports.repositories import MessageRepository
from ..deps.containers import get_message_repo

router = APIRouter(prefix="/api/v1/rooms/{room_id}/messages", tags=["messages"])


@router.post("", response_model=MessageDTO)
async def post_message(room_id: str, data: PostMessageInput, messages: MessageRepository = Depends(get_message_repo)) -> MessageDTO:  # type: ignore[override]
    use = PostMessage(messages)
    msg = await use.execute(room_id=UUID(room_id), author_id=UUID(data.author_id), content=data.content)
    return MessageDTO(id=str(msg.id), room_id=str(msg.room_id), author_id=str(msg.author_id), content=msg.content, sent_at=msg.sent_at)


@router.get("", response_model=list[MessageDTO])
async def list_messages(room_id: str, skip: int = 0, limit: int = 50, messages: MessageRepository = Depends(get_message_repo)):  # type: ignore[override]
    use = ListMessages(messages)
    items = await use.execute(room_id=UUID(room_id), skip=skip, limit=limit)
    return [MessageDTO(id=str(m.id), room_id=str(m.room_id), author_id=str(m.author_id), content=m.content, sent_at=m.sent_at) for m in items]
