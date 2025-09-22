from __future__ import annotations
from typing import List, Optional
from .models import ChatMessage, SummaryResult, is_technical
from ...config import get_settings
import time


class BaseStrategy:
    async def build(self, msgs: List[ChatMessage], *, ai_provider, system_prompt: str | None) -> SummaryResult:
        raise NotImplementedError

    def _fallback(self, msgs: List[ChatMessage], *, prefix: str = "") -> str:
        if not msgs:
            return "Нет сообщений для суммаризации."
        tail = msgs[-10:]
        lines = [m.to_plain() for m in tail]
        body = "\n".join(lines)
        return (prefix + "\n" if prefix else "") + "Краткая выжимка:\n" + body


class ChatStrategy(BaseStrategy):
    async def build(self, msgs: List[ChatMessage], *, ai_provider, system_prompt: str | None) -> SummaryResult:
        settings = get_settings()
        user_msgs = [m for m in msgs if not is_technical(m)]
        if not user_msgs:
            return SummaryResult.empty(msgs[0].room_id if msgs else "unknown")
        plain = [m.to_plain() for m in user_msgs]
        total_chars = sum(len(m.content) for m in user_msgs)
        min_chars = getattr(settings, 'AI_SUMMARY_MIN_CHARS', 0) or 0
        summary_text: str
        if ai_provider and settings.AI_SUMMARY_ENABLED and (total_chars >= min_chars):
            try:
                try:
                    summary_text = await ai_provider.generate_summary(plain, system_prompt)  # type: ignore
                except TypeError:
                    summary_text = await ai_provider.generate_summary(plain)  # type: ignore
            except Exception as e:
                summary_text = self._fallback(user_msgs, prefix=f"[AI error: {e}]")
        else:
            if total_chars < min_chars:
                prefix = f"Слишком мало текста ({total_chars} < {min_chars})."
            else:
                prefix = "AI отключён."
            summary_text = self._fallback(user_msgs, prefix=prefix)
        # append sources (последние user сообщения без тех)
        tail_src = user_msgs[-5:]
        if tail_src:
            summary_text = summary_text.rstrip() + "\n\nИсточники (последние):\n" + "\n".join(m.content for m in tail_src)
        return SummaryResult(room_id=user_msgs[0].room_id, message_count=len(user_msgs), generated_at=int(time.time()*1000), summary_text=summary_text, sources=tail_src)


class CombinedVoiceChatStrategy(BaseStrategy):
    async def build(self, msgs: List[ChatMessage], *, ai_provider, system_prompt: str | None) -> SummaryResult:
        # msgs уже включает voice pseudo messages + chat
        chat_part = [m for m in msgs if not is_technical(m)]
        if not chat_part:
            return SummaryResult.empty(msgs[0].room_id if msgs else "unknown")
        settings = get_settings()
        plain = [m.to_plain() for m in chat_part]
        total_chars = sum(len(m.content) for m in chat_part)
        min_chars = getattr(settings, 'AI_SUMMARY_MIN_CHARS', 0) or 0
        summary_text: str
        if ai_provider and settings.AI_SUMMARY_ENABLED and total_chars >= min_chars:
            try:
                try:
                    summary_text = await ai_provider.generate_summary(plain, system_prompt)  # type: ignore
                except TypeError:
                    summary_text = await ai_provider.generate_summary(plain)  # type: ignore
            except Exception as e:
                summary_text = self._fallback(chat_part, prefix=f"[AI error: {e}]")
        else:
            if total_chars < min_chars:
                prefix = f"Слишком мало текста ({total_chars} < {min_chars})."
            else:
                prefix = "AI отключён."
            summary_text = self._fallback(chat_part, prefix=prefix)
        tail_src = chat_part[-5:]
        if tail_src:
            summary_text = summary_text.rstrip() + "\n\nИсточники (последние):\n" + "\n".join(m.content for m in tail_src)
        return SummaryResult(room_id=chat_part[0].room_id, message_count=len(chat_part), generated_at=int(time.time()*1000), summary_text=summary_text, sources=tail_src, used_voice=True)
