from __future__ import annotations

from fastapi import Depends
from typing import AsyncIterator
from sqlalchemy.ext.asyncio import AsyncSession

from ....infrastructure.db.session import get_session
from ....infrastructure.db.session import get_session as _get_session
from ....infrastructure.db.repositories.users import PgUserRepository
from ....infrastructure.db.repositories.rooms import PgRoomRepository
from ....infrastructure.db.repositories.participants import PgParticipantRepository
from ....infrastructure.db.repositories.messages import PgMessageRepository
from ....infrastructure.db.repositories.friends import PgFriendshipRepository
from ....infrastructure.db.repositories.push_subs import PgPushSubscriptionRepository
from ....infrastructure.db.repositories.direct_messages import PgDirectMessageRepository
from ....infrastructure.security.password_hasher import BcryptPasswordHasher
from ....infrastructure.security.jwt_provider import JoseTokenProvider
from ....infrastructure.ice.provider import EnvIceConfigProvider
from ....infrastructure.services.call_invites import InMemoryCallInviteService
from ....infrastructure.services.call_invites_redis import RedisCallInviteService
from ....infrastructure.services.push_notifier import SimplePushNotifier
from ....core.ports.services import CallInviteService, PushNotifier
from ....infrastructure.config import get_settings
from redis.asyncio import from_url as redis_from_url


# DB session provider (request-scoped)
async def get_db_session() -> AsyncIterator[AsyncSession]:
    async with _get_session() as s:  # type: ignore[misc]
        yield s
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


async def get_direct_message_repo(session: AsyncSession = Depends(get_db_session)):
    return PgDirectMessageRepository(session)


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


# Call / Push services (process-wide singletons where appropriate)
_call_invite_service: CallInviteService | None = None
_push_notifier_singleton: PushNotifier | None = None


def get_call_invite_service() -> CallInviteService:
    global _call_invite_service
    if _call_invite_service is None:
        settings = get_settings()
        if settings.CALL_INVITES_BACKEND.lower() == 'redis':
            try:
                redis_client = redis_from_url(settings.REDIS_URL, decode_responses=True)
                _call_invite_service = RedisCallInviteService(redis_client)
            except Exception:  # pragma: no cover - fallback
                _call_invite_service = InMemoryCallInviteService()
        else:
            _call_invite_service = InMemoryCallInviteService()
    return _call_invite_service


async def get_push_notifier(
    subs_repo = Depends(get_push_subscription_repo),  # type: ignore
    user_repo = Depends(get_user_repo),  # type: ignore
):  # -> PushNotifier
    global _push_notifier_singleton
    if _push_notifier_singleton is None:
        _push_notifier_singleton = SimplePushNotifier(subs_repo, user_repo)
    return _push_notifier_singleton
