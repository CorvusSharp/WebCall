from __future__ import annotations

from typing import List
from uuid import UUID

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
import logging

logger = logging.getLogger(__name__)
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.domain.models import PushSubscription
from ....core.ports.repositories import PushSubscriptionRepository
from ..models import PushSubscriptions


class PgPushSubscriptionRepository(PushSubscriptionRepository):
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def add(self, sub: PushSubscription) -> None:  # type: ignore[override]
        """Атомарная регистрация push-подписки.

        Используем PostgreSQL ON CONFLICT для устранения гонок при
        одновременных (или повторных) подписках одного и того же endpoint.

        Поведение: если (user_id, endpoint) уже существует, обновляем ключи.
        Замечание: поле created_at перезаписывается – трактуем его как
        'момент актуализации'. Если важно сохранять первоначальный момент,
        нужно завести отдельное поле updated_at (не делаем сейчас, чтобы не
        добавлять миграцию в рамках быстрого фикса)."""

        stmt = (
            pg_insert(PushSubscriptions)
            .values(
                id=sub.id,
                user_id=sub.user_id,
                endpoint=sub.endpoint,
                p256dh=sub.p256dh,
                auth=sub.auth,
                created_at=sub.created_at,
            )
            .on_conflict_do_update(
                index_elements=[PushSubscriptions.user_id, PushSubscriptions.endpoint],
                set_
                ={
                    "p256dh": sub.p256dh,
                    "auth": sub.auth,
                    "created_at": sub.created_at,
                },
            )
        )
        result = await self.session.execute(stmt)
        await self.session.commit()
        # rowcount == 1 всегда, но можем логировать сам факт upsert.
        # Для более тонкого различения вставка/обновление нужен триггер или
        # добавление столбца updated_at. Здесь достаточно отладочного сообщения.
        logger.debug(
            "push_subscriptions upsert: user_id=%s endpoint_hash=%s", sub.user_id, hash(sub.endpoint)
        )

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
