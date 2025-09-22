from __future__ import annotations

import contextlib
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Depends
from ..api.deps.containers import get_token_provider
from ...core.ports.services import TokenProvider
from ...infrastructure.config import get_settings
from ...infrastructure.services.voice_transcript import get_voice_collector
from ...infrastructure.services.voice_transcript import (
    get_voice_collector,
    VoiceChunk,
    VoiceTranscript,
    transcribe_chunks,
)
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
    allow_unauth = settings.APP_ENV in {'dev','test'}
    await ws.accept()
    if token:
        try:
            tokens.decode_token(token)
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
    canonical_key = str(canonical_uuid)
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
                    # ignore data until start
                    continue
                chunk = msg['bytes']
                total_bytes += len(chunk)
                if total_bytes > settings.VOICE_MAX_TOTAL_MB * 1024 * 1024:
                    # превышение лимита
                    break
                await coll.add_chunk(canonical_key, chunk)
    except WebSocketDisconnect:
        pass
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
            else:
                text = "(no audio chunks)"
            await coll.store_transcript(canonical_key, text)
        with contextlib.suppress(Exception):
            await ws.close(code=1000)
