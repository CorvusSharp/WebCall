from __future__ import annotations
from typing import List, Optional
from .models import ChatMessage, SummaryResult, is_technical, ParticipantSummary
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


def _build_participant_breakdown(msgs: List[ChatMessage]) -> List[ParticipantSummary]:
    """Группирует сообщения по (author_id, author_name) и формирует короткую выборку.

    Правила:
    - Игнорируем технические сообщения.
    - Для каждого участника берём последние до 5 сообщений как sample.
    - Сортировка по убыванию количества сообщений, затем по имени.
    """
    buckets: dict[tuple[str | None, str | None], List[ChatMessage]] = {}
    for m in msgs:
        if is_technical(m):
            continue
        key = (m.author_id, m.author_name)
        buckets.setdefault(key, []).append(m)
    parts: List[ParticipantSummary] = []
    for (pid, pname), group in buckets.items():
        # последние 5 сообщений участника
        tail = group[-5:]
        parts.append(ParticipantSummary(
            participant_id=pid,
            participant_name=pname,
            message_count=len(group),
            sample_messages=[g.content for g in tail]
        ))
    parts.sort(key=lambda p: (-p.message_count, (p.participant_name or p.participant_id or "")))
    return parts


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
        # Participant breakdown (если включено через настройки)
        participants = None
        try:
            from ...config import get_settings  # локальный импорт чтобы избежать циклов
            if get_settings().AI_SUMMARY_PARTICIPANT_BREAKDOWN:
                participants = _build_participant_breakdown(user_msgs)
        except Exception:
            participants = None
        return SummaryResult(room_id=user_msgs[0].room_id, message_count=len(user_msgs), generated_at=int(time.time()*1000), summary_text=summary_text, sources=tail_src, participants=participants)


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
        participants = None
        try:
            from ...config import get_settings
            if get_settings().AI_SUMMARY_PARTICIPANT_BREAKDOWN:
                participants = _build_participant_breakdown(chat_part)
        except Exception:
            participants = None
        return SummaryResult(room_id=chat_part[0].room_id, message_count=len(chat_part), generated_at=int(time.time()*1000), summary_text=summary_text, sources=tail_src, used_voice=True, participants=participants)
