from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update

from ..db.models import TelegramLinks

TOKEN_TTL_MINUTES = 10


async def create_or_refresh_link(session: AsyncSession, user_id) -> TelegramLinks:
    """Создаёт новый pending token (инвалидируя предыдущие pending токены пользователя)."""
    # истекают старые pending
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    token = secrets.token_urlsafe(24)[:64]
    expires_at = now + timedelta(minutes=TOKEN_TTL_MINUTES)
    # Можно просто вставить новую запись (первичный ключ составной user_id+token)
    link = TelegramLinks(
        user_id=user_id,
        token=token,
        chat_id=None,
        status='pending',
        created_at=now,
        confirmed_at=None,
        expires_at=expires_at,
    )
    session.add(link)
    return link


async def confirm_link(session: AsyncSession, token: str, chat_id: str) -> bool:
    now = datetime.utcnow()
    q = select(TelegramLinks).where(TelegramLinks.token == token)
    res = await session.execute(q)
    link: Optional[TelegramLinks] = res.scalars().first()
    if not link:
        return False
    if link.status != 'pending':
        return False
    if link.expires_at and link.expires_at < now:
        # истёк
        link.status = 'expired'
        return False
    link.chat_id = chat_id
    link.status = 'confirmed'
    link.confirmed_at = now
    return True


async def get_confirmed_chat_id(session: AsyncSession, user_id) -> Optional[str]:
    q = (
        select(TelegramLinks.chat_id)
        .where(TelegramLinks.user_id == user_id, TelegramLinks.status == 'confirmed')
        .order_by(TelegramLinks.confirmed_at.desc())
        .limit(1)
    )
    res = await session.execute(q)
    return res.scalar_one_or_none()
