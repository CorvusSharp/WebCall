from __future__ import annotations

import asyncio
import json
from typing import Any
from collections import defaultdict
import contextlib
from uuid import UUID, uuid5, NAMESPACE_URL

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from ...infrastructure.config import get_settings

from ...core.domain.models import Signal
from ...core.ports.services import SignalBus, TokenProvider
from ...core.ports.repositories import UserRepository
from ..api.deps.containers import get_signal_bus, get_token_provider, get_user_repo
from ...infrastructure.messaging.redis_bus import RedisSignalBus  # for type-check to enable Redis chat broadcast

router = APIRouter()

# In-process registry of room connections for chat broadcast (dev/test)
_room_clients: dict[UUID, set[WebSocket]] = defaultdict(set)
_ws_conn: dict[WebSocket, UUID] = {}
_room_members: dict[UUID, set[UUID]] = defaultdict(set)
_display_names: dict[UUID, str] = {}


@router.websocket("/ws/rooms/{room_id}")
async def ws_room(
    websocket: WebSocket,
    room_id: str,
    bus: SignalBus = Depends(get_signal_bus),
    tokens: TokenProvider = Depends(get_token_provider),
    users: UserRepository = Depends(get_user_repo),
):  # type: ignore[override]
    settings = get_settings()
    token = websocket.query_params.get("token")
    allow_unauth = settings.APP_ENV in {"dev", "test"}
    # Принимаем соединение сразу, чтобы при ошибке аутентификации клиент получил корректный close frame,
    # иначе браузер покажет 1006 (abnormal closure)
    await websocket.accept()
    if token:
        try:
            tokens.decode_token(token)
        except Exception:
            if not allow_unauth:
                await websocket.close(code=4401, reason="Unauthorized")
                return
    else:
        if not allow_unauth:
            await websocket.close(code=4401, reason="Unauthorized")
            return
    # Поддержка человекочитаемых room_id: если не UUID, маппим в стабильный UUID v5
    try:
        room_uuid = UUID(room_id)
    except Exception:
        room_uuid = uuid5(NAMESPACE_URL, f"webcall:{room_id}")

    async def sender():
        async for signal in bus.subscribe(room_uuid):
            await websocket.send_json(
                {
                    "type": "signal",
                    "fromUserId": str(signal.sender_id),
                    "signalType": signal.type.value,
                    "sdp": signal.sdp,
                    "candidate": signal.candidate,
                    # передаём target для клиентской фильтрации (если задан)
                    "targetUserId": str(signal.target_id) if getattr(signal, "target_id", None) else None,
                }
            )

    send_task = asyncio.create_task(sender())
    # If Redis is used, also subscribe to chat channel to receive messages from other processes
    chat_task: asyncio.Task | None = None
    chat_channel = f"room:{room_uuid}:chat"
    if isinstance(bus, RedisSignalBus):
        async def chat_listener() -> None:
            pubsub = bus.redis.pubsub()
            await pubsub.subscribe(chat_channel)
            try:
                async for msg in pubsub.listen():
                    if msg.get("type") != "message":
                        continue
                    try:
                        data = json.loads(msg["data"])  # type: ignore[arg-type]
                    except Exception:
                        continue
                    await websocket.send_json({
                        "type": "chat",
                        "authorId": data.get("authorId"),
                        "authorName": data.get("authorName"),
                        "content": data.get("content")
                    })
            finally:
                with contextlib.suppress(Exception):
                    await pubsub.unsubscribe(chat_channel)
                    await pubsub.close()

        chat_task = asyncio.create_task(chat_listener())
    # register connection in room for chat broadcast
    _room_clients[room_uuid].add(websocket)

    try:
        while True:
            msg = await websocket.receive_text()
            data: dict[str, Any] = json.loads(msg)
            if data.get("type") == "ping":
                # heartbeat
                await websocket.send_json({"type": "pong"})
                continue
            if data.get("type") == "signal":
                raw_t = str(data.get("signalType") or "").strip()
                # Normalize to hyphen style to match SignalType values
                norm_t = raw_t.replace(" ", "").replace("_", "-").lower()
                if norm_t == "icecandidate":
                    norm_t = "ice-candidate"
                try:
                    s = Signal.create(
                        type=norm_t,
                        sender_id=UUID(data.get("fromUserId")),
                        room_id=room_uuid,
                        sdp=data.get("sdp"),
                        candidate=data.get("candidate"),
                        target_id=UUID(data["targetUserId"]) if data.get("targetUserId") else None,
                    )
                except Exception as e:
                    # Do not drop WS on bad input; report error back
                    await websocket.send_json({
                        "type": "error",
                        "message": f"Invalid signalType '{raw_t}': {e.__class__.__name__}"
                    })
                    continue
                try:
                    await bus.publish(room_uuid, s)
                except Exception as e:
                    await websocket.send_json({
                        "type": "error",
                        "message": f"Publish error: {e.__class__.__name__}"
                    })
            elif data.get("type") == "join":
                # Register user presence
                try:
                    conn_id = UUID(data.get("fromUserId"))
                except Exception:
                    # if invalid id, skip presence for this socket
                    continue

                # Try to attach real username from token subject
                real_name: str | None = None
                if token:
                    with contextlib.suppress(Exception):
                        payload = tokens.decode_token(token)
                        # subject is a UUID of user id
                        uid = UUID(payload.get("sub")) if payload.get("sub") else None
                        if uid:
                            user = await users.get_by_id(uid)
                            if user:
                                real_name = user.username

                _ws_conn[websocket] = conn_id
                _room_members[room_uuid].add(conn_id)
                uname = (data.get("username") or real_name or str(conn_id)[:8])
                _display_names[conn_id] = uname
                # broadcast presence list to room (with id->name map)
                members = [str(u) for u in sorted(_room_members[room_uuid], key=str)]
                names = { str(uid): _display_names.get(uid, str(uid)[:8]) for uid in _room_members[room_uuid] }
                for ws in list(_room_clients.get(room_uuid, set())):
                    with contextlib.suppress(Exception):
                        await ws.send_json({"type": "presence", "users": members, "userNames": names})
            elif data.get("type") == "leave":
                # Graceful close to avoid 1005/1006 on client
                with contextlib.suppress(Exception):
                    await websocket.close(code=1000, reason="Client left")
                break
            elif data.get("type") == "chat":
                # Broadcast chat to all participants in room (including sender)
                content = data.get("content")
                author_id = data.get("fromUserId")
                author_name: str | None = _display_names.get(UUID(author_id)) if author_id else None

                if isinstance(bus, RedisSignalBus):
                    # Publish to Redis channel so all processes deliver the message
                    await bus.redis.publish(chat_channel, json.dumps({
                        "fromUserId": author_id,
                        "authorName": author_name,
                        "content": content
                    }))
                else:
                    # In-process fallback (dev/test)
                    payload = {"type": "chat", "fromUserId": author_id, "authorName": author_name, "content": content}
                    dead: list[WebSocket] = []
                    for ws in list(_room_clients.get(room_uuid, set())):
                        try:
                            await ws.send_json(payload)
                        except Exception:
                            dead.append(ws)
                    # cleanup dead connections
                    for ws in dead:
                        with contextlib.suppress(KeyError):
                            _room_clients[room_uuid].remove(ws)
            else:
                await websocket.send_json({"type": "error", "message": "Unknown message"})
    except WebSocketDisconnect:
        pass
    finally:
        send_task.cancel()
        if chat_task:
            chat_task.cancel()
        # В Python 3.11 CancelledError наследуется от BaseException — подавляем явно
        with contextlib.suppress(asyncio.CancelledError):
            await send_task
        if chat_task:
            with contextlib.suppress(asyncio.CancelledError):
                await chat_task
        # unregister connection
        with contextlib.suppress(KeyError):
            _room_clients[room_uuid].remove(websocket)
        # presence cleanup and broadcast
        uid = _ws_conn.pop(websocket, None)
        if uid is not None:
            with contextlib.suppress(KeyError):
                _room_members[room_uuid].remove(uid)
            if uid not in _room_members.get(room_uuid, set()):
                with contextlib.suppress(KeyError):
                    _display_names.pop(uid)
            
            members = [str(u) for u in sorted(_room_members[room_uuid], key=str)]
            names = { str(mid): _display_names.get(UUID(mid), mid[:8]) if isinstance(mid, str) else _display_names.get(mid, str(mid)[:8]) for mid in _room_members[room_uuid] }
            for ws in list(_room_clients.get(room_uuid, set())):
                with contextlib.suppress(Exception):
                    await ws.send_json({"type": "presence", "users": members, "userNames": names})
