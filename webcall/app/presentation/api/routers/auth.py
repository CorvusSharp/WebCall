from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
import hmac

from ....application.dto.auth import LoginInput, RegisterInput, RegisterOutput, TokenOutput, UpdateProfileInput, ChangePasswordInput
from ..deps.rate_limit import limit_login, limit_register
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
    _: None = Depends(limit_register),
) -> RegisterOutput:  # type: ignore[override]
    from ....application.use_cases.auth import RegisterUser
    from ....infrastructure.config import get_settings

    settings = get_settings()
    provided = data.secret
    if not hmac.compare_digest(provided.encode(), settings.REGISTRATION_SECRET.encode()):
        # Keep the word 'secret' in the message because tests assert it appears,
        # but make the message clearer for users.
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Неверный секретный код (secret)")

    use = RegisterUser(users, hasher)
    user = await use.execute(email=data.email, username=data.username, password=data.password)
    # user.username является value object (dataclass Username). Преобразуем к str для валидации Pydantic.
    return RegisterOutput(id=str(user.id), email=str(user.email), username=str(user.username))


@router.post("/login", response_model=TokenOutput)
async def login(
    data: LoginInput,
    users: UserRepository = Depends(get_user_repo),
    hasher: PasswordHasher = Depends(get_password_hasher),
    tokens: TokenProvider = Depends(get_token_provider),
    _: None = Depends(limit_login),
) -> TokenOutput:  # type: ignore[override]
    from ....application.use_cases.auth import LoginUser

    use = LoginUser(users, hasher, tokens)
    access = await use.execute(email=data.email, password=data.password)
    return TokenOutput(access_token=access)

    # Дополнительный endpoint: текущий пользователь
from pydantic import BaseModel
from ..deps.auth import get_current_user

class MeOut(BaseModel):
    id: str
    email: str
    username: str

@router.get("/me", response_model=MeOut)
async def get_me(current=Depends(get_current_user)) -> MeOut:  # type: ignore[override]
    return MeOut(id=str(current.id), email=str(current.email), username=str(current.username))


@router.patch("/me", response_model=MeOut)
async def update_me(
    data: UpdateProfileInput,
    current=Depends(get_current_user),
    users: UserRepository = Depends(get_user_repo),
) -> MeOut:  # type: ignore[override]
    if data.email is None and data.username is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Нужно указать email и/или username")
    try:
        updated = await users.update_profile(current.id, email=str(data.email) if data.email else None, username=data.username)
    except ConflictError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email или username уже заняты")
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return MeOut(id=str(updated.id), email=str(updated.email), username=str(updated.username))


from fastapi import Response

@router.post("/me/password", status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
async def change_password(
    data: ChangePasswordInput,
    current=Depends(get_current_user),
    users: UserRepository = Depends(get_user_repo),
    hasher: PasswordHasher = Depends(get_password_hasher),
) -> None:  # type: ignore[override]
    """Смена пароля текущего пользователя.

    Используем 204 No Content — поэтому явно указываем response_class=Response и
    ничего не возвращаем (без JSON null), иначе FastAPI сочтёт что есть тело.
    """
    if not hasher.verify(data.old_password, str(current.password_hash)):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Старый пароль неверен")
    new_hash = hasher.hash(data.new_password)
    ok = await users.update_password(current.id, new_hash)
    if not ok:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    # Ничего не возвращаем: 204 No Content
    return Response(status_code=status.HTTP_204_NO_CONTENT)
