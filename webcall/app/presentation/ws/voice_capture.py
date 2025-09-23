from __future__ import annotations

import contextlib
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends
from ..api.deps.containers import get_token_provider
from ...core.ports.services import TokenProvider
from ...infrastructure.config import get_settings
from ...infrastructure.services.voice_transcript import get_voice_collector, transcribe_chunks
from ...infrastructure.services.summary_v2.orchestrator import get_summary_orchestrator
from uuid import UUID, uuid5, NAMESPACE_URL
import logging

logger = logging.getLogger(__name__)

router = APIRouter()


@router.websocket('/ws/voice_capture/{room_id}')
async def ws_voice_capture(ws: WebSocket, room_id: str, tokens: TokenProvider = Depends(get_token_provider)):
    settings = get_settings()
    if not settings.VOICE_CAPTURE_ENABLED:
        await ws.close(code=4403, reason='Voice capture disabled')
        return
    token = ws.query_params.get('token')
    user_id: str | None = None
    allow_unauth = settings.APP_ENV in {'dev','test'}
    await ws.accept()
    if token:
        try:
            payload = tokens.decode_token(token)
            user_id = payload.get('sub') if isinstance(payload, dict) else None
        except Exception:
            if not allow_unauth:
                await ws.close(code=4401, reason='Unauthorized')
                return
    else:
        if not allow_unauth:
            await ws.close(code=4401, reason='Unauthorized')
            return

    coll = get_voice_collector()
    # Преобразуем room_id в канонический UUID (так же как в rooms.py), чтобы ключи совпадали
    try:
        canonical_uuid = UUID(room_id)
    except Exception:
        canonical_uuid = uuid5(NAMESPACE_URL, f"webcall:{room_id}")
    base_room_key = str(canonical_uuid)
    # Персональный ключ для хранения чанков: room + ':' + user (если присутствует)
    if user_id:
        canonical_key = f"{base_room_key}:{user_id}"
    else:
        canonical_key = base_room_key
    # Сессионные параметры (client → server)
    started = False
    session_id: int | None = None  # порядковый номер сессии (клиентский)
    client_start_ts: int | None = None  # ts из control frame start (клиент)
    start_control_ts: int | None = None  # когда получили start (control или implicit)
    first_chunk_ts: int | None = None
    last_chunk_ts: int | None = None
    total_bytes = 0
    control_start_count = 0
    control_stop_count = 0
    binary_frames = 0
    ignored_early_stops = 0
    loop_iterations = 0
    import time as _t
    accept_ts = int(_t.time()*1000)
    GRACE_AFTER_STOP_MS = 1800  # максимум ждём после stop первый бинарный чанк
    NO_AUDIO_WARN_MS = 2500     # после старта если нет бинарных — шлём предупреждение
    last_warn_sent = False
    stop_requested_ts: int | None = None
    import asyncio
    try:
        while True:
            # Если был stop и ещё нет чанков — ждём ограниченный grace
            if stop_requested_ts and total_bytes == 0:
                now_ms = int(_t.time()*1000)
                if now_ms - stop_requested_ts > GRACE_AFTER_STOP_MS:
                    logger.debug("VOICE_CAPTURE grace timeout after stop room=%s", room_id)
                    break
            # Таймаут чтения чтобы можно было слать no-audio уведомление
            try:
                msg = await asyncio.wait_for(ws.receive(), timeout=1.0)
            except asyncio.TimeoutError:
                # периодический тик
                now_ms = int(_t.time()*1000)
                if started and first_chunk_ts is None and not last_warn_sent and start_control_ts and (now_ms - start_control_ts) > NO_AUDIO_WARN_MS:
                    # Отправим диагностическое сообщение клиенту
                    with contextlib.suppress(Exception):
                        await ws.send_json({"type": "no-audio", "message": "Нет аудиоданных: проверьте доступ к микрофону"})
                    last_warn_sent = True
                    logger.debug("VOICE_CAPTURE warn no-audio room=%s user=%s", room_id, user_id)
                continue
            except RuntimeError:
                # Клиент уже отключился (disconnect получен) — выходим из цикла без stacktrace
                logger.debug("VOICE_CAPTURE receive after disconnect room=%s user=%s", room_id, user_id)
                break
            loop_iterations += 1
            if 'text' in msg and msg['text'] is not None:
                # control frame
                import json
                try:
                    data = json.loads(msg['text'])
                except Exception:
                    continue
                t = data.get('type')
                if t == 'start':
                    started = True
                    import time as _t
                    start_control_ts = int(_t.time()*1000)
                    control_start_count += 1
                    session_id = data.get('session') if isinstance(data.get('session'), int) else None
                    client_start_ts = data.get('ts') if isinstance(data.get('ts'), int) else None
                    logger.debug("VOICE_CAPTURE control start room=%s user=%s session_id=%s client_ts=%s", room_id, user_id, session_id, client_start_ts)
                elif t == 'stop':
                    # Защита: если ещё нет чанков и старт был совсем недавно — игнорируем одиночный stop (например клиент мгновенно пересоздал MediaRecorder)
                    import time as _t
                    now_ms = int(_t.time()*1000)
                    if total_bytes == 0 and started and start_control_ts and (now_ms - start_control_ts) < 800:
                        ignored_early_stops += 1
                        logger.debug("VOICE_CAPTURE ignore early stop (no chunks) room=%s delta_ms=%s", room_id, now_ms - start_control_ts)
                        continue
                    control_stop_count += 1
                    logger.debug("VOICE_CAPTURE control stop room=%s user=%s bytes=%s", room_id, user_id, total_bytes)
                    # Не выходим сразу: ждём grace, если ещё нет чанков
                    if total_bytes == 0:
                        stop_requested_ts = now_ms
                        continue
                    break
            elif 'bytes' in msg and msg['bytes'] is not None:
                if not started:
                    # Автоматический имплицитный старт если клиент не отправил control frame
                    started = True
                    import time as _t
                    start_control_ts = int(_t.time()*1000)
                    logger.debug("VOICE_CAPTURE implicit start room=%s user=%s (binary before explicit start) session_id=%s", room_id, user_id, session_id)
                chunk = msg['bytes']
                total_bytes += len(chunk)
                binary_frames += 1
                if first_chunk_ts is None:
                    import time as _t
                    first_chunk_ts = int(_t.time()*1000)
                    logger.debug("VOICE_CAPTURE first chunk room=%s user=%s size=%s", room_id, user_id, len(chunk))
                import time as _t
                last_chunk_ts = int(_t.time()*1000)
                if total_bytes > settings.VOICE_MAX_TOTAL_MB * 1024 * 1024:
                    # превышение лимита
                    break
                await coll.add_chunk(canonical_key, chunk)
    except WebSocketDisconnect:
        logger.debug("VOICE_CAPTURE disconnect room=%s started=%s bytes=%s", room_id, started, total_bytes)
    finally:
        # Финализируем: транскрипция и сохранение. Если нет чанков — пропускаем.
        with contextlib.suppress(Exception):
            chunks = await coll.get_and_clear_chunks(canonical_key)
            finalize_ts = int(__import__('time').time()*1000)
            text: str
            had_chunks = bool(chunks)
            if had_chunks:
                logger.info("VOICE_CAPTURE finalize room=%s chunks=%s bytes=%s", room_id, len(chunks), sum(len(c.data) for c in chunks))
                raw_text = await transcribe_chunks(canonical_key, chunks)
                cleaned = (raw_text or '').strip()
                try:
                    preview = cleaned[:120].replace('\n',' ')
                    logger.info("VOICE_CAPTURE transcript room=%s preview=%r", room_id, preview)
                except Exception:
                    pass
                # Авто-триггер персонального summary (v2) если есть user_id и включён флаг USE_SUMMARY_V2
                try:
                    import os, asyncio as _aio
                    use_v2 = os.getenv("USE_SUMMARY_V2", "1").lower() not in {"0","false","no"}
                    if user_id and use_v2 and cleaned and not cleaned.startswith('(no audio') and not cleaned.startswith('(asr '):
                        # Отложим чуть, чтобы orchestrator успел прикрепить сегмент
                        async def _delayed_trigger():
                            try:
                                from .rooms import _generate_and_send_summary  # type: ignore
                                from ...infrastructure.services.summary import get_summary_collector
                                from ...infrastructure.services.voice_transcript import get_voice_collector as _gvc
                                from ...infrastructure.services.ai_provider import get_ai_provider as _gap
                                from sqlalchemy.ext.asyncio import AsyncSession
                                # Попытка получить активный db session невозможна отсюда напрямую — авто-режим без session
                                await _aio.sleep(0.4)
                                try:
                                    coll2 = get_summary_collector()
                                except Exception:
                                    coll2 = None
                                try:
                                    vc2 = _gvc()
                                except Exception:
                                    vc2 = None
                                ai_p = _gap()
                                # Определяем канонический UUID как в rooms.py
                                try:
                                    canonical_uuid2 = UUID(room_id)
                                except Exception:
                                    canonical_uuid2 = uuid5(NAMESPACE_URL, f"webcall:{room_id}")
                                # initiator_user_id как UUID
                                u_uuid = None
                                try:
                                    u_uuid = UUID(user_id)
                                except Exception:
                                    pass
                                if u_uuid:
                                    await _generate_and_send_summary(canonical_uuid2, room_id, "auto-voice", ai_provider=_gap(), collector=coll2, voice_coll=vc2, session=None, initiator_user_id=u_uuid)
                            except Exception:
                                logger.debug("VOICE_CAPTURE auto-summary trigger failed room=%s", room_id, exc_info=True)
                        _ = _aio.create_task(_delayed_trigger())
                except Exception:
                    logger.debug("VOICE_CAPTURE auto-summary scheduling failed room=%s", room_id, exc_info=True)
            else:
                cleaned = "(no audio chunks)"
                try:
                    now_ms = finalize_ts
                    delta_start = (now_ms - start_control_ts) if start_control_ts else None
                    logger.info(
                        "VOICE_CAPTURE finalize empty room=%s reason=no_chunks delta_start=%s started=%s ctrl_start=%s ctrl_stop=%s bin_frames=%s ignored_stops=%s loops=%s lifetime_ms=%s grace_after_stop_ms=%s warn_sent=%s",
                        room_id,
                        delta_start,
                        started,
                        control_start_count,
                        control_stop_count,
                        binary_frames,
                        ignored_early_stops,
                        loop_iterations,
                        now_ms - accept_ts,
                        (now_ms - stop_requested_ts) if stop_requested_ts else None,
                        last_warn_sent,
                    )
                except Exception:
                    logger.info("VOICE_CAPTURE finalize empty room=%s reason=no_chunks", room_id)
            # Формируем мету (всегда)
            meta_parts = [f"captureTs={finalize_ts}"]
            if session_id is not None:
                meta_parts.append(f"session={session_id}")
            if client_start_ts is not None:
                meta_parts.append(f"clientTs={client_start_ts}")
            if start_control_ts is not None:
                meta_parts.append(f"startCtrlTs={start_control_ts}")
            meta_prefix = "[meta " + " ".join(meta_parts) + "] "
            text = meta_prefix + cleaned
            # Сохраняем ТОЛЬКО персонально если есть user_id, иначе под room (групповая логика) — мета уже есть
            store_key = canonical_key
            await coll.store_transcript(store_key, text)
            # Немедленно прикрепляем в orchestrator если есть содержательный текст
            try:
                if user_id and cleaned and not cleaned.startswith('(no audio') and not cleaned.startswith('(asr '):
                    orch = get_summary_orchestrator()
                    orch.add_voice_transcript(base_room_key, text, user_id=user_id)
            except Exception:
                logger.debug("VOICE_CAPTURE orchestrator attach failed room=%s", room_id, exc_info=True)
        with contextlib.suppress(Exception):
            await ws.close(code=1000)
