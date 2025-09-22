from __future__ import annotations

"""In-memory хранилище голосовых чанков и транскриптов."""

from dataclasses import dataclass
from typing import List, Dict
import io
import httpx
from .ai_provider import OpenAIAIProvider  # type: ignore
from ..config import get_settings
from asyncio import Lock
import time


@dataclass
class VoiceChunk:
    ts: int
    data: bytes


@dataclass
class VoiceTranscript:
    room_id: str
    text: str
    generated_at: int


class VoiceTranscriptCollector:
    def __init__(self) -> None:
        # Ключ: (room_id,user_id) если user_id известен; иначе room_id как fallback (legacy). Пользовательский скоп обязателен для корректной персональной сегрегации.
        self._chunks: Dict[str, list[VoiceChunk]] = {}
        self._transcripts: Dict[str, VoiceTranscript] = {}
        self._lock = Lock()

    async def add_chunk(self, room_key: str, data: bytes) -> None:
        async with self._lock:
            self._chunks.setdefault(room_key, []).append(VoiceChunk(ts=int(time.time()*1000), data=data))

    async def get_and_clear_chunks(self, room_key: str) -> list[VoiceChunk]:
        async with self._lock:
            chunks = self._chunks.pop(room_key, [])
            return chunks

    async def store_transcript(self, room_key: str, text: str) -> VoiceTranscript:
        vt = VoiceTranscript(room_id=room_key, text=text, generated_at=int(time.time()*1000))
        async with self._lock:
            self._transcripts[room_key] = vt
        return vt

    async def pop_transcript(self, room_key: str) -> VoiceTranscript | None:
        async with self._lock:
            return self._transcripts.pop(room_key, None)

    async def get_transcript(self, room_key: str) -> VoiceTranscript | None:
        """Вернёт транскрипт без удаления (для повторной проверки готовности)."""
        async with self._lock:
            return self._transcripts.get(room_key)


_voice_collector_singleton: VoiceTranscriptCollector | None = None


def get_voice_collector() -> VoiceTranscriptCollector:
    global _voice_collector_singleton
    if _voice_collector_singleton is None:
        _voice_collector_singleton = VoiceTranscriptCollector()
    return _voice_collector_singleton


async def transcribe_chunks(room_id: str, chunks: list[VoiceChunk]) -> str:
    """Отправить собранные webm opus чанки в OpenAI Whisper и вернуть текст.

    MVP: склеиваем в один webm. Если нет ключа или выключено — возвращаем placeholder.
    """
    settings = get_settings()
    if not settings.OPENAI_API_KEY:
        return "(asr disabled: no OPENAI_API_KEY)"
    # Склейка
    bio = io.BytesIO()
    for ch in chunks:
        bio.write(ch.data)
    bio.seek(0)
    files = {
        'file': ('audio.webm', bio.read(), 'audio/webm'),
    }
    data = {
        'model': settings.VOICE_ASR_MODEL or 'whisper-1',
        'response_format': 'text'
    }
    headers = { 'Authorization': f'Bearer {settings.OPENAI_API_KEY}' }
    url = 'https://api.openai.com/v1/audio/transcriptions'
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(url, data=data, files=files, headers=headers)
            if r.status_code == 200:
                return r.text.strip()
            return f"(asr failed http {r.status_code})"
    except Exception as e:  # pragma: no cover
        return f"(asr exception {e.__class__.__name__})"
