from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class ErrorResponse(BaseModel):
    detail: str


class UserOut(BaseModel):
    id: str
    email: str
    username: str


class RoomCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    is_private: bool = False


class RoomOut(BaseModel):
    id: str
    name: str
    owner_id: str
    is_private: bool
    created_at: datetime


class MessageIn(BaseModel):
    content: str = Field(min_length=1, max_length=2000)


class MessageOut(BaseModel):
    id: str
    room_id: str
    author_id: str
    content: str
    sent_at: datetime


class SignalIn(BaseModel):
    signalType: str
    sdp: Optional[str] = None
    candidate: Optional[dict] = None
    targetUserId: Optional[str] = None


class PresenceOut(BaseModel):
    users: list[dict]
