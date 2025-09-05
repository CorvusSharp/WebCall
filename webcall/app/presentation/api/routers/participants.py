from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from ....application.use_cases.participants import JoinRoom, KickParticipant, LeaveRoom, ToggleMute
from ....core.domain.models import Role
from ....core.errors import NotFoundError
from ....core.ports.repositories import ParticipantRepository, RoomRepository
from ..deps.containers import get_participant_repo, get_room_repo
from ....core.services.room_service import RoomService

router = APIRouter(prefix="/api/v1/rooms/{room_id}", tags=["participants"])


@router.post("/join")
async def join_room(
    room_id: str,
    user_id: str,
    participants: ParticipantRepository = Depends(get_participant_repo),
    rooms: RoomRepository = Depends(get_room_repo),
) -> dict:  # type: ignore[override]
    use = JoinRoom(participants, rooms, RoomService())
    p = await use.execute(room_id=UUID(room_id), user_id=UUID(user_id), role=Role.member)
    return {"status": "ok", "participantId": str(p.id)}


@router.post("/leave")
async def leave_room(room_id: str, user_id: str, participants: ParticipantRepository = Depends(get_participant_repo)) -> dict:  # type: ignore[override]
    use = LeaveRoom(participants)
    await use.execute(room_id=UUID(room_id), user_id=UUID(user_id))
    return {"status": "ok"}


@router.post("/kick/{target_id}")
async def kick(
    room_id: str,
    target_id: str,
    actor_id: str,
    participants: ParticipantRepository = Depends(get_participant_repo),
) -> dict:  # type: ignore[override]
    use = KickParticipant(participants, RoomService())
    await use.execute(room_id=UUID(room_id), actor_id=UUID(actor_id), target_id=UUID(target_id))
    return {"status": "ok"}


@router.post("/toggle-mute/{target_id}")
async def toggle_mute(
    room_id: str,
    target_id: str,
    actor_id: str,
    participants: ParticipantRepository = Depends(get_participant_repo),
) -> dict:  # type: ignore[override]
    use = ToggleMute(participants, RoomService())
    await use.execute(room_id=UUID(room_id), actor_id=UUID(actor_id), target_id=UUID(target_id))
    return {"status": "ok"}
