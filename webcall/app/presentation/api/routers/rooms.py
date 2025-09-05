from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends

from ....application.dto.rooms import CreateRoomInput, ListRoomsInput, RoomDTO
from ....application.use_cases.rooms import CreateRoom, GetRoom, ListRooms
from ....core.ports.repositories import RoomRepository
from ..deps.containers import get_room_repo
from ..deps.auth import get_current_user

router = APIRouter(prefix="/api/v1/rooms", tags=["rooms"])


@router.post("", response_model=RoomDTO)
async def create_room(
    data: CreateRoomInput,
    rooms: RoomRepository = Depends(get_room_repo),
    current_user=Depends(get_current_user),
) -> RoomDTO:  # type: ignore[override]
    use = CreateRoom(rooms)
    room = await use.execute(name=data.name, owner_id=UUID(str(current_user.id)), is_private=data.is_private)
    return RoomDTO(id=str(room.id), name=str(room.name), owner_id=str(room.owner_id), is_private=room.is_private, created_at=room.created_at)


@router.get("", response_model=list[RoomDTO])
async def list_rooms(
    owner_id: str | None = None,
    skip: int = 0,
    limit: int = 50,
    rooms: RoomRepository = Depends(get_room_repo),
    current_user=Depends(get_current_user),
):  # type: ignore[override]
    use = ListRooms(rooms)
    rid = UUID(owner_id) if owner_id else None
    items = await use.execute(owner_id=rid, skip=skip, limit=limit)
    return [RoomDTO(id=str(r.id), name=str(r.name), owner_id=str(r.owner_id), is_private=r.is_private, created_at=r.created_at) for r in items]


@router.get("/{room_id}", response_model=RoomDTO)
async def get_room(
    room_id: str,
    rooms: RoomRepository = Depends(get_room_repo),
    current_user=Depends(get_current_user),
) -> RoomDTO:  # type: ignore[override]
    use = GetRoom(rooms)
    room = await use.execute(UUID(room_id))
    return RoomDTO(id=str(room.id), name=str(room.name), owner_id=str(room.owner_id), is_private=room.is_private, created_at=room.created_at)


@router.delete("/{room_id}")
async def delete_room(
    room_id: str,
    rooms: RoomRepository = Depends(get_room_repo),
    current_user=Depends(get_current_user),
):  # type: ignore[override]
    from ....application.use_cases.rooms import DeleteRoom, GetRoom

    getter = GetRoom(rooms)
    room = await getter.execute(UUID(room_id))
    if not room or str(room.owner_id) != str(current_user.id):
        from fastapi import HTTPException, status

        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only owner can delete room")
    deleter = DeleteRoom(rooms)
    await deleter.execute(UUID(room_id))
    return {"status": "deleted"}
