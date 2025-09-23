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
        # TTL (мс) для готовых транскриптов и сырых чанков (если вдруг не финализировали) — предотвращает накопление старых данных.
        self._transcript_ttl_ms = 5 * 60 * 1000  # 5 минут
        self._chunk_ttl_ms = 5 * 60 * 1000

    def _purge_expired_unlocked(self, now_ms: int) -> None:
        # Очистка транскриптов
        to_del = [k for k, v in self._transcripts.items() if (now_ms - v.generated_at) > self._transcript_ttl_ms]
        for k in to_del:
            self._transcripts.pop(k, None)
        # Очистка сырых чанков (по таймстемпу первого чанка)
        stale_chunks = []
        for k, lst in self._chunks.items():
            if lst and (now_ms - lst[0].ts) > self._chunk_ttl_ms:
                stale_chunks.append(k)
        for k in stale_chunks:
            self._chunks.pop(k, None)

    async def add_chunk(self, room_key: str, data: bytes) -> None:
        async with self._lock:
            now_ms = int(time.time()*1000)
            self._purge_expired_unlocked(now_ms)
            self._chunks.setdefault(room_key, []).append(VoiceChunk(ts=now_ms, data=data))

    async def get_and_clear_chunks(self, room_key: str) -> list[VoiceChunk]:
        async with self._lock:
            now_ms = int(time.time()*1000)
            self._purge_expired_unlocked(now_ms)
            chunks = self._chunks.pop(room_key, [])
            return chunks

    async def store_transcript(self, room_key: str, text: str) -> VoiceTranscript:
        vt = VoiceTranscript(room_id=room_key, text=text, generated_at=int(time.time()*1000))
        async with self._lock:
            now_ms = vt.generated_at
            self._purge_expired_unlocked(now_ms)
            self._transcripts[room_key] = vt
        return vt

    async def pop_transcript(self, room_key: str) -> VoiceTranscript | None:
        async with self._lock:
            now_ms = int(time.time()*1000)
            self._purge_expired_unlocked(now_ms)
            return self._transcripts.pop(room_key, None)

    async def get_transcript(self, room_key: str) -> VoiceTranscript | None:
        """Вернёт транскрипт без удаления (для повторной проверки готовности)."""
        async with self._lock:
            now_ms = int(time.time()*1000)
            self._purge_expired_unlocked(now_ms)
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
