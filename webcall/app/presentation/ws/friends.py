from __future__ import annotations

"""WebSocket канал для событий дружбы и личных сообщений.

Форматы входящих сообщений (пока не требуются — канал read-only):
 - ping

Форматы исходящих сообщений:
 - {"type":"friend_request","fromUserId":str, "username":str|null}
 - {"type":"friend_accepted","userId":str, "username":str|null}
 - {"type":"friend_cancelled","userId":str}
 - {"type":"direct_message","fromUserId":str,"toUserId":str,"content":str,"messageId":str,"sentAt":iso8601}

Авторизация: query param token=<JWT> (аналогично rooms WS). Если token отсутствует и среда не dev/test — 4401.
"""

import asyncio
import contextlib
import json
from typing import Dict, Set
from uuid import UUID

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends

from ...infrastructure.config import get_settings
from ...core.ports.repositories import UserRepository
from ..api.deps.containers import get_user_repo, get_token_provider
from ...core.ports.services import TokenProvider

router = APIRouter()

_friend_clients: Dict[UUID, Set[WebSocket]] = {}
_ws_to_user: Dict[WebSocket, UUID] = {}


def _register(user_id: UUID, ws: WebSocket):
    _friend_clients.setdefault(user_id, set()).add(ws)
    _ws_to_user[ws] = user_id


def _unregister(ws: WebSocket):
    uid = _ws_to_user.pop(ws, None)
    if uid is not None:
        s = _friend_clients.get(uid)
        if s and ws in s:
            s.discard(ws)
            if not s:
                _friend_clients.pop(uid, None)


async def broadcast_user(user_id: UUID, payload: dict):
    """Отправить событие всем WebSocket клиента данного пользователя."""
    for ws in list(_friend_clients.get(user_id, set())):
        with contextlib.suppress(Exception):
            await ws.send_json(payload)


async def broadcast_users(user_ids: Set[UUID] | list[UUID], payload: dict):
    for uid in user_ids:
        await broadcast_user(uid, payload)


@router.websocket('/ws/friends')
async def ws_friends(
    websocket: WebSocket,
    tokens: TokenProvider = Depends(get_token_provider),  # type: ignore[arg-type]
    users: UserRepository = Depends(get_user_repo),  # noqa: F841 (оставлено на будущее)
):  # type: ignore[override]
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

    # В неавторизованном режиме не храним подписку, только echo/ping
    if user_id is not None:
        _register(user_id, websocket)

    try:
        while True:
            try:
                msg = await websocket.receive_text()
            except WebSocketDisconnect:
                break
            except Exception:
                break
            # Поддерживаем ping/pong
            with contextlib.suppress(Exception):
                data = json.loads(msg)
                if isinstance(data, dict) and data.get('type') == 'ping':
                    await websocket.send_json({'type': 'pong'})
    finally:
        _unregister(websocket)


# === Хелперы публикации событий (используются из REST слоёв) ===

async def publish_friend_request(from_user_id: UUID, to_user_id: UUID, from_username: str | None):
    await broadcast_user(to_user_id, {
        'type': 'friend_request',
        'fromUserId': str(from_user_id),
        'username': from_username,
    })


async def publish_friend_accepted(user_a: UUID, user_b: UUID, username_a: str | None, username_b: str | None):
    # Оба получают событие
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
    # Оба получают уведомление для синхронизации (фронт просто перезагрузит списки)
    await broadcast_users({requester, other}, {
        'type': 'friend_cancelled',
        'userId': str(other),
    })


async def publish_direct_message(from_user: UUID, to_user: UUID, message_id: UUID, plaintext: str, sent_at):
    payload = {
        'type': 'direct_message',
        'fromUserId': str(from_user),
        'toUserId': str(to_user),
        'content': plaintext,
        'messageId': str(message_id),
        'sentAt': sent_at.isoformat(),
    }
    await broadcast_users({from_user, to_user}, payload)
