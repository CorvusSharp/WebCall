from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ....infrastructure.services.telegram_link import (
    create_or_refresh_link, confirm_link, get_confirmed_chat_id
)
from ....infrastructure.db.session import get_db_session
from ....infrastructure.config import get_settings
from ..deps.auth import get_current_user

settings = get_settings()
api_prefix = settings.API_PREFIX.rstrip('/')  # ожидаемо /api/v1
router = APIRouter(prefix=f"{api_prefix}/telegram", tags=["telegram"])


class LinkCreateOut(BaseModel):
    token: str
    deeplink: str
    expires_at: str


@router.post("/link", response_model=LinkCreateOut)
async def create_link(session: AsyncSession = Depends(get_db_session), current_user=Depends(get_current_user)):
    bot_name = (settings.TELEGRAM_BOT_NAME or "").strip()
    if not bot_name:
        raise HTTPException(status_code=500, detail="TELEGRAM_BOT_NAME is not configured on server")
    if bot_name.startswith("@"):
        raise HTTPException(status_code=400, detail="TELEGRAM_BOT_NAME must be provided without '@'")
    link = await create_or_refresh_link(session, current_user.id)
    await session.commit()
    deeplink = f"https://t.me/{bot_name}?start={link.token}"
    return LinkCreateOut(token=link.token, deeplink=deeplink, expires_at=link.expires_at.isoformat())


class LinkStatusOut(BaseModel):
    status: str
    chat_id: str | None = None


@router.get("/status", response_model=LinkStatusOut)
async def status(session: AsyncSession = Depends(get_db_session), current_user=Depends(get_current_user)):
    chat_id = await get_confirmed_chat_id(session, current_user.id)
    if chat_id:
        return LinkStatusOut(status="confirmed", chat_id=chat_id)
    return LinkStatusOut(status="absent", chat_id=None)


class WebhookIn(BaseModel):
    update_id: int | None = None
    message: dict | None = None


@router.post("/webhook")
async def webhook(data: WebhookIn, session: AsyncSession = Depends(get_db_session)):
    # Примитивный webhook: ожидаем message.text вида '/start <token>'
    if not data.message:
        return {"ok": True}
    msg = data.message
    text = (msg.get("text") or "").strip()
    chat = msg.get("chat") or {}
    chat_id = str(chat.get("id")) if chat.get("id") is not None else None
    if text.startswith("/start ") and chat_id:
        token = text.split(maxsplit=1)[1]
        ok = await confirm_link(session, token, chat_id)
        if ok:
            await session.commit()
            return {"ok": True, "linked": True}
    return {"ok": True}


@router.get("/selftest")
async def telegram_selftest():
    """Проверка доступности Bot API и соответствия username.

    Возвращает краткий JSON; не делает побочных эффектов.
    """
    import httpx
    bot_token = settings.TELEGRAM_BOT_TOKEN
    bot_name = settings.TELEGRAM_BOT_NAME
    if not bot_token:
        raise HTTPException(500, detail="TELEGRAM_BOT_TOKEN not set")
    url = f"https://api.telegram.org/bot{bot_token}/getMe"
    try:
        r = httpx.get(url, timeout=10)
    except Exception as e:
        raise HTTPException(502, detail=f"Network error: {e.__class__.__name__}") from e
    try:
        data = r.json()
    except Exception:
        raise HTTPException(500, detail=f"Non-JSON response status={r.status_code}")
    if not data.get("ok"):
        return {"ok": False, "error": data}
    api_username = data.get("result", {}).get("username")
    return {
        "ok": True,
        "api_username": api_username,
        "configured_name": bot_name,
        "match": (api_username or "").lower() == (bot_name or "").lower(),
    }
