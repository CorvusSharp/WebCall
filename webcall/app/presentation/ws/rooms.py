from __future__ import annotations

import asyncio
import json
from typing import Any
from collections import defaultdict
import contextlib
from uuid import UUID, uuid5, NAMESPACE_URL
from datetime import datetime

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from ...infrastructure.config import get_settings
from ...infrastructure.services.summary import get_summary_collector
from ...infrastructure.services.voice_transcript import get_voice_collector
from ...infrastructure.services.ai_provider import get_ai_provider
from ...infrastructure.services.telegram import send_message as tg_send_message

from ...core.domain.models import Signal
from ...core.ports.services import SignalBus, TokenProvider
from ...core.ports.repositories import UserRepository, ParticipantRepository, RoomRepository
from ..api.deps.containers import get_signal_bus, get_token_provider, get_user_repo, get_participant_repo, get_room_repo
from ...infrastructure.messaging.redis_bus import RedisSignalBus  # for type-check to enable Redis chat broadcast

router = APIRouter()

# In-process registry of room connections for chat broadcast (dev/test)
_room_clients: dict[UUID, set[WebSocket]] = defaultdict(set)
_ws_conn: dict[WebSocket, UUID] = {}
_room_members: dict[UUID, set[UUID]] = defaultdict(set)
_display_names: dict[UUID, str] = {}
# Однократная финализация summary по комнате (manual trigger)
_room_summary_finalized: set[UUID] = set()


async def _generate_and_send_summary(room_uuid: UUID, original_room_id: str, reason: str, *,
                                     ai_provider, collector, voice_coll) -> None:  # type: ignore[no-untyped-def]
    """Собирает summary (voice > chat) и отправляет в Telegram. Используется только по ручному триггеру.

    reason: строка причины (manual, debug, etc.)
    """
    # TODO: покрыть интеграционным тестом (websocket):
    # 1) отправить несколько chat сообщений;
    # 2) имитировать наличие voice транскрипта в voice_coll;
    # 3) отправить agent_summary и проверить одноразовую отправку.
    if room_uuid in _room_summary_finalized:
        print(f"[summary] Already finalized room={original_room_id}")
        return
    settings = get_settings()
    v = None
    with contextlib.suppress(Exception):
        # Пытаемся забрать транскрипт (voice_capture уже должен быть остановлен)
        v = await voice_coll.pop_transcript(str(room_uuid)) or await voice_coll.pop_transcript(original_room_id)
    from ...infrastructure.services.summary import SummaryCollector
    summary = None
    if v and v.text and not v.text.startswith('(no audio'):
        print(f"[summary] Using voice transcript for room {original_room_id} chars={len(v.text)} reason={reason}")
        import re
        temp = SummaryCollector()
        text = v.text or ''
        sentences: list[str] = []
        if text.strip():
            norm = re.sub(r"\s+", " ", text.strip())
            parts = re.split(r'(?<=[.!?])\s+', norm)
            sentences = [p.strip() for p in parts if p.strip()]
        if not sentences and text.strip():
            sentences = [text.strip()]
        for sent in sentences:
            await temp.add_message(str(room_uuid), None, 'voice', sent)
        summary = await temp.summarize(str(room_uuid), ai_provider)
    else:
        # Голос отсутствует/пустой — используем чат
        print(f"[summary] Voice transcript missing or empty for room {original_room_id}; fallback to chat. reason={reason}")
        summary = await collector.summarize(str(room_uuid), ai_provider)
    if summary:
        if settings.TELEGRAM_BOT_TOKEN and settings.TELEGRAM_CHAT_ID:
            try:
                text = (
                    f"Room {summary.room_id} завершена (trigger={reason}). Источник: {'voice' if (v and v.text and not v.text.startswith('(no audio')) else 'chat'}. Сообщений: {summary.message_count}.\n"
                    f"--- Summary ---\n{summary.summary_text}"
                )
                await tg_send_message(text)
                print(f"[summary] Telegram sent for room {original_room_id} trigger={reason}")
            except Exception as e:
                print(f"[summary] Telegram send failed: {e}")
    else:
        print(f"[summary] Nothing to summarize room={original_room_id} trigger={reason}")
    _room_summary_finalized.add(room_uuid)


