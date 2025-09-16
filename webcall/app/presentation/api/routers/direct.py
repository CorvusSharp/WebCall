from __future__ import annotations

from typing import List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from pydantic import BaseModel

from ....core.domain.models import DirectMessage, FriendStatus
from ....core.ports.repositories import FriendshipRepository, DirectMessageRepository, UserRepository, DirectReadStateRepository, PushSubscriptionRepository
from ..deps.auth import get_current_user
from ..deps.containers import get_db_session
from ....infrastructure.db.repositories.friends import PgFriendshipRepository
from ....infrastructure.db.repositories.direct_messages import PgDirectMessageRepository
from ....infrastructure.db.repositories.direct_reads import PgDirectReadStateRepository
from ....infrastructure.db.repositories.push_subs import PgPushSubscriptionRepository
from ....infrastructure.db.repositories.users import PgUserRepository
from ..deps.containers import get_user_repo
from ....infrastructure.db.session import get_session
from ....infrastructure.services.webpush import WebPushSender, WebPushMessage
from ....infrastructure.config import get_settings
from ...ws.friends import publish_direct_message, publish_direct_cleared
from ....infrastructure.db.repositories.users import PgUserRepository
from ....infrastructure.services.direct_crypto import decrypt_direct

router = APIRouter(prefix='/api/v1/direct', tags=['direct'])


class DirectMessageIn(BaseModel):
    content: str


class DirectMessageOut(BaseModel):
    id: UUID
    from_user_id: UUID
    to_user_id: UUID
    content: str
    sent_at: str


async def get_friend_repo(session=Depends(get_db_session)) -> FriendshipRepository:
    return PgFriendshipRepository(session)


async def get_dm_repo(session=Depends(get_db_session)) -> DirectMessageRepository:
    return PgDirectMessageRepository(session)


async def get_read_repo(session=Depends(get_db_session)) -> DirectReadStateRepository:
    return PgDirectReadStateRepository(session)


class PublicKeyIn(BaseModel):
    public_key: str


@router.post('/me/public_key')
async def set_my_public_key(body: PublicKeyIn, current=Depends(get_current_user), users: PgUserRepository = Depends(get_user_repo)):
    await users.set_public_key(current.id, body.public_key)
    return {"ok": True}


@router.get('/{friend_id}/public_key')
async def get_friend_public_key(friend_id: UUID, users: PgUserRepository = Depends(get_user_repo)):
    u = await users.get_by_id(friend_id)
    if not u:
        raise HTTPException(status_code=404, detail='Not found')
    return {"public_key": u.public_key}


@router.get('/{friend_id}/messages', response_model=List[DirectMessageOut])
async def list_direct_messages(friend_id: UUID, current=Depends(get_current_user), frepo: FriendshipRepository = Depends(get_friend_repo), dms: DirectMessageRepository = Depends(get_dm_repo)):
    f = await frepo.get_pair(current.id, friend_id)
    if not f or f.status != FriendStatus.accepted:
        raise HTTPException(status_code=404, detail='Not friends')
    rows = await dms.list_pair(current.id, friend_id, limit=100)
    # Возвращаем в прямом порядке по времени (старые -> новые)
    rows = list(reversed(rows))
    result: list[DirectMessageOut] = []
    # Возвращаем ciphertext; клиенты должны расшифровывать локально
    for dm in rows:
        to_user = friend_id if dm.sender_id == current.id else current.id
        # Попробуем расшифровать на сервере для участника переписки.
        # Расшифровка выполняется только когда текущий пользователь является участником пары (т.е. он здесь),
        # и ключ выводим по паре id — поэтому обе стороны смогут получить plaintext.
        content = dm.ciphertext
        try:
            # decrypt_direct ожидает a, b как UUID (порядок внутри функции нормализуется)
            content = decrypt_direct(dm.user_a_id, dm.user_b_id, dm.ciphertext)
        except Exception:
            # Если расшифровка не удалась (повреждённый ciphertext или ключи не совпадают),
            # возвращаем оригинальный ciphertext — клиент попытается расшифровать локально.
            content = dm.ciphertext
        result.append(DirectMessageOut(id=dm.id, from_user_id=dm.sender_id, to_user_id=to_user, content=content, sent_at=dm.sent_at.isoformat()))
    return result


class ReadAckIn(BaseModel):
    at: str | None = None  # ISO8601; если не задано — использовать текущее время на сервере


@router.post('/{friend_id}/read-ack')
async def mark_direct_read(friend_id: UUID, body: ReadAckIn | None = None, current=Depends(get_current_user), frepo: FriendshipRepository = Depends(get_friend_repo), reads: DirectReadStateRepository = Depends(get_read_repo)):
    f = await frepo.get_pair(current.id, friend_id)
    if not f or f.status != FriendStatus.accepted:
        raise HTTPException(status_code=404, detail='Not friends')
    from datetime import datetime
    when = None
    try:
        if body and body.at:
            when = datetime.fromisoformat(body.at)
    except Exception:
        when = None
    if when is None:
        when = datetime.utcnow()
    await reads.set_last_read(current.id, friend_id, when)
    return {"ok": True}


