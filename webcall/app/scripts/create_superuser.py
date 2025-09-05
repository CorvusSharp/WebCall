import asyncio
from uuid import UUID

from app.infrastructure.db.session import AsyncSessionLocal
from app.infrastructure.db.repositories.users import PgUserRepository
from app.infrastructure.security.password_hasher import BcryptPasswordHasher


async def main():
    async with AsyncSessionLocal() as session:  # type: ignore[misc]
        users = PgUserRepository(session)
        hasher = BcryptPasswordHasher()
        # minimal example: ensure user exists
        from app.core.domain.models import User

        u = User.create("admin@example.com", "admin", hasher.hash("admin"))
        await users.add(u)
        print("Created:", u.id)


if __name__ == "__main__":
    asyncio.run(main())
