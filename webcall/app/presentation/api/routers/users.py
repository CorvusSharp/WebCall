from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from ....core.ports.repositories import UserRepository
from ..deps.auth import get_current_user
from ..deps.containers import get_user_repo


router = APIRouter(prefix="/api/v1/users", tags=["users"])


class UserShort(BaseModel):
    id: str
    username: str
    email: str


@router.get("/find", response_model=List[UserShort])
async def find_users(q: str = Query(..., min_length=1), users: UserRepository = Depends(get_user_repo), current=Depends(get_current_user)):
    items = await users.search(q, limit=10)
    return [UserShort(id=str(u.id), username=u.username, email=str(u.email)) for u in items]
