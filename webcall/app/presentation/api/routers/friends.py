from __future__ import annotations

from typing import List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from ....core.domain.models import Friendship, FriendStatus
from ....core.errors import ConflictError
from ....core.ports.repositories import FriendshipRepository, UserRepository
from ..deps.auth import get_current_user
from ..deps.containers import get_db_session
from ..deps.containers import get_user_repo
from ....infrastructure.db.repositories.friends import PgFriendshipRepository
from pydantic import BaseModel


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


def _other_side(f: Friendship, me: UUID) -> UUID:
    return f.user_b_id if f.user_a_id == me else f.user_a_id


async def get_friend_repo(session=Depends(get_db_session)) -> FriendshipRepository:
    return PgFriendshipRepository(session)


@router.get("/", response_model=List[FriendshipOut])
async def list_friends(
    current=Depends(get_current_user),
    repo: FriendshipRepository = Depends(get_friend_repo),
    users: UserRepository = Depends(get_user_repo),
):
    items = await repo.list_friends(current.id, status=FriendStatus.accepted)
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
            return {"ok": True, "accepted": True}
        raise HTTPException(status_code=409, detail="Request already exists")
    f = Friendship.pair(current.id, body.user_id, requested_by=current.id)
    await repo.add(f)
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
    return {"ok": True}
