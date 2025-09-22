from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
import logging
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from ....infrastructure.services.telegram_link import (
    create_or_refresh_link, confirm_link, get_confirmed_chat_id, revoke_user_links
)
from sqlalchemy.exc import IntegrityError
from ....infrastructure.db.session import get_db_session
from ....infrastructure.config import get_settings
from ..deps.auth import get_current_user

settings = get_settings()
api_prefix = settings.API_PREFIX.rstrip('/')  # ожидаемо /api/v1
router = APIRouter(prefix=f"{api_prefix}/telegram", tags=["telegram"])
log = logging.getLogger("telegram")
_LAST_UPDATE: dict | None = None  # хранение последнего сырого апдейта для отладки


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
    # Если нет confirmed — проверим есть ли вообще какие-либо revoked чтобы различать полностью отсутствующее.
    # (Опционально можно вернуть 'absent'). Пока просто absent.
    return LinkStatusOut(status="absent", chat_id=None)


class LinkRevokeOut(BaseModel):
    revoked: int
    status: str


@router.delete("/link", response_model=LinkRevokeOut)
async def revoke_link(session: AsyncSession = Depends(get_db_session), current_user=Depends(get_current_user)):
    updated = await revoke_user_links(session, current_user.id)
    await session.commit()
    # После revoke confirmed chat_id недоступен
    return LinkRevokeOut(revoked=updated, status="absent")


class WebhookIn(BaseModel):
    update_id: int | None = None
    message: dict | None = None


@router.post("/webhook")
async def webhook(data: WebhookIn, session: AsyncSession = Depends(get_db_session)):
    """Обработка входящего Telegram update.

    Требования к надёжности:
      * Никогда не даём 500 Telegram (иначе ретраи и рост pending_update_count).
      * Логируем сырые данные; при ошибке фиксируем traceback.
      * Устраняем конфликт уникального индекса (user_id, chat_id) как нормальный кейс пере-привязки.
    """
    global _LAST_UPDATE
    try:
        raw = data.model_dump()
        _LAST_UPDATE = raw
        log.info("TG webhook update: %s", raw)
    except Exception:  # pragma: no cover
        log.exception("Failed to log incoming update")
    try:
        if not data.message:
            return {"ok": True}
        msg = data.message
        text = (msg.get("text") or "").strip()
        chat = msg.get("chat") or {}
        chat_id = str(chat.get("id")) if chat.get("id") is not None else None
        # Парсим токен из /start
        token_candidate = None
        if text.startswith("/start "):
            token_candidate = text.split(maxsplit=1)[1]
        elif text.startswith("/start") and len(text) > 6:
            token_candidate = text[6:].strip()
        # Примитивный guard длины токена (ожидаем 10..80 символов)
        if token_candidate and not (10 <= len(token_candidate) <= 80):
            log.warning("Token candidate length out of expected range len=%s", len(token_candidate))
            token_candidate = None
        if token_candidate and chat_id:
            log.info("Attempt confirm token=%s chat_id=%s", token_candidate, chat_id)
            ok = await confirm_link(session, token_candidate, chat_id)
            if ok:
                try:
                    await session.commit()
                except IntegrityError as ie:
                    # Возможный дубликат уникального индекса (user_id, chat_id) при повторной привязке
                    await session.rollback()
                    log.info("IntegrityError on commit (likely duplicate chat). Treat as success: %s", ie.__class__.__name__)
                    return {"ok": True, "linked": True, "dup": True}
                # Отправляем подтверждающее сообщение (не критично при ошибке)
                from ....infrastructure.services.telegram import send_message  # локальный импорт
                try:
                    await send_message("Привязка Telegram успешна. Теперь вы будете получать AI summary.", chat_ids=[chat_id])
                except Exception as e:  # pragma: no cover
                    log.warning("Failed to send confirmation message chat_id=%s err=%s", chat_id, e.__class__.__name__)
                return {"ok": True, "linked": True}
        return {"ok": True}
    except Exception as e:  # pragma: no cover
        # Логируем подробно и возвращаем 200 чтобы Telegram не ретраил до бесконечности
        log.exception("Unhandled error in webhook: %s", e)
        try:
            await session.rollback()
        except Exception:
            pass
        return {"ok": True, "error": "internal", "logged": True}


@router.get("/last_update")
async def last_update():  # pragma: no cover - диагностический
    return {"ok": True, "last_update": _LAST_UPDATE}


@router.post("/poll_debug")
async def poll_debug():  # pragma: no cover - диагностический
    """Одноразовый polling getUpdates (если webhook не работает).

    ВНИМАНИЕ: если webhook установлен, getUpdates обычно возвращает пусто.
    Использовать только для диагностики. offset не задаём.
    """
    import httpx
    bot_token = settings.TELEGRAM_BOT_TOKEN
    if not bot_token:
        raise HTTPException(500, detail="TELEGRAM_BOT_TOKEN not set")
    url = f"https://api.telegram.org/bot{bot_token}/getUpdates"
    try:
        r = httpx.get(url, timeout=10)
        data = r.json()
    except Exception as e:  # pragma: no cover
        raise HTTPException(502, detail=f"poll error: {e.__class__.__name__}") from e
    return data


@router.get("/selftest")
async def telegram_selftest():
    """Проверка Bot API: getMe + getWebhookInfo.

    Возвращает JSON с:
      - api_username / configured_name / match
      - webhook_url / has_custom_certificate / pending_update_count / last_error_* (если есть)
    """
    import httpx
    bot_token = settings.TELEGRAM_BOT_TOKEN
    bot_name = settings.TELEGRAM_BOT_NAME
    if not bot_token:
        raise HTTPException(500, detail="TELEGRAM_BOT_TOKEN not set")

    base = f"https://api.telegram.org/bot{bot_token}"
    timeout = httpx.Timeout(10.0, connect=5.0)
    try:
        r_me = httpx.get(f"{base}/getMe", timeout=timeout)
        r_wh = httpx.get(f"{base}/getWebhookInfo", timeout=timeout)
    except Exception as e:
        raise HTTPException(502, detail=f"Network error: {e.__class__.__name__}") from e
    try:
        data_me = r_me.json()
        data_wh = r_wh.json()
    except Exception:
        raise HTTPException(500, detail="Non-JSON response from Telegram")
    if not data_me.get("ok"):
        return {"ok": False, "stage": "getMe", "error": data_me}
    if not data_wh.get("ok"):
        return {"ok": False, "stage": "getWebhookInfo", "error": data_wh}
    api_username = data_me.get("result", {}).get("username")
    wh = data_wh.get("result", {})
    return {
        "ok": True,
        "api_username": api_username,
        "configured_name": bot_name,
        "match": (api_username or "").lower() == (bot_name or "").lower(),
        "webhook_url": wh.get("url"),
        "pending_update_count": wh.get("pending_update_count"),
        "last_error_date": wh.get("last_error_date"),
        "last_error_message": wh.get("last_error_message"),
        "ip_address": wh.get("ip_address"),
        "has_custom_certificate": wh.get("has_custom_certificate"),
    }
