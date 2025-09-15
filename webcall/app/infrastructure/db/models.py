from __future__ import annotations

from datetime import datetime
from uuid import UUID

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .base import Base


class Users(Base):
    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True, nullable=False)
    username: Mapped[str] = mapped_column(String(50), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), nullable=False)

    # Связь с созданными пользователем комнатами (users.id -> rooms.owner_id)
    rooms = relationship("Rooms", back_populates="owner", foreign_keys="Rooms.owner_id")


class Rooms(Base):
    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    owner_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    is_private: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), nullable=False)

    # Владелец комнаты (rooms.owner_id -> users.id)
    owner = relationship("Users", back_populates="rooms", foreign_keys=[owner_id])


class Participants(Base):
    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True)
    room_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), ForeignKey("rooms.id"), index=True, nullable=False)
    user_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), ForeignKey("users.id"), index=True, nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    muted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    joined_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), nullable=False)
    left_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=False), nullable=True)


class Messages(Base):
    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True)
    room_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), ForeignKey("rooms.id"), index=True, nullable=False)
    author_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), ForeignKey("users.id"), index=True, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), nullable=False, index=True)


class Friendships(Base):
    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True)
    user_a_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), ForeignKey("users.id"), index=True, nullable=False)
    user_b_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), ForeignKey("users.id"), index=True, nullable=False)
    requested_by: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), nullable=False)

    __table_args__ = (
        UniqueConstraint("user_a_id", "user_b_id", name="uq_friend_pair"),
    )


class PushSubscriptions(Base):
    __tablename__ = "push_subscriptions"
    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True)
    user_id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), ForeignKey("users.id"), index=True, nullable=False)
    endpoint: Mapped[str] = mapped_column(Text, nullable=False)
    p256dh: Mapped[str] = mapped_column(String(255), nullable=False)
    auth: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=False), nullable=False)

    __table_args__ = (
        UniqueConstraint("user_id", "endpoint", name="uq_push_user_endpoint"),
    )
