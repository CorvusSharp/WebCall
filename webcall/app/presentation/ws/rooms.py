from __future__ import annotations

import os, asyncio, contextlib, time, re, json
from typing import Any
from collections import defaultdict
from uuid import UUID, uuid5, NAMESPACE_URL
from datetime import datetime

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from ...infrastructure.config import get_settings
from ...infrastructure.services.summary import get_summary_collector, SummaryCollector, SummaryResult
from ...infrastructure.services.voice_transcript import get_voice_collector
from ...infrastructure.services.ai_provider import get_ai_provider, get_user_system_prompt
from ...infrastructure.services.summary_v2.orchestrator import get_summary_orchestrator
from ...infrastructure.services.telegram import send_message as tg_send_message
from sqlalchemy.ext.asyncio import AsyncSession
from ...infrastructure.db.session import get_db_session
from ...infrastructure.services.telegram_link import get_confirmed_chat_id

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
# Множество AI агентов по комнатам (для поддержки нескольких персональных агентов)
_room_agents: dict[UUID, set[UUID]] = defaultdict(set)
# Кэш готового summary (одно на комнату)
_room_summary_cache: dict[UUID, SummaryResult] = {}
# Кому уже доставлено summary (персонально)
_room_summary_served: dict[UUID, set[UUID]] = defaultdict(set)
# Владелец агента: conn_id агента -> user_id владельца
_agent_owner: dict[UUID, UUID] = {}
# Локи генерации per комната
_room_summary_locks: dict[UUID, asyncio.Lock] = defaultdict(asyncio.Lock)
# Персональные manual summary кэши: (room,user) -> SummaryResult и обслуженные отправки
_user_manual_summary_cache: dict[tuple[UUID, UUID], SummaryResult] = {}
_user_manual_summary_served: set[tuple[UUID, UUID]] = set()
_room_participant_users: dict[UUID, set[UUID]] = defaultdict(set)
# Архив последних сообщений комнаты (для персональных запросов после группового destructive summarize)
_room_messages_archive: dict[UUID, list] = {}
# Персистентный процессовый лог всех чат сообщений (не destructive)
_room_message_log: dict[UUID, list] = defaultdict(list)
# Время старта персонального агента для пользователя в комнате (ms epoch)
_room_agent_start: dict[tuple[UUID, UUID], int] = {}


