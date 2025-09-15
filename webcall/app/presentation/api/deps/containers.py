from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from ....infrastructure.db.session import get_session
from ....infrastructure.db.session import get_session as _get_session
from ....infrastructure.db.repositories.users import PgUserRepository
from ....infrastructure.db.repositories.rooms import PgRoomRepository
from ....infrastructure.db.repositories.participants import PgParticipantRepository
from ....infrastructure.db.repositories.messages import PgMessageRepository
from ....infrastructure.db.repositories.friends import PgFriendshipRepository
from ....infrastructure.db.repositories.push_subs import PgPushSubscriptionRepository
from ....infrastructure.security.password_hasher import BcryptPasswordHasher
from ....infrastructure.security.jwt_provider import JoseTokenProvider
from ....infrastructure.ice.provider import EnvIceConfigProvider


# DB session
# DB session provider
async def get_db_session() -> AsyncSession:
    async with _get_session() as s:  # type: ignore[misc]
        return s
from ....infrastructure.messaging.redis_bus import RedisSignalBus
from ....infrastructure.messaging.inmemory_bus import InMemorySignalBus
from ....infrastructure.config import get_settings
from functools import lru_cache


# Repositories
async def get_user_repo(session: AsyncSession = Depends(get_db_session)):
    return PgUserRepository(session)


async def get_room_repo(session: AsyncSession = Depends(get_db_session)):
    return PgRoomRepository(session)


async def get_participant_repo(session: AsyncSession = Depends(get_db_session)):
    return PgParticipantRepository(session)


async def get_message_repo(session: AsyncSession = Depends(get_db_session)):
    return PgMessageRepository(session)


async def get_friendship_repo(session: AsyncSession = Depends(get_db_session)):
    return PgFriendshipRepository(session)


async def get_push_subscription_repo(session: AsyncSession = Depends(get_db_session)):
    return PgPushSubscriptionRepository(session)


# Services
def get_password_hasher():
    return BcryptPasswordHasher()


def get_token_provider():
    return JoseTokenProvider()


def get_signal_bus():
    # Singleton SignalBus per process to ensure all WS share the same bus
    return _get_signal_bus_singleton()


@lru_cache(maxsize=1)
def _get_signal_bus_singleton():
    s = get_settings()
    # Use in-memory bus by default for local/dev/testing; switch to Redis via env
    if s.APP_ENV in {"dev", "test"}:
        return InMemorySignalBus()
    return RedisSignalBus()


def get_ice_provider():
    return EnvIceConfigProvider()