@router.websocket("/ws/rooms/{room_id}")
async def ws_room(
    websocket: WebSocket,
    room_id: str,
    bus: SignalBus = Depends(get_signal_bus),
    tokens: TokenProvider = Depends(get_token_provider),
    users: UserRepository = Depends(get_user_repo),
    participants: ParticipantRepository = Depends(get_participant_repo),
    rooms: RoomRepository = Depends(get_room_repo),
):  # type: ignore[override]
    settings = get_settings()
    token = websocket.query_params.get("token")
    is_agent = websocket.query_params.get("agent") in {"1", "true", "yes"}
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

    collector = get_summary_collector()
    ai_provider = None
    voice_coll = get_voice_collector()
    with contextlib.suppress(Exception):  # AI провайдер не критичен
        ai_provider = get_ai_provider()

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

                # Если это AI агент – переопределим на детерминированный UUID чтобы не плодить лишние peer соединения при переподключениях
                if is_agent:
                    conn_id = uuid5(NAMESPACE_URL, f"webcall:agent:{room_uuid}")
                    data["username"] = data.get("username") or "AI AGENT"

                # Try to attach real username from token subject
                real_name: str | None = None
                account_uid: UUID | None = None
                if token:
                    with contextlib.suppress(Exception):
                        payload = tokens.decode_token(token)
                        # subject is a UUID of user id
                        uid_str = payload.get("sub")
                        uid = UUID(uid_str) if uid_str else None
                        if uid:
                            account_uid = uid
                            user = await users.get_by_id(uid)
                            if user:
                                real_name = user.username

                _ws_conn[websocket] = conn_id
                _room_members[room_uuid].add(conn_id)
                uname = (data.get("username") or real_name or ("AI AGENT" if is_agent else str(conn_id)[:8]))
                _display_names[conn_id] = uname
                # broadcast presence list to room (with id->name map)
                members = [str(u) for u in sorted(_room_members[room_uuid], key=str)]
                names = { str(uid): _display_names.get(uid, str(uid)[:8]) for uid in _room_members[room_uuid] }
                agent_ids = [str(u) for u in _room_members[room_uuid] if str(u).startswith(str(uuid5(NAMESPACE_URL, f"webcall:agent:{room_uuid}")).split('-')[0])]
                for ws in list(_room_clients.get(room_uuid, set())):
                    with contextlib.suppress(Exception):
                        await ws.send_json({"type": "presence", "users": members, "userNames": names, "agentIds": agent_ids})

                # Persist visit in DB for authenticated users
                if account_uid is not None:
                    try:
                        # Skip persisting ephemeral call rooms (used for WebRTC calls).
                        # These rooms have a 'call-' prefix in the original path and
                        # should not be stored in visited history or created as
                        # long-lived room records.
                        if (room_id or "").startswith("call-"):
                            # Do not create room meta or participant entries for call rooms
                            # Keep in-memory presence information but skip DB work.
                            continue
                        # Ensure room exists in DB. If not, auto-create with deterministic id
                        room_meta = await rooms.get(room_uuid)
                        if room_meta is None:
                            from ...core.domain.models import Room, Participant, Role
                            from ...core.domain.values import RoomName
                            # Derive a human-friendly name from provided path param
                            safe_name = (room_id or str(room_uuid))[:100]
                            # Create room with fixed UUID = room_uuid so WS and DB align
                            new_room = Room(id=room_uuid, name=RoomName(safe_name), owner_id=account_uid, is_private=False, created_at=datetime.utcnow())
                            try:
                                await rooms.add(new_room)
                            except Exception:
                                # ignore race conditions or duplicates
                                pass
                            # refresh meta
                            room_meta = await rooms.get(room_uuid)

                        if room_meta is not None:
                            # Check if there's already an active participation
                            active = await participants.get_active(room_uuid, account_uid)
                            if not active:
                                from ...core.domain.models import Participant, Role
                                p = Participant.join(user_id=account_uid, room_id=room_uuid, role=Role.member)
                                await participants.add(p)
                    except Exception:
                        # не роняем WS из‑за ошибки БД
                        pass
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

                # Сбор для последующей выжимки
                with contextlib.suppress(Exception):
                    await collector.add_message(str(room_uuid), author_id, author_name, content or "")

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
            elif data.get("type") == "agent_summary":
                # Ручной триггер от клиента (второй клик на кнопку AI Agent)
                await websocket.send_json({"type": "agent_summary_ack", "status": "processing"})
                try:
                    await _generate_and_send_summary(room_uuid, room_id, "manual", ai_provider=ai_provider, collector=collector, voice_coll=voice_coll)
                    await websocket.send_json({"type": "agent_summary_ack", "status": "done"})
                except Exception as e:  # pragma: no cover
                    await websocket.send_json({"type": "agent_summary_ack", "status": "error", "error": str(e)})
                continue
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
                    await ws.send_json({"type": "presence", "users": members, "userNames": names, "agentIds": []})

        # try to mark DB participation left_at for authenticated user
        if token:
            with contextlib.suppress(Exception):
                payload = tokens.decode_token(token)
                uid_str = payload.get("sub")
                account_uid = UUID(uid_str) if uid_str else None
                if account_uid is not None:
                    try:
                        # Update only if room exists (consistency with join)
                        room_meta = await rooms.get(room_uuid)
                        if room_meta is not None:
                            active = await participants.get_active(room_uuid, account_uid)
                            if active and not active.left_at:
                                active.left_at = datetime.utcnow()
                                await participants.update(active)
                    except Exception:
                        pass

        # Авто-summary отключено: теперь генерация только по сообщению type=agent_summary (manual trigger)
        # (сохраняем блок для удобства будущего расширения)
        try:
            pass
        except Exception:
            pass
