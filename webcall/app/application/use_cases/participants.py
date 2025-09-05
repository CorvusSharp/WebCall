from __future__ import annotations

from uuid import UUID

from ...core.domain.models import Participant, Role
from ...core.errors import NotFoundError
from ...core.ports.repositories import ParticipantRepository, RoomRepository
from ...core.services.room_service import RoomService


class JoinRoom:
    def __init__(self, participants: ParticipantRepository, rooms: RoomRepository, policy: RoomService) -> None:
        self.participants = participants
        self.rooms = rooms
        self.policy = policy

    async def execute(self, room_id: UUID, user_id: UUID, role: Role = Role.member) -> Participant:
        room = await self.rooms.get(room_id)
        if not room:
            raise NotFoundError("Room not found")
        active = await self.participants.list_active(room_id)
        self.policy.can_join(room, active)
        participant = Participant.join(user_id=user_id, room_id=room_id, role=role)
        await self.participants.add(participant)
        return participant


class LeaveRoom:
    def __init__(self, participants: ParticipantRepository) -> None:
        self.participants = participants

    async def execute(self, room_id: UUID, user_id: UUID) -> None:
        p = await self.participants.get(room_id, user_id)
        if p:
            p.left_at = p.left_at or p.joined_at
            await self.participants.update(p)


class KickParticipant:
    def __init__(self, participants: ParticipantRepository, policy: RoomService) -> None:
        self.participants = participants
        self.policy = policy

    async def execute(self, room_id: UUID, actor_id: UUID, target_id: UUID) -> None:
        actor = await self.participants.get(room_id, actor_id)
        target = await self.participants.get(room_id, target_id)
        if not actor or not target:
            raise NotFoundError("Participants not found")
        self.policy.ensure_can_kick(actor.role, target.role)
        await self.participants.remove(room_id, target_id)


class ToggleMute:
    def __init__(self, participants: ParticipantRepository, policy: RoomService) -> None:
        self.participants = participants
        self.policy = policy

    async def execute(self, room_id: UUID, actor_id: UUID, target_id: UUID) -> None:
        actor = await self.participants.get(room_id, actor_id)
        target = await self.participants.get(room_id, target_id)
        if not actor or not target:
            raise NotFoundError("Participants not found")
        self.policy.ensure_can_toggle_mute(actor.role, target.role)
        target.muted = not target.muted
        await self.participants.update(target)