@router.post('/{friend_id}/messages', response_model=DirectMessageOut, status_code=201)
async def post_direct_message(friend_id: UUID, body: DirectMessageIn, background: BackgroundTasks, current=Depends(get_current_user), frepo: FriendshipRepository = Depends(get_friend_repo), dms: DirectMessageRepository = Depends(get_dm_repo), reads: DirectReadStateRepository = Depends(get_read_repo), push_repo: PushSubscriptionRepository = Depends(lambda session=Depends(get_db_session): PgPushSubscriptionRepository(session)), users: UserRepository = Depends(get_current_user.__wrapped__ if hasattr(get_current_user, '__wrapped__') else get_current_user)):
    f = await frepo.get_pair(current.id, friend_id)
    if not f or f.status != FriendStatus.accepted:
        raise HTTPException(status_code=404, detail='Not friends')
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail='Empty content')
    # Ожидаем, что клиент уже прислал ciphertext (E2EE): сохраняем как есть
    ciphertext = content  # сервер принимает ciphertext
    dm = DirectMessage.create(current.id, friend_id, current.id, ciphertext)
    await dms.add(dm)
    # Публикация события обеим сторонам (ciphertext)
    try:
        await publish_direct_message(current.id, friend_id, dm.id, ciphertext, dm.sent_at)
    except Exception:
        pass
    # Мгновенное пуш-уведомление получателю (не дожидаясь 10 минут)
    async def _instant_push(sender_id: UUID, to_id: UUID, ciphertext: str):
        settings = get_settings()
        if not (settings.VAPID_PUBLIC_KEY and settings.VAPID_PRIVATE_KEY and settings.VAPID_SUBJECT):
            return
        async with get_session() as session:
            push_repo_local = PgPushSubscriptionRepository(session)
            user_repo_local = PgUserRepository(session)
            subs = await push_repo_local.list_by_user(to_id)
            if not subs:
                return
            sender_user = await user_repo_local.get_by_id(sender_id)
            sender_name = sender_user.username if sender_user else "пользователь"
            push_sender = WebPushSender(
                vapid_public=settings.VAPID_PUBLIC_KEY,
                vapid_private=settings.VAPID_PRIVATE_KEY,
                subject=settings.VAPID_SUBJECT,
            )
            title = "Новое сообщение"
            body_text = f"Вам новое сообщение"  # avoid including plaintext in push
            for s in subs:
                try:
                    await push_sender.send(
                        s.endpoint,
                        s.p256dh,
                        s.auth,
                        WebPushMessage(title=title, body=body_text, data={"type": "direct", "from": str(sender_id)}),
                    )
                except Exception:
                    pass
    background.add_task(_instant_push, current.id, friend_id, ciphertext)
    # Планируем отложенное пуш-уведомление через 10 минут, если получатель не прочитал
    async def _delayed_push_if_unread(sender_id: UUID, to_id: UUID, sent_at_iso: str):
        # Ждём 10 минут, затем проверяем, прочитано ли сообщение (по last_read)
        import asyncio
        from datetime import datetime
        await asyncio.sleep(600)
        # Настройки push
        settings = get_settings()
        if not (settings.VAPID_PUBLIC_KEY and settings.VAPID_PRIVATE_KEY and settings.VAPID_SUBJECT):
            return
        # Парсим время отправки сообщения
        try:
            sent_at = datetime.fromisoformat(sent_at_iso)
        except Exception:
            return
        # Открываем новую БД-сессию и переиспользуем репозитории
        async with get_session() as session:
            reads_repo = PgDirectReadStateRepository(session)
            push_repo_local = PgPushSubscriptionRepository(session)
            user_repo_local = PgUserRepository(session)
            try:
                last_read = await reads_repo.get_last_read(to_id, sender_id)
            except Exception:
                last_read = None
            # Если прочитано (last_read >= sent_at) — пуш не нужен
            if last_read is not None and last_read >= sent_at:
                return
            # Готовим данные уведомления
            sender_user = await user_repo_local.get_by_id(sender_id)
            sender_name = sender_user.username if sender_user else "пользователь"
            subs = await push_repo_local.list_by_user(to_id)
            if not subs:
                return
            push_sender = WebPushSender(
                vapid_public=settings.VAPID_PUBLIC_KEY,
                vapid_private=settings.VAPID_PRIVATE_KEY,
                subject=settings.VAPID_SUBJECT,
            )
            title = "Новое сообщение"
            body_text = f"Вам новое сообщение"  # do not include message body
            for s in subs:
                try:
                    await push_sender.send(
                        s.endpoint,
                        s.p256dh,
                        s.auth,
                        WebPushMessage(title=title, body=body_text, data={"type": "direct", "from": str(sender_id)}),
                    )
                except Exception:
                    # игнорируем ошибки доставки
                    pass

    background.add_task(_delayed_push_if_unread, current.id, friend_id, dm.sent_at.isoformat())
    return DirectMessageOut(id=dm.id, from_user_id=current.id, to_user_id=friend_id, content=content, sent_at=dm.sent_at.isoformat())


class DirectDeleteResult(BaseModel):
    removed: int


@router.delete('/{friend_id}/messages', response_model=DirectDeleteResult)
async def delete_direct_messages(friend_id: UUID, current=Depends(get_current_user), frepo: FriendshipRepository = Depends(get_friend_repo), dms: DirectMessageRepository = Depends(get_dm_repo)):
    f = await frepo.get_pair(current.id, friend_id)
    if not f or f.status != FriendStatus.accepted:
        raise HTTPException(status_code=404, detail='Not friends')
    removed = await dms.delete_pair(current.id, friend_id)
    try:
        await publish_direct_cleared(current.id, friend_id)
    except Exception:
        pass
    return DirectDeleteResult(removed=removed)
