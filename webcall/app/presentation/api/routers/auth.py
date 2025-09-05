from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
import hmac

from ....application.dto.auth import LoginInput, RegisterInput, RegisterOutput, TokenOutput
from ....core.domain.models import User
from ....core.errors import ConflictError
from ....core.ports.repositories import UserRepository
from ....core.ports.services import PasswordHasher, TokenProvider
from ..deps.containers import get_password_hasher, get_token_provider, get_user_repo

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


@router.post("/register", response_model=RegisterOutput, status_code=status.HTTP_201_CREATED)
async def register(
    data: RegisterInput,
    users: UserRepository = Depends(get_user_repo),
    hasher: PasswordHasher = Depends(get_password_hasher),
) -> RegisterOutput:  # type: ignore[override]
    from ....application.use_cases.auth import RegisterUser
    from ....infrastructure.config import get_settings

    settings = get_settings()
    provided = data.secret
    if not hmac.compare_digest(provided.encode(), settings.REGISTRATION_SECRET.encode()):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="invalid registration secret")

    use = RegisterUser(users, hasher)
    user = await use.execute(email=data.email, username=data.username, password=data.password)
    return RegisterOutput(id=str(user.id), email=str(user.email), username=user.username)


@router.post("/login", response_model=TokenOutput)
async def login(
    data: LoginInput,
    users: UserRepository = Depends(get_user_repo),
    hasher: PasswordHasher = Depends(get_password_hasher),
    tokens: TokenProvider = Depends(get_token_provider),
) -> TokenOutput:  # type: ignore[override]
    from ....application.use_cases.auth import LoginUser

    use = LoginUser(users, hasher, tokens)
    access = await use.execute(email=data.email, password=data.password)
    return TokenOutput(access_token=access)
