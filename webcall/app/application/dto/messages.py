from __future__ import annotations

from datetime import datetime
from pydantic import BaseModel, Field


class PostMessageInput(BaseModel):
    room_id: str
    author_id: str
    content: str = Field(min_length=1, max_length=2000)


class MessageDTO(BaseModel):
    id: str
    room_id: str
    author_id: str
    content: str
    sent_at: datetime
