from __future__ import annotations
"""Персональная сессия AI агента пользователя.

Каждый пользователь в рамках комнаты получает независимую сессию:
 - фиксируется момент старта (start_ts)
 - опционально фиксируется момент остановки (end_ts)
 - накапливаются только сообщения пришедшие после старта и до остановки
 - голосовая транскрипция хранится отдельно (последняя валидная, не техническая)

Так мы избегаем ситуации когда второй пользователь видит расшифровку/summary
первого: их источники данных отделены.
"""
from dataclasses import dataclass, field
from typing import List, Optional
import time, re
from .models import ChatMessage, SummaryResult, TECHNICAL_PATTERNS
from .strategies import ChatStrategy, CombinedVoiceChatStrategy


def _is_technical_text(text: str) -> bool:
    low = text.lower().strip()
    if not low:
        return True
    for p in TECHNICAL_PATTERNS:
        if p in low:
            return True
    return False


@dataclass
class UserAgentSession:
    room_id: str
    user_id: str
    start_ts: int = field(default_factory=lambda: int(time.time()*1000))
    end_ts: Optional[int] = None
    _messages: List[ChatMessage] = field(default_factory=list)  # только пользовательское окно
    _voice_text: Optional[str] = None  # последняя валидная voice транскрипция
    _chat_strategy: ChatStrategy = field(default_factory=ChatStrategy, init=False, repr=False)
    _combined_strategy: CombinedVoiceChatStrategy = field(default_factory=CombinedVoiceChatStrategy, init=False, repr=False)

    def add_chat(self, msg: ChatMessage) -> None:
        """Добавляет сообщение если оно попадает в окно сессии."""
        if msg.room_id != self.room_id:
            return
        if msg.ts < self.start_ts:
            return
        if self.end_ts is not None and msg.ts > self.end_ts:
            return
        self._messages.append(msg)

    def add_voice_transcript(self, transcript: str) -> None:
        if not transcript:
            return
        txt = transcript.strip()
        if not txt:
            return
        # Если текст технический — игнорируем только если уже есть нормальный
        if _is_technical_text(txt):
            if self._voice_text and not _is_technical_text(self._voice_text):
                return
        self._voice_text = txt

    def stop(self) -> None:
        if self.end_ts is None:
            self.end_ts = int(time.time()*1000)

    async def build_summary(self, *, ai_provider, system_prompt: str | None) -> SummaryResult:
        # Отфильтруем по end_ts если окно завершено (теоретически могли добавить позже)
        msgs = [m for m in self._messages if (self.end_ts is None or m.ts <= self.end_ts)]
        voice_text = self._voice_text
        # Если чат пуст, но есть валидный voice
        if not msgs:
            if voice_text and len(voice_text.strip()) > 10 and not _is_technical_text(voice_text):
                norm = re.sub(r"\s+", " ", voice_text.strip())
                parts = re.split(r'(?<=[.!?])\s+', norm)
                sentences = [p.strip() for p in parts if p.strip()]
                if not sentences:
                    sentences = [voice_text.strip()]
                now_ms = int(time.time()*1000)
                voice_msgs = [ChatMessage(room_id=self.room_id, author_id=None, author_name='voice', content=s, ts=now_ms) for s in sentences]
                return await self._combined_strategy.build(voice_msgs, ai_provider=ai_provider, system_prompt=system_prompt)
            return SummaryResult.empty(self.room_id)
        # Если все чат сообщения технические, но есть нормальный voice — используем его
        non_tech = [m for m in msgs if not _is_technical_text(m.content)]
        if not non_tech and voice_text and len(voice_text.strip()) > 10 and not _is_technical_text(voice_text):
            norm = re.sub(r"\s+", " ", voice_text.strip())
            parts = re.split(r'(?<=[.!?])\s+', norm)
            sentences = [p.strip() for p in parts if p.strip()]
            if not sentences:
                sentences = [voice_text.strip()]
            now_ms = int(time.time()*1000)
            voice_msgs = [ChatMessage(room_id=self.room_id, author_id=None, author_name='voice', content=s, ts=now_ms) for s in sentences]
            return await self._combined_strategy.build(voice_msgs, ai_provider=ai_provider, system_prompt=system_prompt)
        # Комбинированный путь если voice информативный
        merged = msgs
        strategy = self._chat_strategy
        if voice_text and len(voice_text.strip()) > 10 and not _is_technical_text(voice_text):
            norm = re.sub(r"\s+", " ", voice_text.strip())
            parts = re.split(r'(?<=[.!?])\s+', norm)
            sentences = [p.strip() for p in parts if p.strip()]
            if not sentences:
                sentences = [voice_text.strip()]
            now_ms = int(time.time()*1000)
            voice_msgs = [ChatMessage(room_id=self.room_id, author_id=None, author_name='voice', content=s, ts=now_ms) for s in sentences]
            merged = msgs + voice_msgs
            strategy = self._combined_strategy
        return await strategy.build(merged, ai_provider=ai_provider, system_prompt=system_prompt)
