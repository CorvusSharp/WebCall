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
    started = False
    total_bytes = 0
    try:
        while True:
            msg = await ws.receive()
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
                elif t == 'stop':
                    break
            elif 'bytes' in msg and msg['bytes'] is not None:
                if not started:
                    # Автоматический имплицитный старт если клиент не отправил control frame
                    started = True
                    logger.debug("VOICE_CAPTURE implicit start room=%s (binary before explicit start)", room_id)
                chunk = msg['bytes']
                total_bytes += len(chunk)
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
            if chunks:
                logger.info("VOICE_CAPTURE finalize room=%s chunks=%s bytes=%s", room_id, len(chunks), sum(len(c.data) for c in chunks))
                text = await transcribe_chunks(canonical_key, chunks)
                try:
                    preview = (text or '')[:120].replace('\n',' ')
                    logger.info("VOICE_CAPTURE transcript room=%s preview=%r", room_id, preview)
                except Exception:
                    pass
                # Передаём транскрипт в orchestrator (summary_v2)
                try:
                    orch = get_summary_orchestrator()
                    cleaned = (text or '').strip()
                    low = cleaned.lower()
                    technical = (not cleaned) or low.startswith('(no audio') or low.startswith('(asr failed') or low.startswith('(asr exception') or low.startswith('(asr disabled')
                    if user_id and cleaned:
                        if technical:
                            logger.debug("VOICE_CAPTURE skip technical transcript attach room=%s user=%s raw=%r", room_id, user_id, cleaned[:80])
                        else:
                            orch.add_voice_transcript(base_room_key, cleaned, user_id=user_id)
                except Exception:
                    pass
            else:
                text = "(no audio chunks)"
                logger.info("VOICE_CAPTURE finalize empty room=%s reason=no_chunks", room_id)
            await coll.store_transcript(canonical_key, text)
        with contextlib.suppress(Exception):
            await ws.close(code=1000)
