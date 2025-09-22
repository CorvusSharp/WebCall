from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ....infrastructure.services.telegram_link import (
    create_or_refresh_link, confirm_link, get_confirmed_chat_id
)
from ....infrastructure.db.session import get_db_session
from ....infrastructure.config import settings
from ..deps.auth import get_current_user

router = APIRouter(prefix="/telegram", tags=["telegram"])


class LinkCreateOut(BaseModel):
    token: str
    deeplink: str
    expires_at: str


@router.post("/link", response_model=LinkCreateOut)
async def create_link(session: AsyncSession = Depends(get_db_session), current_user=Depends(get_current_user)):
    link = await create_or_refresh_link(session, current_user.id)
    await session.commit()
    bot_name = settings.TELEGRAM_BOT_NAME or ""
    # Формат deep-link: https://t.me/<bot>?start=<token>
    deeplink = f"https://t.me/{bot_name}?start={link.token}" if bot_name else link.token
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
