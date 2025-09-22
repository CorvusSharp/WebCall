from __future__ import annotations
from typing import Dict, Tuple, List
import time, contextlib
from .message_log import MessageLog
from .models import SummaryResult, ChatMessage, TECHNICAL_PATTERNS
from .strategies import ChatStrategy, CombinedVoiceChatStrategy
from ...config import get_settings
from ..ai_provider import get_user_system_prompt


class SummaryOrchestrator:
    def __init__(self) -> None:
        self._log = MessageLog()
        # (room_id, user_id) -> start_ts
        self._user_windows: Dict[Tuple[str, str], int] = {}
        # voice transcripts stored temporarily: room_id -> text
        self._voice_buffer: Dict[str, str] = {}
        self._chat_strategy = ChatStrategy()
        self._combined_strategy = CombinedVoiceChatStrategy()

    def add_chat(self, room_id: str, author_id: str | None, author_name: str | None, content: str) -> None:
        self._log.add(room_id, author_id, author_name, content)

    def add_voice_transcript(self, room_id: str, transcript: str) -> None:
        if not transcript:
            return
        txt = transcript.strip()
        if not txt:
            return
        low = txt.lower()
        is_tech = any(p in low for p in TECHNICAL_PATTERNS)
        # Если уже хранится нормальный (не технический) текст — не затираем его техническим
        if is_tech:
            current = self._voice_buffer.get(room_id)
            if current:
                cur_low = current.lower()
                # если текущий не технический — игнорируем новый технический
                if not any(p in cur_low for p in TECHNICAL_PATTERNS):
                    return
        # Иначе сохраняем (обычный перезаписывает технический)
        self._voice_buffer[room_id] = txt

    def start_user_window(self, room_id: str, user_id: str) -> None:
        self._user_windows[(room_id, user_id)] = int(time.time()*1000)

    async def build_personal_summary(self, *, room_id: str, user_id: str, ai_provider, db_session) -> SummaryResult:
        settings = get_settings()
        start_ts = self._user_windows.get((room_id, user_id))
        msgs = self._log.slice_since(room_id, start_ts)
        voice_text = self._voice_buffer.get(room_id)
        # Voice-only путь: если нет чат сообщений, но есть валидный voice
        if not msgs:
            if voice_text and len(voice_text.strip()) > 10:
                low = voice_text.lower()
                if not any(p in low for p in TECHNICAL_PATTERNS):
                    # создаём псевдо сообщения только из voice
                    import re
                    norm = re.sub(r"\s+", " ", voice_text.strip())
                    parts = re.split(r'(?<=[.!?])\s+', norm)
                    sentences = [p.strip() for p in parts if p.strip()]
                    if not sentences:
                        sentences = [voice_text.strip()]
                    now_ms = int(time.time()*1000)
                    voice_msgs = [ChatMessage(room_id=room_id, author_id=None, author_name='voice', content=s, ts=now_ms) for s in sentences]
                    strategy = self._combined_strategy
                    result = await strategy.build(voice_msgs, ai_provider=ai_provider, system_prompt=None)
                    return result
            return SummaryResult.empty(room_id)
        # Если все сообщения технические, но есть валидный voice — используем voice
        non_tech = [m for m in msgs if not any(p in m.content.lower() for p in TECHNICAL_PATTERNS)]
        if not non_tech and voice_text and len(voice_text.strip()) > 10:
            low = voice_text.lower()
            if not any(p in low for p in TECHNICAL_PATTERNS):
                import re
                norm = re.sub(r"\s+", " ", voice_text.strip())
                parts = re.split(r'(?<=[.!?])\s+', norm)
                sentences = [p.strip() for p in parts if p.strip()]
                if not sentences:
                    sentences = [voice_text.strip()]
                now_ms = int(time.time()*1000)
                voice_msgs = [ChatMessage(room_id=room_id, author_id=None, author_name='voice', content=s, ts=now_ms) for s in sentences]
                strategy = self._combined_strategy
                result = await strategy.build(voice_msgs, ai_provider=ai_provider, system_prompt=None)
                return result
        # voice? добавим как pseudo message list только если достаточно информативно
        merged: List[ChatMessage]
        if voice_text and len(voice_text.strip()) > 10:
            # Разбиваем на предложения (простая эвристика)
            import re
            norm = re.sub(r"\s+", " ", voice_text.strip())
            parts = re.split(r'(?<=[.!?])\s+', norm)
            sentences = [p.strip() for p in parts if p.strip()]
            if not sentences:
                sentences = [voice_text.strip()]
            now_ms = int(time.time()*1000)
            voice_msgs = [ChatMessage(room_id=room_id, author_id=None, author_name='voice', content=s, ts=now_ms) for s in sentences]
            merged = msgs + voice_msgs
            strategy = self._combined_strategy
        else:
            merged = msgs
            strategy = self._chat_strategy
        system_prompt: str | None = None
        if db_session is not None:
            with contextlib.suppress(Exception):
                system_prompt = await get_user_system_prompt(db_session, user_id)
        result = await strategy.build(merged, ai_provider=ai_provider, system_prompt=system_prompt)
        return result

# singleton accessor
_orchestrator_singleton: SummaryOrchestrator | None = None

def get_summary_orchestrator() -> SummaryOrchestrator:
    global _orchestrator_singleton
    if _orchestrator_singleton is None:
        _orchestrator_singleton = SummaryOrchestrator()
    return _orchestrator_singleton
