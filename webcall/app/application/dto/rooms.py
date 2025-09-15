from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field


class CreateRoomInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    is_private: bool = False


class RoomDTO(BaseModel):
    id: str
    name: str
    owner_id: str
    is_private: bool
    created_at: datetime


class ListRoomsInput(BaseModel):
    owner_id: Optional[str] = None
    skip: int = 0
    limit: int = 50


class VisitedRoomDTO(BaseModel):
    room_id: str
    last_seen: datetime
    # optional metadata if room still exists
    name: Optional[str] = None
    owner_id: Optional[str] = None
    is_private: Optional[bool] = None
