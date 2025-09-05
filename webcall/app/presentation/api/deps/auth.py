from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from ....core.errors import NotFoundError
from ....core.ports.repositories import UserRepository
from ....core.ports.services import TokenProvider
from .containers import get_user_repo, get_token_provider


bearer_scheme = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    users: UserRepository = Depends(get_user_repo),
    tokens: TokenProvider = Depends(get_token_provider),
):
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        payload = tokens.decode_token(credentials.credentials)
        sub = payload.get("sub")
        user = await users.get_by_id(UUID(sub))
        if not user:
            raise NotFoundError()
        return user
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
