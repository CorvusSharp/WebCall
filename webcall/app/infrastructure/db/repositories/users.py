from __future__ import annotations

from typing import Optional
from uuid import UUID

from sqlalchemy import select, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.domain.models import User
from ....core.domain.values import Email, PasswordHash
from ....core.ports.repositories import UserRepository
from ..models import Users
from ....core.errors import ConflictError
from ...db.utils import safe_like


class PgUserRepository(UserRepository):
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def get_by_email(self, email: str) -> Optional[User]:  # type: ignore[override]
        stmt = select(Users).where(Users.email == email)
        res = await self.session.execute(stmt)
        row = res.scalar_one_or_none()
        if row:
            return User(id=row.id, email=Email(row.email), username=row.username, password_hash=PasswordHash(row.password_hash), created_at=row.created_at)
        return None

    async def get_by_id(self, user_id: UUID) -> Optional[User]:  # type: ignore[override]
        row = await self.session.get(Users, user_id)
        if row:
            return User(id=row.id, email=Email(row.email), username=row.username, password_hash=PasswordHash(row.password_hash), created_at=row.created_at, public_key=row.public_key)
        return None

    async def get_by_username(self, username: str) -> Optional[User]:  # type: ignore[override]
        stmt = select(Users).where(Users.username == username)
        res = await self.session.execute(stmt)
        row = res.scalar_one_or_none()
        if row:
            return User(id=row.id, email=Email(row.email), username=row.username, password_hash=PasswordHash(row.password_hash), created_at=row.created_at)
        return None

    async def add(self, user: User) -> None:  # type: ignore[override]
        self.session.add(Users(id=user.id, email=str(user.email), username=user.username, password_hash=str(user.password_hash), public_key=user.public_key if hasattr(user, 'public_key') else None, created_at=user.created_at))
        try:
            await self.session.commit()
        except IntegrityError as e:
            await self.session.rollback()
            # Переводим БД-ошибку в доменную 409
            raise ConflictError("User with same email or username already exists") from e

    async def set_public_key(self, user_id: UUID, public_key: str) -> None:
        row = await self.session.get(Users, user_id)
        if not row:
            return
        row.public_key = public_key
        self.session.add(row)
        await self.session.commit()

    async def search(self, query: str, limit: int = 10) -> list[User]:  # type: ignore[override]
        pattern = safe_like(query, max_len=100)
        if not pattern:
            return []

        stmt = (
            select(Users)
            .where(
                or_(
                    Users.username.ilike(pattern, escape='\\'),
                    Users.email.ilike(pattern, escape='\\'),
                )
            )
            .order_by(Users.username.asc())
            .limit(limit)
        )
        res = await self.session.execute(stmt)
        rows = res.scalars().all()
        return [
            User(id=r.id, email=Email(r.email), username=r.username, password_hash=PasswordHash(r.password_hash), created_at=r.created_at)
            for r in rows
        ]
