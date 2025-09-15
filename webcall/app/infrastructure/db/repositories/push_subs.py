from __future__ import annotations

from typing import List
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.domain.models import PushSubscription
from ....core.ports.repositories import PushSubscriptionRepository
from ..models import PushSubscriptions


class PgPushSubscriptionRepository(PushSubscriptionRepository):
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def add(self, sub: PushSubscription) -> None:  # type: ignore[override]
        self.session.add(
            PushSubscriptions(
                id=sub.id,
                user_id=sub.user_id,
                endpoint=sub.endpoint,
                p256dh=sub.p256dh,
                auth=sub.auth,
                created_at=sub.created_at,
            )
        )
        try:
            await self.session.commit()
        except Exception:
            await self.session.rollback()
            # try upsert-like: remove existing and add again
            await self.session.execute(
                delete(PushSubscriptions).where(
                    (PushSubscriptions.user_id == sub.user_id) & (PushSubscriptions.endpoint == sub.endpoint)
                )
            )
            self.session.add(
                PushSubscriptions(
                    id=sub.id,
                    user_id=sub.user_id,
                    endpoint=sub.endpoint,
                    p256dh=sub.p256dh,
                    auth=sub.auth,
                    created_at=sub.created_at,
                )
            )
            await self.session.commit()

    async def remove(self, user_id: UUID, endpoint: str) -> None:  # type: ignore[override]
        await self.session.execute(
            delete(PushSubscriptions).where(
                (PushSubscriptions.user_id == user_id) & (PushSubscriptions.endpoint == endpoint)
            )
        )
        await self.session.commit()

    async def list_by_user(self, user_id: UUID) -> List[PushSubscription]:  # type: ignore[override]
        res = await self.session.execute(select(PushSubscriptions).where(PushSubscriptions.user_id == user_id))
        rows = res.scalars().all()
        return [
            PushSubscription(id=r.id, user_id=r.user_id, endpoint=r.endpoint, p256dh=r.p256dh, auth=r.auth, created_at=r.created_at)
            for r in rows
        ]