async def _generate_and_send_summary(room_uuid: UUID, original_room_id: str, reason: str, *,
                                     ai_provider, collector, voice_coll, session: AsyncSession | None = None,
                                     initiator_user_id: UUID | None = None) -> None:  # type: ignore[no-untyped-def]
    """Собирает summary (voice > chat) и отправляет в Telegram. Используется только по ручному триггеру.

    reason: строка причины (manual, debug, etc.)
    """
    # TODO: покрыть интеграционным тестом (websocket):
    # 1) отправить несколько chat сообщений;
    # 2) имитировать наличие voice транскрипта в voice_coll;
    # 3) отправить agent_summary и проверить одноразовую отправку.
    settings = get_settings()
    # Персональный режим: если инициатор указан — генерируем snapshot-based summary индивидуально
    if initiator_user_id: 
        # Feature flag: отключить новую архитектуру, установить USE_SUMMARY_V2=0
        use_v2 = os.getenv("USE_SUMMARY_V2", "1").lower() not in {"0", "false", "no"}
        if use_v2:
            orchestrator = get_summary_orchestrator()
            print(f"[summary] Personal summary start room={original_room_id} user={initiator_user_id} reason={reason} use_v2=1")
                # Оппортунистическое прикрепление ТОЛЬКО персонального транскрипта (без fallback на общий ключ)
            with contextlib.suppress(Exception):
                v_cur = await voice_coll.get_transcript(f"{room_uuid}:{initiator_user_id}")
                if v_cur and getattr(v_cur, 'text', None):
                    raw_txt = v_cur.text.strip()
                    if raw_txt and not raw_txt.startswith('(no audio'):
                        # Извлекаем captureTs если уже есть мета
                        capture_ts = None
                        if raw_txt.startswith('[meta ') and 'captureTs=' in raw_txt:
                            m = re.search(r'captureTs=(\d+)', raw_txt)
                            if m:
                                with contextlib.suppress(Exception):
                                    capture_ts = int(m.group(1))
                        if capture_ts is None:
                            capture_ts = int(time.time()*1000)
                            raw_txt = f"[meta captureTs={capture_ts}] " + raw_txt
                        start_ms = _room_agent_start.get((room_uuid, initiator_user_id))
                        fresh = start_ms is None or capture_ts >= (start_ms - 150)
                        if fresh:
                            orchestrator.add_voice_transcript(str(room_uuid), raw_txt, user_id=str(initiator_user_id))
                            print(f"[summary] opportunistic_attach accepted room={original_room_id} user={initiator_user_id} captureTs={capture_ts} start_ms={start_ms}")
                        else:
                            print(f"[summary] opportunistic_attach rejected(stale) room={original_room_id} user={initiator_user_id} captureTs={capture_ts} start_ms={start_ms}")
            # Первая попытка построить персональное summary
            cutoff_ms = int(__import__('time').time()*1000)
            personal = await orchestrator.build_personal_summary(room_id=str(room_uuid), user_id=str(initiator_user_id), ai_provider=ai_provider, db_session=session, cutoff_ms=cutoff_ms)
            # Polling если пусто (возможна гонка: транскрипт ещё в пути / задержка ASR)
            if personal.message_count == 0:
                max_wait_ms = 8000  # увеличено с 2500 чтобы дождаться медленной транскрипции
                step_ms = 400
                waited = 0
                while waited < max_wait_ms:
                    await asyncio.sleep(step_ms / 1000)
                    waited += step_ms
                    personal2 = await orchestrator.build_personal_summary(room_id=str(room_uuid), user_id=str(initiator_user_id), ai_provider=ai_provider, db_session=session, cutoff_ms=cutoff_ms)
                    if personal2.message_count > 0:
                        personal = personal2
                        print(f"[summary] Personal summary filled after wait={waited}ms room={original_room_id} user={initiator_user_id}")
                        break
                else:
                    # Финальный повторный захват транскрипта и ре-генерация если voice появился но не прикрепился
                    try:
                        v_cur2 = None
                        with contextlib.suppress(Exception):
                            v_cur2 = await voice_coll.get_transcript(f"{room_uuid}:{initiator_user_id}")
                        if v_cur2 and getattr(v_cur2, 'text', None) and len(v_cur2.text.strip()) > 10 and not v_cur2.text.startswith('(no audio'):
                            orchestrator.add_voice_transcript(str(room_uuid), v_cur2.text.strip(), user_id=str(initiator_user_id))
                            personal3 = await orchestrator.build_personal_summary(room_id=str(room_uuid), user_id=str(initiator_user_id), ai_provider=ai_provider, db_session=session, cutoff_ms=cutoff_ms)
                            if personal3.message_count > 0:
                                personal = personal3
                                print(f"[summary] Personal summary recovered after final voice attach room={original_room_id} user={initiator_user_id}")
                    except Exception:
                        pass
            # Очистим использованный персональный транскрипт если мы что-то реально собрали
            if personal.message_count > 0:
                with contextlib.suppress(Exception):
                    await voice_coll.pop_transcript(f"{room_uuid}:{initiator_user_id}")
            # Подготовка и отправка в Telegram с расширенным логированием причин пропуска
            if not settings.TELEGRAM_BOT_TOKEN:
                print(f"[summary] Telegram skip: no TELEGRAM_BOT_TOKEN room={original_room_id} user={initiator_user_id}")
            elif session is None:
                print(f"[summary] Telegram skip: no DB session room={original_room_id} user={initiator_user_id}")
            else:
                print(f"[summary] Telegram dispatch entering room={original_room_id} user={initiator_user_id} msg_count={personal.message_count}")
                try:
                    chat_id = await get_confirmed_chat_id(session, initiator_user_id)
                except Exception as e:
                    chat_id = None
                    print(f"[summary] Telegram error: get_confirmed_chat_id failed room={original_room_id} user={initiator_user_id} err={e}")
                if not chat_id:
                    print(f"[summary] Telegram skip: no confirmed chat_id room={original_room_id} user={initiator_user_id}")
                else:
                    if personal.message_count == 0:
                        body = (
                            "Персональное резюме пока пусто: сообщений ещё нет или продолжается обработка голоса. "
                            "Попробуйте запросить ещё раз через несколько секунд."
                        )
                    else:
                        body = personal.summary_text
                    print(f"[summary] Telegram preparing body_len={len(body)} room={original_room_id} user={initiator_user_id}")
                    # Participant breakdown форматирование (если присутствует)
                    participants_block = ""
                    try:
                        parts = getattr(personal, 'participants', None)
                        print(f"[summary] Telegram participants_count={len(parts) if parts else 0} room={original_room_id} user={initiator_user_id}")
                        if parts:
                            lines = []
                            for p in parts[:5]:  # ограничим до 5 участников
                                sample_tail = p.sample_messages[-2:] if p.sample_messages else []
                                sample_txt = "; ".join(sample_tail)
                                who = p.participant_name or p.participant_id or "anon"
                                line = f"- {who}: {p.message_count} msg. {sample_txt}".strip()
                                # Усечение строки если длинная
                                if len(line) > 180:
                                    line = line[:177] + "…"
                                lines.append(line)
                            participants_block = "\n\nУчастники:\n" + "\n".join(lines)
                    except Exception as e:
                        print(f"[summary] Participants format error room={original_room_id} user={initiator_user_id} err={e}")
                        participants_block = ""
                    text = (
                        f"Room {personal.room_id} персональное summary (trigger={reason}). Сообщений: {personal.message_count}.\n--- Summary ---\n{body}{participants_block}"
                    )
                    # Telegram API всё равно обрежет до ~4096; подрежем чуть раньше (4000) чтобы не потерять окончание
                    if len(text) > 4000:
                        text = text[:3990] + "…(truncated)"
                    sent = False
                    try:
                        sent = await tg_send_message(text, chat_ids=[chat_id], session=session)
                    except Exception as e:
                        print(f"[summary] Telegram send exception room={original_room_id} user={initiator_user_id} err={e}")
                    if personal.message_count > 0 and not sent:
                        print(f"[summary] Telegram NOT SENT despite message_count>0 room={original_room_id} user={initiator_user_id} chat_id={chat_id}")
                    print(f"[summary] Personal summary (v2) send_result={sent} user={initiator_user_id} room={original_room_id} empty={personal.message_count==0}")
            return
        else:
            # Fallback: старая логика snapshot + summarize_messages (без orchestrator)
            from ...infrastructure.services.summary import summarize_messages as _sm
            # Снимок сообщений + voice если готов
            v_cur = None
            with contextlib.suppress(Exception):
                v_cur = await voice_coll.get_transcript(str(room_uuid)) or await voice_coll.get_transcript(original_room_id)
            msgs = []
            with contextlib.suppress(Exception):
                msgs = await collector.get_messages_snapshot(str(room_uuid))  # type: ignore[attr-defined]
            merged = list(msgs)
            if v_cur and getattr(v_cur, 'text', None) and v_cur.text.strip() and not v_cur.text.startswith('(no audio'):
                try:
                    from ...infrastructure.services.summary import ChatMessage as _CM
                    import time as _t
                    merged.append(_CM(room_id=str(room_uuid), author_id=None, author_name='voice', content=v_cur.text.strip(), ts=int(_t.time()*1000)))
                except Exception:
                    pass
            legacy_result = None
            if merged:
                with contextlib.suppress(Exception):
                    legacy_result = await _sm(merged, ai_provider)
            if settings.TELEGRAM_BOT_TOKEN and session is not None:
                with contextlib.suppress(Exception):
                    chat_id = await get_confirmed_chat_id(session, initiator_user_id)
                    if chat_id:
                        if legacy_result:
                            text = (
                                f"Room {legacy_result.room_id} персональное summary (legacy, trigger={reason}). Сообщений: {legacy_result.message_count}.\n--- Summary ---\n{legacy_result.summary_text}"
                            )
                        else:
                            text = (
                                f"Room {room_uuid} персональное summary (legacy, trigger={reason}). Сообщений нет."\
                                " Возможно, данных ещё недостаточно."
                            )
                        await tg_send_message(text, chat_ids=[chat_id], session=session)
            return

    # Групповой режим (без initiator): старый кэш + лок
    lock = _room_summary_locks[room_uuid]
    async with lock:
        cached = _room_summary_cache.get(room_uuid)
        if cached is not None:
            targets: set[UUID] = set()
            for aid in _room_agents.get(room_uuid, set()):
                owner = _agent_owner.get(aid)
                if owner:
                    targets.add(owner)
            if not targets:
                # fallback: все участники комнаты (user_ids)
                participants = _room_participant_users.get(room_uuid, set())
                if participants:
                    targets.update(participants)
                    print(f"[summary] Group targets fallback to participants count={len(participants)} room={original_room_id}")
                else:
                    print(f"[summary] Cached summary exists room={original_room_id} but no group targets/participants")
                    return
            served = _room_summary_served[room_uuid]
            pending = [u for u in targets if u not in served]
            if not pending:
                print(f"[summary] Cached summary already served to all group targets room={original_room_id}")
                return
            if settings.TELEGRAM_BOT_TOKEN:
                for uid in pending:
                    try:
                        chat_id = None
                        if session is not None:
                            chat_id = await get_confirmed_chat_id(session, uid)
                        if not chat_id:
                            print(f"[summary] Skip send user={uid} room={original_room_id}: no chat_id")
                            continue
                        text = (
                            f"Room {cached.room_id} завершена (trigger={reason}, cached). Сообщений: {cached.message_count}.\n--- Summary ---\n{cached.summary_text}"
                        )
                        await tg_send_message(text, chat_ids=[chat_id], session=session)
                        served.add(uid)
                        print(f"[summary] Cached summary delivered user={uid} room={original_room_id}")
                    except Exception as e:
                        print(f"[summary] Cached summary send failed user={uid} room={original_room_id} err={e}")
            return
    # settings уже инициализирован выше
    v = None
    # Ожидаем до ~6с появления транскрипта (poll каждые 300мс)
    for attempt in range(20):
        with contextlib.suppress(Exception):
            v = await voice_coll.get_transcript(str(room_uuid)) or await voice_coll.get_transcript(original_room_id)
        if v:  # готов
            break
        await asyncio.sleep(0.3)
    # Если получили – извлекаем (pop) чтобы не использовать повторно
    if v:
        with contextlib.suppress(Exception):
            v = await voice_coll.pop_transcript(str(room_uuid)) or await voice_coll.pop_transcript(original_room_id)
    from ...infrastructure.services.summary import SummaryCollector
    summary = None
    # Получаем кастомный system prompt (только если пользователь инициатор известен)
    custom_prompt: str | None = None
    if initiator_user_id and session is not None:
        with contextlib.suppress(Exception):
            custom_prompt = await get_user_system_prompt(session, initiator_user_id)

    from ...infrastructure.services.summary import summarize_messages as _sm
    if v and v.text and not v.text.startswith('(no audio'):
        print(f"[summary] Using voice transcript for room {original_room_id} chars={len(v.text)} reason={reason}")
        import re, time as _t
        # Разбиваем транскрипт на предложения, формируем временный список ChatMessage без очистки collector
        sentences: list[str] = []
        text_v = v.text or ''
        if text_v.strip():
            norm = re.sub(r"\s+", " ", text_v.strip())
            parts = re.split(r'(?<=[.!?])\s+', norm)
            sentences = [p.strip() for p in parts if p.strip()]
        if not sentences and text_v.strip():
            sentences = [text_v.strip()]
        voice_msgs = []
        try:
            from ...infrastructure.services.summary import ChatMessage as _CM
            now_ms = int(_t.time()*1000)
            for s in sentences:
                voice_msgs.append(_CM(room_id=str(room_uuid), author_id=None, author_name='voice', content=s, ts=now_ms))
        except Exception:
            pass
        # Берём snapshot текущего collector и добавляем voice предложения (не destructive)
        base_snap = []
        with contextlib.suppress(Exception):
            base_snap = await collector.get_messages_snapshot(str(room_uuid))  # type: ignore[attr-defined]
        merged = list(base_snap) + voice_msgs
        if merged:
            summary = await _sm(merged, ai_provider, system_prompt=custom_prompt)
    else:
        print(f"[summary] Voice transcript missing or empty for room {original_room_id}; fallback to chat. reason={reason}")
        # Чат snapshot без очистки
        try:
            snap_chat = await collector.get_messages_snapshot(str(room_uuid))  # type: ignore[attr-defined]
            if snap_chat:
                summary = await _sm(snap_chat, ai_provider, system_prompt=custom_prompt)
        except Exception as e:
            print(f"[summary] Chat snapshot summarize failed room={original_room_id} err={e}")
    # Диагностика: текущее число сообщений (collector пока не очищен)
    pre_count = None
    with contextlib.suppress(Exception):
        pre_count = await collector.message_count(str(room_uuid))  # type: ignore[attr-defined]
    # Если пока summary нет, попробуем второй шанс: объединить voice (если есть) + чат snapshot
    if summary is None:
        try:
            base_snap2 = await collector.get_messages_snapshot(str(room_uuid))  # type: ignore[attr-defined]
            merged2 = base_snap2
            if v and v.text and not v.text.startswith('(no audio'):
                # Добавим неразбитый текст если вдруг разбиение не сработало
                from ...infrastructure.services.summary import ChatMessage as _CM
                import time as _t
                merged2 = list(base_snap2)
                merged2.append(_CM(room_id=str(room_uuid), author_id=None, author_name='voice', content=v.text.strip(), ts=int(_t.time()*1000)))
            if merged2:
                summary = await _sm(merged2, ai_provider, system_prompt=custom_prompt)
                print(f"[summary] Second-chance merge snapshot used room={original_room_id} count={len(merged2)}")
        except Exception as e:
            print(f"[summary] Second-chance summarize failed room={original_room_id} err={e}")
    if summary:
        # Сохраняем архив если его ещё нет (берём актуальный snapshot)
        if room_uuid not in _room_messages_archive:
            with contextlib.suppress(Exception):
                snap_archive = await collector.get_messages_snapshot(str(room_uuid))  # type: ignore[attr-defined]
                if snap_archive:
                    _room_messages_archive[room_uuid] = list(snap_archive)
        # Кладём в кэш
        _room_summary_cache[room_uuid] = summary
        # Формируем набор целевых пользователей: инициатор или владельцы всех агентов
        targets: set[UUID] = set()
        if initiator_user_id:
            targets.add(initiator_user_id)
        else:
            for aid in _room_agents.get(room_uuid, set()):
                owner = _agent_owner.get(aid)
                if owner:
                    targets.add(owner)
        sent_any = False
        if settings.TELEGRAM_BOT_TOKEN and targets:
            for uid in targets:
                if uid in _room_summary_served[room_uuid]:
                    continue
                try:
                    chat_id = None
                    if session is not None:
                        chat_id = await get_confirmed_chat_id(session, uid)
                    if not chat_id:
                        print(f"[summary] Skip send personal user={initiator_user_id} room={original_room_id}: no chat_id")
                        continue
                    text = (
                        f"Room {summary.room_id} завершена (trigger={reason}). Источник: {'voice' if (v and v.text and not v.text.startswith('(no audio')) else 'chat'}. Сообщений: {summary.message_count}.\n--- Summary ---\n{summary.summary_text}"
                    )
                    await tg_send_message(text, chat_ids=[chat_id], session=session)
                    _room_summary_served[room_uuid].add(uid)
                    sent_any = True
                    print(f"[summary] Telegram sent user={uid} room={original_room_id} trigger={reason}")
                except Exception as e:
                    print(f"[summary] Telegram send failed user={uid} room={original_room_id} err={e}")
        if sent_any:
            _room_summary_finalized.add(room_uuid)
    else:
        # Fallback: даже если нет сообщений, отправим минимальное уведомление, чтобы пользователь понял что завершение состоялось
        print(f"[summary] Nothing to summarize room={original_room_id} trigger={reason} pre_count={pre_count}; sending minimal fallback.")
        if settings.TELEGRAM_BOT_TOKEN:
            try:
                minimal = (
                    f"Room {original_room_id} завершена (trigger={reason}). Сообщений не было или они не были зафиксированы."
                )
                chat_ids: list[str] | None = None
                if initiator_user_id and session is not None:
                    single = await get_confirmed_chat_id(session, initiator_user_id)
                    if single:
                        chat_ids = [single]
                await tg_send_message(minimal, chat_ids=chat_ids, session=session)
                print(f"[summary] Minimal fallback Telegram sent for room {original_room_id} trigger={reason}")
            except Exception as e:
                print(f"[summary] Minimal fallback Telegram send failed: {e}")
        # Финализируем чтобы не спамить при повторных попытках
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
        session: AsyncSession = Depends(get_db_session),
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

                # Если это AI агент – используем детерминированный UUID зависящий от комнаты и пользователя (если есть)
                if is_agent:
                    temp_account_uid: UUID | None = None
                    if token:
                        with contextlib.suppress(Exception):
                            payload = tokens.decode_token(token)
                            uid_str = payload.get("sub")
                            temp_account_uid = UUID(uid_str) if uid_str else None
                    if temp_account_uid:
                        conn_id = uuid5(NAMESPACE_URL, f"webcall:agent:{room_uuid}:{temp_account_uid}")
                    else:
                        conn_id = uuid5(NAMESPACE_URL, f"webcall:agent:{room_uuid}")  # fallback общий
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
                if account_uid:
                    _room_participant_users[room_uuid].add(account_uid)
                uname_base = (data.get("username") or real_name or ("AI AGENT" if is_agent else str(conn_id)[:8]))
                if is_agent and real_name:
                    uname = f"AI-{real_name}"[:32]
                else:
                    uname = uname_base
                _display_names[conn_id] = uname
                if is_agent:
                    _room_agents[room_uuid].add(conn_id)
                    if account_uid is not None:
                        _agent_owner[conn_id] = account_uid
                        # Фиксируем точку старта персонального окна для владельца агента (ms epoch)
                        import time as _t
                        _room_agent_start[(room_uuid, account_uid)] = int(_t.time()*1000)
                        # Регистрируем окно для новой архитектуры orchestrator
                        try:
                            orchestrator = get_summary_orchestrator()
                            await orchestrator.start_user_window(str(room_uuid), str(account_uid))
                        except Exception:
                            pass
                # broadcast presence list to room (with id->name map)
                members = [str(u) for u in sorted(_room_members[room_uuid], key=str)]
                names = { str(uid): _display_names.get(uid, str(uid)[:8]) for uid in _room_members[room_uuid] }
                agent_ids = [str(a) for a in sorted(_room_agents.get(room_uuid, set()), key=str)]
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
                    # Добавляем в персистентный лог
                    try:
                        from ...infrastructure.services.summary import ChatMessage as _CM
                        import time as _t
                        ts_now = int(_t.time()*1000)
                        _room_message_log[room_uuid].append(_CM(room_id=str(room_uuid), author_id=author_id, author_name=author_name, content=(content or "").strip(), ts=ts_now))
                        # Ограничим лог (хвост) до 2000 сообщений чтобы не рос бесконечно
                        if len(_room_message_log[room_uuid]) > 2000:
                            overflow = len(_room_message_log[room_uuid]) - 2000
                            if overflow > 0:
                                del _room_message_log[room_uuid][0:overflow]
                    except Exception:
                        pass
                    # summary_v2 лог
                    try:
                        orchestrator = get_summary_orchestrator()
                        orchestrator.add_chat(str(room_uuid), author_id, author_name, content or "")
                    except Exception:
                        pass

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
                    before_voice = None
                    with contextlib.suppress(Exception):
                        before_voice = await voice_coll.get_transcript(str(room_uuid)) or await voice_coll.get_transcript(room_id)
                        # user id инициатора попытки (если есть токен и нашли пользователя)
                        initiator_user_id = None
                        with contextlib.suppress(Exception):
                            if token:
                                payload = tokens.decode_token(token)
                                initiator_user_id = UUID(payload.get("sub")) if payload.get("sub") else None
                        await _generate_and_send_summary(room_uuid, room_id, "manual", ai_provider=ai_provider, collector=collector, voice_coll=voice_coll, session=session, initiator_user_id=initiator_user_id)
                    after_voice = None
                    with contextlib.suppress(Exception):
                        after_voice = await voice_coll.get_transcript(str(room_uuid)) or await voice_coll.get_transcript(room_id)
                    src = 'voice' if (before_voice or after_voice) else 'chat'
                    finalized = room_uuid in _room_summary_finalized
                    await websocket.send_json({"type": "agent_summary_ack", "status": "done" if finalized else "empty", "source": src, "finalized": finalized})
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
            # cleanup участника (по владельцу агента мы mapping не знаем — оставляем если другие соединения есть)
            # (упрощение: не удаляем из _room_participant_users до конца комнаты)
            # Если это агент — удаляем из структуры агентов
            with contextlib.suppress(Exception):
                if uid in _room_agents.get(room_uuid, set()):
                    _room_agents[room_uuid].remove(uid)
                    if not _room_agents[room_uuid]:
                        _room_agents.pop(room_uuid, None)
                    # Завершаем окно пользователя (если известен владелец)
                    try:
                        owner = _agent_owner.get(uid)
                        if owner:
                            orch = get_summary_orchestrator()
                            orch.end_user_window(str(room_uuid), str(owner))
                    except Exception:
                        pass
                # owner mapping
                if uid in _agent_owner:
                    _agent_owner.pop(uid, None)
            
            members = [str(u) for u in sorted(_room_members[room_uuid], key=str)]
            names = { str(mid): _display_names.get(UUID(mid), mid[:8]) if isinstance(mid, str) else _display_names.get(mid, str(mid)[:8]) for mid in _room_members[room_uuid] }
            agent_ids = [str(a) for a in sorted(_room_agents.get(room_uuid, set()), key=str)]
            for ws in list(_room_clients.get(room_uuid, set())):
                with contextlib.suppress(Exception):
                    await ws.send_json({"type": "presence", "users": members, "userNames": names, "agentIds": agent_ids})

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

        # Fallback: если все участники вышли и остался неотправленный транскрипт — попробуем авто summary (auto-orphan)
        try:
            remaining = len(_room_members.get(room_uuid, set()))
            if remaining == 0 and room_uuid not in _room_summary_finalized:
                # Проверяем есть ли транскрипт
                try:
                    vcheck = await voice_coll.get_transcript(str(room_uuid)) or await voice_coll.get_transcript(room_id)
                except Exception:
                    vcheck = None  # type: ignore
                if vcheck:
                    print(f"[summary] Orphan auto trigger room={room_id}")
                    await _generate_and_send_summary(room_uuid, room_id, 'auto-orphan', ai_provider=ai_provider, collector=collector, voice_coll=voice_coll)
        except Exception:
            pass
