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
    # Используем timezone-aware UTC значения последовательно, чтобы избежать ошибок сравнения
    now = datetime.now(timezone.utc)
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
    # Приводим текущее время к timezone-aware UTC (с tzinfo=UTC)
    now = datetime.now(timezone.utc)
    q = select(TelegramLinks).where(TelegramLinks.token == token)
    res = await session.execute(q)
    link: Optional[TelegramLinks] = res.scalars().first()
    if not link:
        return False
    if link.status != 'pending':
        return False
    # link.expires_at может быть сохранён как naive (если создан до фикса). Приведём к UTC-aware.
    expires_at = link.expires_at
    if expires_at is not None and expires_at.tzinfo is None:
        # трактуем naive как UTC
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at and expires_at < now:
        # истёк
        link.status = 'expired'
        return False
    link.chat_id = chat_id
    link.status = 'confirmed'
    # Для согласованности confirmed_at тоже timezone-aware UTC
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
