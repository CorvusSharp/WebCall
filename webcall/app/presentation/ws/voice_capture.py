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
                await coll.add_chunk(room_id, chunk)
    except WebSocketDisconnect:
        pass
    finally:
        # Здесь позже запустим транскрипцию (асинхронно). Пока создадим заглушку.
        with contextlib.suppress(Exception):
            chunks = await coll.get_and_clear_chunks(room_id)
            if chunks:
                text = await transcribe_chunks(room_id, chunks)
            else:
                text = "(no audio chunks)"
            await coll.store_transcript(room_id, text)
        with contextlib.suppress(Exception):
            await ws.close(code=1000)
