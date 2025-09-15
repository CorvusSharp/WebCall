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
from ....infrastructure.services.webpush import WebPushSender, WebPushMessage
from ....infrastructure.config import get_settings


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
    room_id: UUID


async def _send_pushes(current, body: CallNotifyIn, users: UserRepository, repo: PushSubscriptionRepository):
    target = await users.get_by_id(body.to_user_id)
    if not target:
        return 0
    subs = await repo.list_by_user(target.id)
    if not subs:
        return 0
    settings = get_settings()
    sender = WebPushSender(vapid_public=settings.VAPID_PUBLIC_KEY, vapid_private=settings.VAPID_PRIVATE_KEY, subject=settings.VAPID_SUBJECT)
    sent = 0
    for s in subs:
        msg = WebPushMessage(
            title="Входящий звонок",
            body=f"{current.username} хочет поговорить",
            icon=None,
            data={"room_id": str(body.room_id), "from": str(current.id), "from_name": current.username},
        )
        # простейший retry 2 раза на 5xx/429
        attempts = 0
        while attempts < 3:
            attempts += 1
            try:
                await sender.send(s.endpoint, s.p256dh, s.auth, msg)
                sent += 1
                break
            except Exception as e:
                text = str(e)
                if any(code in text for code in ("410", "404")):
                    # удаляем невалидную подписку
                    await repo.remove(target.id, s.endpoint)
                    break
                if any(code in text for code in ("429", "500", "502", "503")) and attempts < 3:
                    continue
                break
    return sent


@router.post("/notify-call")
async def notify_call(body: CallNotifyIn, background: BackgroundTasks, current=Depends(get_current_user), users: UserRepository = Depends(get_user_repo), repo: PushSubscriptionRepository = Depends(get_push_repo)):
    if body.to_user_id == current.id:
        raise HTTPException(status_code=400, detail="Cannot notify yourself")
    # отправим в фоне
    background.add_task(_send_pushes, current, body, users, repo)
    return {"ok": True, "scheduled": True}
