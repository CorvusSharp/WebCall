from __future__ import annotations

"""Отправка сообщений в Telegram.

Используем обычный HTTP POST к Bot API. Для простоты и отсутствия
доп зависимости берём httpx (уже в зависимостях). Если токена или chat id
нет — функция молча возвращает False.
"""

import httpx
import asyncio
from ..config import get_settings


async def send_message(text: str) -> bool:
    settings = get_settings()
    if not settings.TELEGRAM_BOT_TOKEN or not settings.TELEGRAM_CHAT_ID:
        return False
    token = settings.TELEGRAM_BOT_TOKEN
    chat_id = settings.TELEGRAM_CHAT_ID
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {"chat_id": chat_id, "text": text[:4000]}  # ограничим размер
    timeout = httpx.Timeout(10.0, connect=5.0)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.post(url, data=payload)
            return r.status_code == 200
    except Exception:  # pragma: no cover
        return False


# Синхронный helper (если где-то нужен) — не используем в async коде.
def send_message_sync(text: str) -> bool:  # pragma: no cover - вспомогательная
    return asyncio.run(send_message(text))
