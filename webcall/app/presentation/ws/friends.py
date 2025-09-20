from __future__ import annotations

"""WebSocket канал для событий дружбы, личных сообщений и личных звонков.

Форматы входящих (клиент -> сервер):
 - {"type":"ping"}
 - {"type":"call_end","roomId":str,"toUserId":str,"reason"?:str} (когда завершаем активный звонок)

Форматы исходящих (сервер -> клиент):
 - friend_request / friend_accepted / friend_cancelled / friend_removed
 - direct_message / direct_cleared
 - call_invite / call_accept / call_decline / call_cancel / call_end

Авторизация: JWT в query param `token`. В средах dev,test разрешён guest режим.
Политика: одно активное friends WebSocket соединение на пользователя. Предыдущее закрывается с кодом 4000.
"""

import asyncio
import contextlib
import json
import logging
from typing import Dict, Set
from uuid import UUID

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends

from ...infrastructure.config import get_settings
from ...core.ports.repositories import UserRepository
from ..api.deps.containers import get_user_repo, get_token_provider, get_call_invite_service
from ...core.ports.services import TokenProvider, CallInviteService

router = APIRouter()
logger = logging.getLogger(__name__)

_friend_clients: Dict[UUID, Set[WebSocket]] = {}
_ws_to_user: Dict[WebSocket, UUID] = {}

# Локальный кэш pending (дополнительно к сервису) для обратной совместимости
_pending_calls: Dict[str, dict] = {}

try:  # метрики опциональны
    from prometheus_client import Counter, Gauge
    FRIENDS_WS_ACTIVE = Gauge('ws_active_friends', 'Active friends WS connections')
    CALL_EVENTS = Counter('call_signal_events_total', 'Call signaling events', ['event'])
except Exception:  # pragma: no cover
    FRIENDS_WS_ACTIVE = None
    CALL_EVENTS = None


async def _register(user_id: UUID, ws: WebSocket) -> None:
    existing = _friend_clients.get(user_id)
    if existing:
        for old in list(existing):
            try:
                logger.info("WS_REPLACE user=%s old_ws=%s new_ws=%s", user_id, id(old), id(ws))
                try:
                    await old.close(code=4000)
                except Exception as e:  # pragma: no cover
                    logger.warning("WS_CLOSE_OLD_FAILED user=%s err=%s", user_id, e)
            finally:
                _unregister(old)
    _friend_clients.setdefault(user_id, set()).add(ws)
    _ws_to_user[ws] = user_id
    logger.info("WS_REGISTER user=%s ws=%s active=%s", user_id, id(ws), len(_friend_clients.get(user_id, set())))


def _unregister(ws: WebSocket) -> None:
    uid = _ws_to_user.pop(ws, None)
    if uid is not None:
        s = _friend_clients.get(uid)
        if s and ws in s:
            s.discard(ws)
            if not s:
                _friend_clients.pop(uid, None)
        logger.info("WS_UNREGISTER user=%s ws=%s", uid, id(ws))


async def broadcast_user(user_id: UUID, payload: dict):
    for ws in list(_friend_clients.get(user_id, set())):
        try:
            await ws.send_json(payload)
            try:
                logger.info("WS_SEND user=%s ws=%s type=%s", user_id, id(ws), payload.get('type'))
            except Exception:
                pass
        except Exception as e:  # pragma: no cover
            try:
                logger.warning("WS_SEND_FAIL user=%s ws=%s type=%s err=%s", user_id, id(ws), payload.get('type'), e)
            except Exception:
                pass


async def broadcast_users(user_ids: Set[UUID] | list[UUID], payload: dict):
    for uid in user_ids:
        await broadcast_user(uid, payload)


@router.websocket('/ws/friends')
async def ws_friends(
    websocket: WebSocket,
    tokens: TokenProvider = Depends(get_token_provider),  # type: ignore[arg-type]
    users: UserRepository = Depends(get_user_repo),  # noqa: F841
    call_invites: CallInviteService = Depends(get_call_invite_service),  # type: ignore[arg-type]
):
    settings = get_settings()
    token = websocket.query_params.get('token')
    await websocket.accept()
    allow_unauth = settings.APP_ENV in {'dev', 'test'}
    user_id: UUID | None = None

    if token:
        try:
            payload = tokens.decode_token(token)
            sub = payload.get('sub')
            if sub:
                user_id = UUID(sub)
        except Exception:
            if not allow_unauth:
                await websocket.close(code=4401, reason='Unauthorized')
                return
    else:
        if not allow_unauth:
            await websocket.close(code=4401, reason='Unauthorized')
            return

    if user_id is not None:
        await _register(user_id, websocket)
        if FRIENDS_WS_ACTIVE:
            with contextlib.suppress(Exception):
                FRIENDS_WS_ACTIVE.inc()
        # Ретрансляция ожидающих инвайтов через сервис
        with contextlib.suppress(Exception):
            pending = await call_invites.list_pending_for(user_id)
            for p in pending:
                await websocket.send_json({
                    'type': 'call_invite',
                    'fromUserId': p['fromUserId'],
                    'toUserId': p['toUserId'],
                    'roomId': p['roomId'],
                    'fromUsername': p.get('fromUsername'),
                    'fromEmail': p.get('fromEmail'),
                    'createdAt': p.get('createdAt') or p.get('ts'),
                    'pendingReplay': True,
                })

    try:
        while True:
            try:
                msg = await websocket.receive_text()
            except WebSocketDisconnect:
                break
            except Exception:
                break
            with contextlib.suppress(Exception):
                data = json.loads(msg)
                if isinstance(data, dict):
                    t = data.get('type')
                    if t == 'ping':
                        await websocket.send_json({'type': 'pong'})
                    elif t == 'call_end' and user_id is not None:
                        room_id = data.get('roomId')
                        other_raw = data.get('toUserId')
                        reason = data.get('reason') or 'hangup'
                        if room_id and other_raw:
                            try:
                                other_uid = UUID(other_raw)
                            except Exception:
                                continue
                            payload = {
                                'type': 'call_end',
                                'fromUserId': str(user_id),
                                'toUserId': str(other_uid),
                                'roomId': room_id,
                                'reason': reason,
                            }
                            await broadcast_users({user_id, other_uid}, payload)
                            if CALL_EVENTS:
                                with contextlib.suppress(Exception):
                                    CALL_EVENTS.labels('end').inc()
    finally:
        _unregister(websocket)
        if FRIENDS_WS_ACTIVE:
            with contextlib.suppress(Exception):
                FRIENDS_WS_ACTIVE.dec()


