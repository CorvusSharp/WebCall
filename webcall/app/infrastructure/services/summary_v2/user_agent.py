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
from .models import ChatMessage, SummaryResult, TECHNICAL_PATTERNS, ParticipantSummary
import logging

logger = logging.getLogger(__name__)
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
    # Список голосовых сегментов (в порядке поступления). Поддерживает несколько записей.
    _voice_segments: List[str] = field(default_factory=list)
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
        """Добавить транскрипт.

        Правила:
        - Пустые строки игнорируются.
        - Технические плейсхолдеры добавляются только если ещё нет ни одного нетехнического текста.
        - Если новый нетехнический сегмент является надстройкой предыдущего (содержит его целиком) — заменяем последний.
        - Дубликаты игнорируем.
        """
        if not transcript:
            return
        txt = transcript.strip()
        if not txt:
            return
        is_tech = _is_technical_text(txt)
        if is_tech:
            if any(not _is_technical_text(s) for s in self._voice_segments):
                return
            if self._voice_segments and self._voice_segments[-1] == txt:
                return
            self._voice_segments.append(txt)
            return
        # Нормальный текст
        if self._voice_segments:
            last = self._voice_segments[-1]
            # last subset of new -> replace; new subset of last -> ignore; identical -> ignore
            if txt == last or (len(txt) < len(last) and txt in last):
                return
            if len(txt) > len(last) and last in txt and not _is_technical_text(last):
                self._voice_segments[-1] = txt
                return
        self._voice_segments.append(txt)


    def merged_voice_text(self) -> Optional[str]:
        if not self._voice_segments:
            return None
        non_tech = [s for s in self._voice_segments if not _is_technical_text(s)]
        base = non_tech if non_tech else self._voice_segments
        return " \n".join(base)

    def stop(self) -> None:
        if self.end_ts is None:
            self.end_ts = int(time.time()*1000)

    async def build_summary(self, *, ai_provider, system_prompt: str | None) -> SummaryResult:
        # Отфильтруем по end_ts если окно завершено (теоретически могли добавить позже)
        msgs = [m for m in self._messages if (self.end_ts is None or m.ts <= self.end_ts)]
        voice_text = self.merged_voice_text()
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
                logger.info("summary_v2: voice-only summary room=%s user=%s parts=%s", self.room_id, self.user_id, len(voice_msgs))
                # Стратегия уже добавит breakdown (она использует CombinedVoiceChatStrategy -> strategies)
                return await self._combined_strategy.build(voice_msgs, ai_provider=ai_provider, system_prompt=system_prompt)
            # Только технический или слишком короткий voice
            if voice_text and _is_technical_text(voice_text):
                return SummaryResult(room_id=self.room_id, message_count=0, generated_at=int(time.time()*1000), summary_text="Речь не распознана или пуста. Повторите попытку.", sources=[], used_voice=False)
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
            logger.info("summary_v2: voice-only (chat technical) summary room=%s user=%s parts=%s", self.room_id, self.user_id, len(voice_msgs))
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
            logger.info("summary_v2: combined voice+chat summary room=%s user=%s chat_msgs=%s voice_parts=%s", self.room_id, self.user_id, len(msgs), len(voice_msgs))
        return await strategy.build(merged, ai_provider=ai_provider, system_prompt=system_prompt)
