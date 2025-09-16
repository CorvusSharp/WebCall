from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from ....core.ports.repositories import UserRepository
from ..deps.auth import get_current_user
from ..deps.containers import get_user_repo
from ....infrastructure.db.repositories.users import PgUserRepository


router = APIRouter(prefix="/api/v1/users", tags=["users"])


class PublicKeyIn(BaseModel):
    public_key: str


@router.post('/me/public_key')
async def set_my_public_key(body: PublicKeyIn, current=Depends(get_current_user), users: PgUserRepository = Depends(get_user_repo)):
    await users.set_public_key(current.id, body.public_key)
    return {"ok": True}


@router.get('/{user_id}/public_key')
async def get_user_public_key(user_id: str, users: PgUserRepository = Depends(get_user_repo)):
    u = await users.get_by_id(user_id)
    if not u:
        return {"public_key": None}
    return {"public_key": u.public_key}


class UserShort(BaseModel):
    id: str
    username: str
    email: str


@router.get("/find", response_model=List[UserShort])
async def find_users(q: str = Query(..., min_length=1), users: UserRepository = Depends(get_user_repo), current=Depends(get_current_user)):
    items = await users.search(q, limit=10)
    return [UserShort(id=str(u.id), username=u.username, email=str(u.email)) for u in items]
