from __future__ import annotations
"""Вспомогательные функции Telegram интеграции."""
from typing import Sequence, Dict
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from ..db.models import TelegramLinks

async def get_active_chat_ids(session: AsyncSession, user_ids: Sequence[str]) -> Dict[str, str]:
    if not user_ids:
        return {}
    q = (
        select(TelegramLinks.user_id, TelegramLinks.chat_id)
        .where(
            TelegramLinks.user_id.in_(list(user_ids)),  # type: ignore[arg-type]
            TelegramLinks.status == 'confirmed',
            TelegramLinks.chat_id.is_not(None)
        )
    )
    res = await session.execute(q)
    out: Dict[str, str] = {}
    for uid, cid in res.all():  # type: ignore[misc]
        if cid:
            out[str(uid)] = cid
    return out
