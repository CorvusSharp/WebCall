from __future__ import annotations

from typing import List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel

from ....core.domain.models import PushSubscription
from ....core.ports.repositories import PushSubscriptionRepository, UserRepository
from ..deps.auth import get_current_user
from ..deps.containers import get_db_session
from ....infrastructure.db.repositories.push_subs import PgPushSubscriptionRepository
from ....infrastructure.db.repositories.users import PgUserRepository
from ....infrastructure.services.webpush import WebPushMessage  # noqa: F401 (оставлено для совместимости типов)
from ....infrastructure.config import get_settings  # noqa: F401 (может быть использован где-то ещё)
from ...ws.friends import publish_call_accept, publish_call_decline, publish_call_cancel  # noqa: F401 (совместимость старого кода)
from ..deps.containers import get_push_notifier, get_call_invite_service
from ....core.ports.services import PushNotifier, CallInviteService


router = APIRouter(prefix="/api/v1/push", tags=["push"])


class SubscribeIn(BaseModel):
    endpoint: str
    keys: dict


async def get_push_repo(session=Depends(get_db_session)) -> PushSubscriptionRepository:
    return PgPushSubscriptionRepository(session)


async def get_user_repo(session=Depends(get_db_session)) -> UserRepository:
    return PgUserRepository(session)


@router.post("/subscribe")
async def subscribe(body: SubscribeIn, current=Depends(get_current_user), repo: PushSubscriptionRepository = Depends(get_push_repo)):
    p256dh = body.keys.get("p256dh")
    auth = body.keys.get("auth")
    if not (p256dh and auth):
        raise HTTPException(status_code=400, detail="Invalid keys")
    sub = PushSubscription.create(current.id, body.endpoint, p256dh, auth)
    await repo.add(sub)
    return {"ok": True}


@router.post("/unsubscribe")
async def unsubscribe(body: SubscribeIn, current=Depends(get_current_user), repo: PushSubscriptionRepository = Depends(get_push_repo)):
    await repo.remove(current.id, body.endpoint)
    return {"ok": True}


@router.get("/vapid-public")
async def get_vapid_public():
    s = get_settings()
    return {"key": s.VAPID_PUBLIC_KEY}


class CallNotifyIn(BaseModel):
    to_user_id: UUID
    # Принимаем строковый room_id, чтобы поддерживать простые идентификаторы (например, "3")
    room_id: str


class CallActionIn(BaseModel):
    other_user_id: UUID
    room_id: str


"""Refactored: `_send_pushes` заменён PushNotifier сервисом (SimplePushNotifier).
Оставлено место чтобы избежать конфликтов с импортами при горячей перезагрузке.
"""


@router.post("/notify-call")
async def notify_call(
    body: CallNotifyIn,
    background: BackgroundTasks,
    current=Depends(get_current_user),
    call_invites: CallInviteService = Depends(get_call_invite_service),  # type: ignore[arg-type]
    push_notifier: PushNotifier = Depends(get_push_notifier),  # type: ignore[arg-type]
):
    if body.to_user_id == current.id:
        raise HTTPException(status_code=400, detail="Cannot notify yourself")
    # Вызов бизнес-сервиса приглашения (инкапсулирует хранение pending + ws публикацию)
    await call_invites.invite(current.id, body.to_user_id, body.room_id, current.username, str(current.email))
    # Push отправляем асинхронно (не блокируем ответ)
    background.add_task(push_notifier.notify_incoming_call, body.to_user_id, current.id, current.username, body.room_id)
    return {"ok": True, "scheduled": True, "room_id": body.room_id}


@router.post("/call/accept")
async def accept_call(body: CallActionIn, current=Depends(get_current_user), call_invites: CallInviteService = Depends(get_call_invite_service)):
    await call_invites.accept(current.id, body.other_user_id, body.room_id)
    return {"ok": True}


@router.post("/call/decline")
async def decline_call(body: CallActionIn, current=Depends(get_current_user), call_invites: CallInviteService = Depends(get_call_invite_service)):
    await call_invites.decline(current.id, body.other_user_id, body.room_id)
    return {"ok": True}


@router.post("/call/cancel")
async def cancel_call(body: CallActionIn, current=Depends(get_current_user), call_invites: CallInviteService = Depends(get_call_invite_service)):
    """Отмена исходящего звонка инициатором до принятия.

    Семантически отличается от decline (который делает принимающая сторона).
    """
    await call_invites.cancel(current.id, body.other_user_id, body.room_id)
    return {"ok": True}
