from __future__ import annotations

"""Отправка сообщений в Telegram.

Используем обычный HTTP POST к Bot API. Для простоты и отсутствия
доп зависимости берём httpx (уже в зависимостях). Если токена или chat id
нет — функция молча возвращает False.
"""

import httpx
import asyncio
from ..config import get_settings
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from ..db.models import TelegramLinks


async def _post_message(token: str, chat_id: str, text: str) -> bool:
    import httpx
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {"chat_id": chat_id, "text": text[:4000]}
    timeout = httpx.Timeout(10.0, connect=5.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(url, data=payload)
            return r.status_code == 200
    except Exception:
        return False


async def send_message(text: str, chat_ids: list[str] | None = None, session: AsyncSession | None = None) -> bool:
    """Отправка сообщения.

    Приоритет:
      1. Если передан список chat_ids — отправляем каждому.
      2. Иначе, если есть связанные confirmed chat_id в БД (session обязателен) — отправляем всем уникальным.
      3. Иначе fallback к глобальному TELEGRAM_CHAT_ID.
    Возвращает True если удалось хотя бы в один чат.
    """
    settings = get_settings()
    if not settings.TELEGRAM_BOT_TOKEN:
        return False
    token = settings.TELEGRAM_BOT_TOKEN

    targets: list[str] = []
    if chat_ids:
        targets = chat_ids
    elif session is not None:
        q = select(TelegramLinks.chat_id).where(TelegramLinks.status == 'confirmed', TelegramLinks.chat_id.is_not(None))
        res = await session.execute(q)
        targets = [c for (c,) in res.all() if c]
    if not targets and settings.TELEGRAM_CHAT_ID:
        targets = [settings.TELEGRAM_CHAT_ID]
    if not targets:
        return False
    success_any = False
    for cid in set(targets):
        ok = await _post_message(token, cid, text)
        success_any = success_any or ok
    return success_any


# Синхронный helper (если где-то нужен) — не используем в async коде.
def send_message_sync(text: str) -> bool:  # pragma: no cover - вспомогательная
    return asyncio.run(send_message(text))
