from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional
from uuid import UUID, uuid4

from .values import Email, PasswordHash, RoomName


class Role(str, Enum):
    owner = "owner"
    moderator = "moderator"
    member = "member"


@dataclass(slots=True)
class User:
    id: UUID
    email: Email
    username: str
    password_hash: PasswordHash
    created_at: datetime

    @staticmethod
    def create(email: str, username: str, password_hash: str) -> "User":
        return User(
            id=uuid4(),
            email=Email(email),
            username=username,
            password_hash=PasswordHash(password_hash),
            created_at=datetime.utcnow(),
        )


@dataclass(slots=True)
class Room:
    id: UUID
    name: RoomName
    owner_id: UUID
    is_private: bool
    created_at: datetime

    @staticmethod
    def create(name: str, owner_id: UUID, is_private: bool = False) -> "Room":
        return Room(id=uuid4(), name=RoomName(name), owner_id=owner_id, is_private=is_private, created_at=datetime.utcnow())


@dataclass(slots=True)
class Participant:
    id: UUID
    user_id: UUID
    room_id: UUID
    role: Role
    muted: bool
    joined_at: datetime
    left_at: Optional[datetime] = None

    @staticmethod
    def join(user_id: UUID, room_id: UUID, role: Role) -> "Participant":
        return Participant(id=uuid4(), user_id=user_id, room_id=room_id, role=role, muted=False, joined_at=datetime.utcnow())


@dataclass(slots=True)
class Message:
    id: UUID
    room_id: UUID
    author_id: UUID
    content: str
    sent_at: datetime

    @staticmethod
    def post(room_id: UUID, author_id: UUID, content: str) -> "Message":
        return Message(id=uuid4(), room_id=room_id, author_id=author_id, content=content[:2000], sent_at=datetime.utcnow())


class SignalType(str, Enum):
    offer = "offer"
    answer = "answer"
    ice_candidate = "ice-candidate"


@dataclass(slots=True)
class Signal:
    type: SignalType
    sender_id: UUID
    room_id: UUID
    sent_at: datetime
    sdp: Optional[str] = None
    candidate: Optional[dict] = None
    target_id: Optional[UUID] = None

    @staticmethod
    def create(type: str, sender_id: UUID, room_id: UUID, sdp: Optional[str] = None, candidate: Optional[dict] = None, target_id: Optional[UUID] = None) -> "Signal":
        st = SignalType(type)
        return Signal(type=st, sender_id=sender_id, room_id=room_id, sent_at=datetime.utcnow(), sdp=sdp, candidate=candidate, target_id=target_id)
