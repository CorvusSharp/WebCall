from __future__ import annotations

from typing import List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from ....core.domain.models import DirectMessage, FriendStatus
from ....core.ports.repositories import FriendshipRepository, DirectMessageRepository, UserRepository
from ..deps.auth import get_current_user
from ..deps.containers import get_db_session
from ....infrastructure.db.repositories.friends import PgFriendshipRepository
from ....infrastructure.db.repositories.direct_messages import PgDirectMessageRepository
from ....infrastructure.services.direct_crypto import encrypt_direct, decrypt_direct
from ...ws.friends import publish_direct_message, publish_direct_cleared

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


@router.get('/{friend_id}/messages', response_model=List[DirectMessageOut])
async def list_direct_messages(friend_id: UUID, current=Depends(get_current_user), frepo: FriendshipRepository = Depends(get_friend_repo), dms: DirectMessageRepository = Depends(get_dm_repo)):
    f = await frepo.get_pair(current.id, friend_id)
    if not f or f.status != FriendStatus.accepted:
        raise HTTPException(status_code=404, detail='Not friends')
    rows = await dms.list_pair(current.id, friend_id, limit=100)
    # Возвращаем в прямом порядке по времени (старые -> новые)
    rows = list(reversed(rows))
    result: list[DirectMessageOut] = []
    for dm in rows:
        # Определяем кому адресовано сообщение
        to_user = friend_id if dm.sender_id == current.id else current.id
        try:
            plaintext = decrypt_direct(current.id, friend_id, dm.ciphertext)
        except Exception:
            plaintext = '(decrypt error)'
        result.append(DirectMessageOut(id=dm.id, from_user_id=dm.sender_id, to_user_id=to_user, content=plaintext, sent_at=dm.sent_at.isoformat()))
    return result


@router.post('/{friend_id}/messages', response_model=DirectMessageOut, status_code=201)
async def post_direct_message(friend_id: UUID, body: DirectMessageIn, current=Depends(get_current_user), frepo: FriendshipRepository = Depends(get_friend_repo), dms: DirectMessageRepository = Depends(get_dm_repo)):
    f = await frepo.get_pair(current.id, friend_id)
    if not f or f.status != FriendStatus.accepted:
        raise HTTPException(status_code=404, detail='Not friends')
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail='Empty content')
    # Шифруем
    ciphertext = encrypt_direct(current.id, friend_id, content)
    dm = DirectMessage.create(current.id, friend_id, current.id, ciphertext)
    await dms.add(dm)
    # Публикация события обеим сторонам (plaintext)
    try:
        await publish_direct_message(current.id, friend_id, dm.id, content, dm.sent_at)
    except Exception:
        pass
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
