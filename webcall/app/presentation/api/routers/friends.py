from __future__ import annotations

from typing import List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from ....core.domain.models import Friendship, FriendStatus
from ....core.errors import ConflictError
from ....core.ports.repositories import FriendshipRepository, UserRepository, DirectMessageRepository, DirectReadStateRepository
from ..deps.auth import get_current_user
from ..deps.containers import get_db_session
from ..deps.containers import get_user_repo, get_db_session
from ....infrastructure.db.repositories.direct_messages import PgDirectMessageRepository
from ....infrastructure.db.repositories.direct_reads import PgDirectReadStateRepository
from ....infrastructure.db.repositories.friends import PgFriendshipRepository
from pydantic import BaseModel
from ...ws.friends import (
    publish_friend_request,
    publish_friend_accepted,
    publish_friend_cancelled,
    publish_friend_removed,
)


router = APIRouter(prefix="/api/v1/friends", tags=["friends"])


class FriendRequestIn(BaseModel):
    user_id: UUID


class FriendshipOut(BaseModel):
    id: UUID
    user_id: UUID
    status: FriendStatus
    requested_by: UUID
    username: str | None = None
    email: str | None = None
    unread: int = 0


def _other_side(f: Friendship, me: UUID) -> UUID:
    return f.user_b_id if f.user_a_id == me else f.user_a_id


async def get_friend_repo(session=Depends(get_db_session)) -> FriendshipRepository:
    return PgFriendshipRepository(session)


@router.get("/", response_model=List[FriendshipOut])
async def list_friends(
    current=Depends(get_current_user),
    repo: FriendshipRepository = Depends(get_friend_repo),
    users: UserRepository = Depends(get_user_repo),
    dms: DirectMessageRepository = Depends(lambda session=Depends(get_db_session): PgDirectMessageRepository(session)),
    reads: DirectReadStateRepository = Depends(lambda session=Depends(get_db_session): PgDirectReadStateRepository(session)),
):
    items = await repo.list_friends(current.id, status=FriendStatus.accepted)
    result: list[FriendshipOut] = []
    for f in items:
        other_id = _other_side(f, current.id)
        u = await users.get_by_id(other_id)
        last_read = await reads.get_last_read(current.id, other_id)
        unread = await dms.count_unread(current.id, other_id, last_read)
        result.append(
            FriendshipOut(
                id=f.id,
                user_id=other_id,
                status=f.status,
                requested_by=f.requested_by,
                username=(u.username if u else None),
                email=(str(u.email) if u else None),
                unread=unread,
            )
        )
    return result


@router.get("/requests", response_model=List[FriendshipOut])
async def list_requests(
    current=Depends(get_current_user),
    repo: FriendshipRepository = Depends(get_friend_repo),
    users: UserRepository = Depends(get_user_repo),
):
    items = await repo.list_requests(current.id)
    result: list[FriendshipOut] = []
    for f in items:
        other_id = _other_side(f, current.id)
        u = await users.get_by_id(other_id)
        result.append(
            FriendshipOut(
                id=f.id,
                user_id=other_id,
                status=f.status,
                requested_by=f.requested_by,
                username=(u.username if u else None),
                email=(str(u.email) if u else None),
            )
        )
    return result


@router.post("/request", status_code=201)
async def send_request(body: FriendRequestIn, current=Depends(get_current_user), repo: FriendshipRepository = Depends(get_friend_repo)):
    if body.user_id == current.id:
        raise HTTPException(status_code=400, detail="Cannot add yourself")
    existing = await repo.get_pair(current.id, body.user_id)
    if existing:
        if existing.status == FriendStatus.accepted:
            raise HTTPException(status_code=409, detail="Already friends")
        # If pending and counterpart sent earlier, accept
        if existing.status == FriendStatus.pending and existing.requested_by != current.id:
            existing.status = FriendStatus.accepted
            existing.requested_by = current.id
            existing.updated_at = existing.updated_at
            await repo.update(existing)
            # publish accept for both sides
            try:
                await publish_friend_accepted(existing.user_a_id, existing.user_b_id, None, None)
            except Exception:
                pass
            return {"ok": True, "accepted": True}
        raise HTTPException(status_code=409, detail="Request already exists")
    f = Friendship.pair(current.id, body.user_id, requested_by=current.id)
    await repo.add(f)
    # publish request to target user
    try:
        await publish_friend_request(current.id, body.user_id, None)
    except Exception:
        pass
    return {"ok": True}


@router.post("/{friend_id}/accept")
async def accept_friend(friend_id: UUID, current=Depends(get_current_user), repo: FriendshipRepository = Depends(get_friend_repo)):
    f = await repo.get_pair(current.id, friend_id)
    if not f or f.status != FriendStatus.pending or f.requested_by == current.id:
        raise HTTPException(status_code=404, detail="No incoming request")
    f.status = FriendStatus.accepted
    f.requested_by = current.id
    f.updated_at = f.updated_at
    await repo.update(f)
    try:
        await publish_friend_accepted(f.user_a_id, f.user_b_id, None, None)
    except Exception:
        pass
    return {"ok": True}


@router.post("/{friend_id}/cancel")
async def cancel_request(friend_id: UUID, current=Depends(get_current_user), repo: FriendshipRepository = Depends(get_friend_repo)):
    f = await repo.get_pair(current.id, friend_id)
    if not f or f.status != FriendStatus.pending or f.requested_by != current.id:
        raise HTTPException(status_code=404, detail="No outgoing request")
    # simple delete via update to blocked then ignore — but better to delete; for simplicity we mark blocked
    f.status = FriendStatus.blocked
    f.updated_at = f.updated_at
    await repo.update(f)
    try:
        await publish_friend_cancelled(current.id, friend_id)
    except Exception:
        pass
    return {"ok": True}


@router.delete("/{friend_id}")
async def delete_friend(friend_id: UUID, current=Depends(get_current_user), repo: FriendshipRepository = Depends(get_friend_repo)):
    """Удалить дружбу (обоюдно). Если дружбы нет — 404.

    Возвращает {ok:true}. Паблишит WS событие friend_removed обеим сторонам.
    """
    f = await repo.get_pair(current.id, friend_id)
    if not f or f.status != FriendStatus.accepted:
        raise HTTPException(status_code=404, detail="Friendship not found")
    # Удаляем
    await repo.remove(current.id, friend_id)
    try:
        await publish_friend_removed(current.id, friend_id)
    except Exception:
        pass
    return {"ok": True}