# === Friend events ===

async def publish_friend_request(from_user_id: UUID, to_user_id: UUID, from_username: str | None):
    await broadcast_user(to_user_id, {
        'type': 'friend_request',
        'fromUserId': str(from_user_id),
        'username': from_username,
    })


async def publish_friend_accepted(user_a: UUID, user_b: UUID, username_a: str | None, username_b: str | None):
    await broadcast_user(user_a, {
        'type': 'friend_accepted',
        'userId': str(user_b),
        'username': username_b,
    })
    await broadcast_user(user_b, {
        'type': 'friend_accepted',
        'userId': str(user_a),
        'username': username_a,
    })


async def publish_friend_cancelled(requester: UUID, other: UUID):
    await broadcast_users({requester, other}, {
        'type': 'friend_cancelled',
        'userId': str(other),
    })


async def publish_friend_removed(user_a: UUID, user_b: UUID):
    await broadcast_users({user_a, user_b}, {
        'type': 'friend_removed',
        'userId': str(user_a),
    })


async def publish_direct_message(from_user: UUID, to_user: UUID, message_id: UUID, content: str, sent_at):
    # content теперь plaintext (сервер сам хранит ciphertext). Клиенту не нужно расшифровывать.
    payload = {
        'type': 'direct_message',
        'fromUserId': str(from_user),
        'toUserId': str(to_user),
        'content': content,
        'messageId': str(message_id),
        'sentAt': sent_at.isoformat(),
    }
    await broadcast_users({from_user, to_user}, payload)


async def publish_direct_cleared(user_a: UUID, user_b: UUID):
    payload = {
        'type': 'direct_cleared',
        'userIds': [str(user_a), str(user_b)],
    }
    await broadcast_users({user_a, user_b}, payload)


# === Call signaling events ===

def _inc_call_metric(name: str):  # helper
    if CALL_EVENTS:
        with contextlib.suppress(Exception):
            CALL_EVENTS.labels(name).inc()


async def publish_call_invite(from_user: UUID, to_user: UUID, room_id: str, from_username: str | None = None, from_email: str | None = None):
    _pending_calls[room_id] = {
        'fromUserId': str(from_user),
        'toUserId': str(to_user),
        # Приводим к простым str чтобы исключить pydantic/ORM объекты (ошибка JSON serializable)
        'fromUsername': (str(from_username) if from_username is not None else None),
        'fromEmail': (str(from_email) if from_email is not None else None),
        'roomId': room_id,
    }
    import time
    payload = {
        'type': 'call_invite',
        'fromUserId': str(from_user),
        'toUserId': str(to_user),
        'roomId': room_id,
        'fromUsername': (str(from_username) if from_username is not None else None),
        'fromEmail': (str(from_email) if from_email is not None else None),
        'createdAt': int(time.time()*1000),
    }
    # Диагностика: сколько активных WS у отправителя и получателя на момент рассылки
    try:
        from_count = len(_friend_clients.get(from_user, set()))
        to_count = len(_friend_clients.get(to_user, set()))
        logger.info(
            "CALL_INVITE_SEND from=%s(to_ws=%s) to=%s(to_ws=%s) room=%s", from_user, from_count, to_user, to_count, room_id
        )
    except Exception:
        logger.info("CALL_INVITE_SEND from=%s to=%s room=%s", from_user, to_user, room_id)
    _inc_call_metric('invite')
    await broadcast_users({from_user, to_user}, payload)


async def publish_call_accept(from_user: UUID, to_user: UUID, room_id: str):
    _pending_calls.pop(room_id, None)
    payload = {
        'type': 'call_accept',
        'fromUserId': str(from_user),
        'toUserId': str(to_user),
        'roomId': room_id,
    }
    logger.info("CALL_ACCEPT_SEND from=%s to=%s room=%s", from_user, to_user, room_id)
    _inc_call_metric('accept')
    await broadcast_users({from_user, to_user}, payload)


async def publish_call_decline(from_user: UUID, to_user: UUID, room_id: str):
    _pending_calls.pop(room_id, None)
    payload = {
        'type': 'call_decline',
        'fromUserId': str(from_user),
        'toUserId': str(to_user),
        'roomId': room_id,
    }
    logger.info("CALL_DECLINE_SEND from=%s to=%s room=%s", from_user, to_user, room_id)
    _inc_call_metric('decline')
    await broadcast_users({from_user, to_user}, payload)


async def publish_call_cancel(from_user: UUID, to_user: UUID, room_id: str):
    _pending_calls.pop(room_id, None)
    payload = {
        'type': 'call_cancel',
        'fromUserId': str(from_user),
        'toUserId': str(to_user),
        'roomId': room_id,
    }
    logger.info("CALL_CANCEL_SEND from=%s to=%s room=%s", from_user, to_user, room_id)
    _inc_call_metric('cancel')
    await broadcast_users({from_user, to_user}, payload)
