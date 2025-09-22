from __future__ import annotations
from typing import Dict, Tuple, List
import time, contextlib
from .message_log import MessageLog
from .models import SummaryResult, ChatMessage
from .strategies import ChatStrategy, CombinedVoiceChatStrategy
from ...infrastructure.config import get_settings
from ...infrastructure.services.ai_provider import get_user_system_prompt


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
        self._voice_buffer[room_id] = transcript

    def start_user_window(self, room_id: str, user_id: str) -> None:
        self._user_windows[(room_id, user_id)] = int(time.time()*1000)

    async def build_personal_summary(self, *, room_id: str, user_id: str, ai_provider, db_session) -> SummaryResult:
        settings = get_settings()
        start_ts = self._user_windows.get((room_id, user_id))
        # Срез сообщений с момента подключения агента пользователя
        msgs = self._log.slice_since(room_id, start_ts)
        if not msgs:
            return SummaryResult.empty(room_id)
        # voice? добавим как pseudo message list только если достаточно информативно
        voice_text = self._voice_buffer.get(room_id)
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
