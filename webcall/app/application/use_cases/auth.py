from __future__ import annotations

from uuid import UUID

from ...core.domain.models import User
from ...core.errors import AuthError, ConflictError, NotFoundError
from ...core.ports.repositories import UserRepository
from ...core.ports.services import PasswordHasher, TokenProvider


class RegisterUser:
    def __init__(self, users: UserRepository, hasher: PasswordHasher) -> None:
        self.users = users
        self.hasher = hasher

    async def execute(self, email: str, username: str, password: str) -> User:
        if await self.users.get_by_email(email):
            raise ConflictError("Email already registered")
        if await self.users.get_by_username(username):
            raise ConflictError("Username already taken")
        pwd_hash = self.hasher.hash(password)
        user = User.create(email=email, username=username, password_hash=pwd_hash)
        await self.users.add(user)
        return user


class LoginUser:
    def __init__(self, users: UserRepository, hasher: PasswordHasher, tokens: TokenProvider) -> None:
        self.users = users
        self.hasher = hasher
        self.tokens = tokens

    async def execute(self, email: str, password: str) -> str:
        user = await self.users.get_by_email(email)
        if not user or not self.hasher.verify(password, str(user.password_hash)):
            raise AuthError("Invalid credentials")
        return self.tokens.create_access_token(str(user.id), None)
