from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Iterable
from uuid import UUID

from ..domain.models import Participant, Role, Room
from ..errors import PermissionDenied, ValidationError


@dataclass(slots=True)
class RoomPolicy:
    max_participants: int = 16


class RoomService:
    def __init__(self, policy: RoomPolicy | None = None) -> None:
        self.policy = policy or RoomPolicy()

    def can_join(self, room: Room, participants: Iterable[Participant]) -> None:
        count = sum(1 for p in participants if p.left_at is None)
        if count >= self.policy.max_participants:
            raise ValidationError("Room is full")

    def ensure_can_kick(self, actor_role: Role, target_role: Role) -> None:
        if actor_role == Role.member:
            raise PermissionDenied("Only owner/moderator can kick")
        if actor_role == Role.moderator and target_role in {Role.owner, Role.moderator}:
            raise PermissionDenied("Moderator cannot kick owner/moderator")

    def ensure_can_toggle_mute(self, actor_role: Role, target_role: Role) -> None:
        if actor_role == Role.member:
            raise PermissionDenied("Only owner/moderator can mute")

    def leave(self, participant: Participant) -> Participant:
        if participant.left_at is None:
            participant.left_at = datetime.utcnow()
        return participant
