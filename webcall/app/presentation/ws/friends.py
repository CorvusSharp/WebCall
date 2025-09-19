from __future__ import annotations

"""WebSocket канал для событий дружбы и личных сообщений.

Форматы входящих сообщений (пока не требуются — канал read-only):
 - ping

 Форматы исходящих сообщений:
 - {"type":"friend_request","fromUserId":str, "username":str|null}
 - {"type":"friend_accepted","userId":str, "username":str|null}
 - {"type":"friend_cancelled","userId":str}
 - {"type":"friend_removed","userId":str}  # дружба удалена (обоим рассылается)
 - {"type":"direct_message","fromUserId":str,"toUserId":str,"content":str,"messageId":str,"sentAt":iso8601}
 - {"type":"call_invite","fromUserId":str,"toUserId":str,"roomId":str}
 - {"type":"call_accept","fromUserId":str,"toUserId":str,"roomId":str}
 - {"type":"call_decline","fromUserId":str,"toUserId":str,"roomId":str}
 - {"type":"call_cancel","fromUserId":str,"toUserId":str,"roomId":str}  # инициатор отменил до принятия
 - {"type":"call_end","fromUserId":str,"toUserId":str,"roomId":str,"reason":str}  # завершение уже принятого личного звонка

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

# Pending call invites stored in-memory until accepted/declined
# Keyed by room_id -> payload dict
# NOTE: Pending инвайты теперь управляются CallInviteService (InMemoryCallInviteService).
# Локальная структура оставлена для обратной совместимости publish_* функций,
# но источник истины — сервис. Publish функции продолжают очищать/добавлять сюда,
# чтобы существующий фронт, ожидающий ретрансляцию при реконнекте, работал.
_pending_calls: Dict[str, dict] = {}


def _register(user_id: UUID, ws: WebSocket):
    # Политика: только одно активное соединение на пользователя для friends WS.
    # Закрываем предыдущие, чтобы не плодить дублирующую рассылку событий.
    existing = _friend_clients.get(user_id)
    if existing:
        for old in list(existing):
            try:
                # Отправляем причину закрытия в коде 4000 (приватный код)
                import anyio  # noqa: F401 (для совместимости если нужен await context)
                try:
                    # WebSocket сервер FastAPI/Starlette: close(code) — reason опционал.
                    old.close(code=4000)
                except Exception:
                    pass
            finally:
                _unregister(old)
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


from ..api.deps.containers import get_call_invite_service
from ...core.ports.services import CallInviteService
try:  # метрики опциональны
    from prometheus_client import Counter, Gauge
    FRIENDS_WS_ACTIVE = Gauge('ws_active_friends', 'Active friends WS connections')
    CALL_EVENTS = Counter('call_signal_events_total', 'Call signaling events', ['event'])
except Exception:  # pragma: no cover
    FRIENDS_WS_ACTIVE = None
    CALL_EVENTS = None


@router.websocket('/ws/friends')
async def ws_friends(
    websocket: WebSocket,
    tokens: TokenProvider = Depends(get_token_provider),  # type: ignore[arg-type]
    users: UserRepository = Depends(get_user_repo),  # noqa: F841 (оставлено на будущее)
    call_invites: CallInviteService = Depends(get_call_invite_service),  # type: ignore[arg-type]
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
        if FRIENDS_WS_ACTIVE:
            try: FRIENDS_WS_ACTIVE.inc()
            except Exception: pass
        # На новое подключение отправляем все ожидающие инвайты для этого пользователя
        # Запрашиваем pending через сервис (источник истины)
        try:
            pending = await call_invites.list_pending_for(user_id)
            for p in pending:
                room_id = p['roomId']
                with contextlib.suppress(Exception):
                    await websocket.send_json({
                        'type': 'call_invite',
                        'fromUserId': p['fromUserId'],
                        'toUserId': p['toUserId'],
                        'roomId': room_id,
                        'fromUsername': p.get('fromUsername'),
                        'fromEmail': p.get('fromEmail'),
                    })
        except Exception:
            pass

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
                elif isinstance(data, dict) and data.get('type') == 'call_end':
                    # Инициатор завершает уже принятый звонок.
                    # Требования: авторизован, указаны roomId и toUserId
                    if user_id is None:
                        continue
                    room_id = data.get('roomId')
                    other_raw = data.get('toUserId')
                    reason = data.get('reason') or 'hangup'
                    if not room_id or not other_raw:
                        continue
                    try:
                        other_uid = UUID(other_raw)
                    except Exception:
                        continue
                    # Публикуем обеим сторонам
                    payload = {
                        'type': 'call_end',
                        'fromUserId': str(user_id),
                        'toUserId': str(other_uid),
                        'roomId': room_id,
                        'reason': reason,
                    }
                    await broadcast_users({user_id, other_uid}, payload)
                    if CALL_EVENTS:
                        try: CALL_EVENTS.labels('end').inc()
                        except Exception: pass
    finally:
        _unregister(websocket)
        if FRIENDS_WS_ACTIVE:
            try: FRIENDS_WS_ACTIVE.dec()
            except Exception: pass


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


async def publish_friend_removed(user_a: UUID, user_b: UUID):
    """Оповестить обе стороны что дружба удалена.

    Клиент при получении события просто перезагружает списки друзей/заявок.
    """
    await broadcast_users({user_a, user_b}, {
        'type': 'friend_removed',
        'userId': str(user_a),  # поле userId не критично; фронт всё равно делает reload
    })


async def publish_direct_message(from_user: UUID, to_user: UUID, message_id: UUID, ciphertext: str, sent_at):
    payload = {
        'type': 'direct_message',
        'fromUserId': str(from_user),
        'toUserId': str(to_user),
        'content': ciphertext,
        'messageId': str(message_id),
        'sentAt': sent_at.isoformat(),
    }
    await broadcast_users({from_user, to_user}, payload)


async def publish_direct_cleared(user_a: UUID, user_b: UUID):
    """Оповестить обе стороны, что их переписка очищена."""
    payload = {
        'type': 'direct_cleared',
        'userIds': [str(user_a), str(user_b)],
    }
    await broadcast_users({user_a, user_b}, payload)


# === Звонки (эфемерные комнаты) ===

async def publish_call_invite(from_user: UUID, to_user: UUID, room_id: str, from_username: str | None = None, from_email: str | None = None):
    # Persist pending invite so it survives reconnects until accepted/declined
    _pending_calls[room_id] = {
        'fromUserId': str(from_user),
        'toUserId': str(to_user),
        'fromUsername': from_username,
        'fromEmail': from_email,
    }
    await broadcast_users({from_user, to_user}, {
        'type': 'call_invite',
        'fromUserId': str(from_user),
        'toUserId': str(to_user),
        'roomId': room_id,
        'fromUsername': from_username,
        'fromEmail': from_email,
    })


async def publish_call_accept(from_user: UUID, to_user: UUID, room_id: str):
    # Clear pending invite on accept
    _pending_calls.pop(room_id, None)
    await broadcast_users({from_user, to_user}, {
        'type': 'call_accept',
        'fromUserId': str(from_user),
        'toUserId': str(to_user),
        'roomId': room_id,
    })


async def publish_call_decline(from_user: UUID, to_user: UUID, room_id: str):
    # Clear pending invite on decline
    _pending_calls.pop(room_id, None)
    await broadcast_users({from_user, to_user}, {
        'type': 'call_decline',
        'fromUserId': str(from_user),
        'toUserId': str(to_user),
        'roomId': room_id,
    })


async def publish_call_cancel(from_user: UUID, to_user: UUID, room_id: str):
    """Отмена инициатором (семантически отличается от decline принимающего).

    Для клиентов можно отображать как "Отменён" на стороне инициатора и как
    "Собеседник отменил" на стороне получателя. По сути — тоже очистка pending.
    """
    _pending_calls.pop(room_id, None)
    await broadcast_users({from_user, to_user}, {
        'type': 'call_cancel',
        'fromUserId': str(from_user),
        'toUserId': str(to_user),
        'roomId': room_id,
    })
