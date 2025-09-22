from __future__ import annotations

"""In-memory сборщик сообщений комнаты для последующей AI выжимки.

Не хранит данные персистентно: предназначено для генерации краткого отчёта
по завершению сессии. Если требуется долговременное хранение истории –
нужно использовать БД сообщений (PgMessageRepository) и расширить логику.

Потокобезопасность обеспечивается asyncio.Lock. Размер каждого списка
сообщений ограничен AI_SUMMARY_MAX_MESSAGES (хвост сохраняется).
"""

from dataclasses import dataclass
from typing import List, Dict
from asyncio import Lock
from uuid import UUID
import time

from ...infrastructure.config import get_settings  # type: ignore  # локальный импорт


@dataclass(slots=True)
class ChatMessage:
    room_id: str
    author_id: str | None
    author_name: str | None
    content: str
    ts: int  # epoch ms


@dataclass(slots=True)
class SummaryResult:
    room_id: str
    message_count: int
    generated_at: int
    summary_text: str


class SummaryCollector:
    def __init__(self) -> None:
        self._messages: Dict[str, List[ChatMessage]] = {}
        self._lock = Lock()

    async def add_message(self, room_id: str, author_id: str | None, author_name: str | None, content: str) -> None:
        if not content:
            return
        msg = ChatMessage(room_id=room_id, author_id=author_id, author_name=author_name, content=content.strip(), ts=int(time.time()*1000))
        settings = get_settings()
        max_msgs = settings.AI_SUMMARY_MAX_MESSAGES
        async with self._lock:
            bucket = self._messages.setdefault(room_id, [])
            bucket.append(msg)
            # обрезаем начало (старые) если превышен лимит
            if len(bucket) > max_msgs:
                overflow = len(bucket) - max_msgs
                if overflow > 0:
                    del bucket[0:overflow]

    async def summarize(self, room_id: str, ai_provider: 'AISummaryProvider | None', *, system_prompt: str | None = None) -> SummaryResult | None:  # type: ignore[name-defined]
        settings = get_settings()
        async with self._lock:
            bucket = self._messages.get(room_id, [])
            if not bucket:
                return None
            # Копируем и удаляем чтобы повторно не суммировать
            msgs = list(bucket)
            self._messages.pop(room_id, None)

        # Формируем простой список строк для AI / fallback
        plain_messages = [
            f"[{m.ts}] {(m.author_name or m.author_id or 'anon')}: {m.content}" for m in msgs
        ]
        summary_text: str
        if settings.AI_SUMMARY_ENABLED and ai_provider is not None:
            # Порог минимального содержимого (суммируем длину контента сообщений без служебной обвязки)
            total_chars = sum(len(m.content) for m in msgs)
            min_chars = getattr(settings, 'AI_SUMMARY_MIN_CHARS', 0) or 0
            if min_chars > 0 and total_chars < min_chars:
                # Слишком короткая сессия — не вызываем внешнего AI, сразу эвристический вывод
                print(f"[summary] Skipping AI: content too short {total_chars} < {min_chars} (room={room_id})")
                summary_text = (
                    f"Сессия слишком короткая ({total_chars} < {min_chars}); содержательное резюме не сформировано.\n"
                    + _fallback_summary(plain_messages)
                )
            else:
                try:
                    try:
                        summary_text = await ai_provider.generate_summary(plain_messages, system_prompt)  # type: ignore[attr-defined]
                    except TypeError:  # старый интерфейс
                        summary_text = await ai_provider.generate_summary(plain_messages)  # type: ignore[attr-defined]
                except Exception as e:  # pragma: no cover - fallback
                    summary_text = _fallback_summary(plain_messages, error=str(e))
        else:
            summary_text = _fallback_summary(plain_messages)

        # Постобработка: если ответ слишком шаблонный/поверхностный при наличии всего 1-2 сообщений — добавим исходное сообщение.
        try:
            norm = summary_text.strip().lower()
            # эвристика: AI дал структуру пунктов без конкретики, и сообщений мало
            if len(msgs) <= 2 and (
                norm.startswith('1) основные темы:') or
                'основные темы:' in norm and 'принятые решения:' in norm
            ):
                tail_src = "\n\nИсточники:\n" + "\n".join(m.content for m in msgs)
                if 'источники:' not in norm:
                    summary_text = summary_text.rstrip() + tail_src
            else:
                # Расширенная эвристика: если всего сообщений <=8 или сам summary слишком короткий (< 500 символов), но нет блока Источники — добавим последние 5.
                if ('источники:' not in norm) and (len(msgs) <= 8 or len(summary_text) < 500):
                    tail_msgs = msgs[-5:]
                    sources_block = "\n\nИсточники (последние):\n" + "\n".join(m.content for m in tail_msgs)
                    summary_text = summary_text.rstrip() + sources_block
        except Exception:
            pass

        return SummaryResult(
            room_id=room_id,
            message_count=len(msgs),
            generated_at=int(time.time()*1000),
            summary_text=summary_text,
        )

    async def message_count(self, room_id: str) -> int:
        """Возвращает текущее число накопленных сообщений (без очистки)."""
        async with self._lock:
            return len(self._messages.get(room_id, []))

    async def get_messages_snapshot(self, room_id: str) -> List[ChatMessage]:
        """Возвращает копию текущих сообщений комнаты без очистки."""
        async with self._lock:
            return list(self._messages.get(room_id, []))


def _fallback_summary(messages: List[str], error: str | None = None) -> str:
    if not messages:
        return "Нет сообщений для суммаризации." + (f" (AI error: {error})" if error else "")
    # Берём последние 10 сообщений для короткого конспекта
    tail = messages[-10:]
    body = "\n".join(tail)
    if error:
        body += f"\n[AI недоступен: {error}]"
    return "Краткая выжимка (эвристика, без AI):\n" + body


# Глобальный singleton (процессовый) — достаточно для текущего сценария.
_collector_singleton: SummaryCollector | None = None


def get_summary_collector() -> SummaryCollector:
    global _collector_singleton
    if _collector_singleton is None:
        _collector_singleton = SummaryCollector()
    return _collector_singleton


class AISummaryProvider:  # интерфейс для адаптера AI
    async def generate_summary(self, plain_messages: list[str]) -> str:  # pragma: no cover - интерфейс
        raise NotImplementedError


async def summarize_messages(messages: List[ChatMessage], ai_provider: 'AISummaryProvider | None', *, system_prompt: str | None = None) -> SummaryResult:
    """Формирует SummaryResult из предоставленного списка сообщений (без модификации коллектора).

    Использует те же правила что и SummaryCollector.summarize, но не очищает исходный state
    (предназначено для персональных snapshot-сводок).
    """
    settings = get_settings()
    plain_messages = [f"[{m.ts}] {(m.author_name or m.author_id or 'anon')}: {m.content}" for m in messages]
    if not messages:
        return SummaryResult(room_id="unknown", message_count=0, generated_at=int(time.time()*1000), summary_text="Нет сообщений для суммаризации.")
    total_chars = sum(len(m.content) for m in messages)
    min_chars = getattr(settings, 'AI_SUMMARY_MIN_CHARS', 0) or 0
    if settings.AI_SUMMARY_ENABLED and ai_provider is not None:
        if min_chars > 0 and total_chars < min_chars:
            summary_text = (
                f"Сессия слишком короткая ({total_chars} < {min_chars}); содержательное резюме не сформировано.\n"
                + _fallback_summary(plain_messages)
            )
        else:
            try:
                try:
                    summary_text = await ai_provider.generate_summary(plain_messages, system_prompt)  # type: ignore[attr-defined]
                except TypeError:
                    summary_text = await ai_provider.generate_summary(plain_messages)  # type: ignore[attr-defined]
            except Exception as e:
                summary_text = _fallback_summary(plain_messages, error=str(e))
    else:
        summary_text = _fallback_summary(plain_messages)

    # Re-use постобработку (упрощённо): добавим источники если мало сообщений или коротко
    try:
        norm = summary_text.strip().lower()
        if ('источники:' not in norm) and (len(messages) <= 8 or len(summary_text) < 500):
            tail_msgs = messages[-5:]
            sources_block = "\n\nИсточники (последние):\n" + "\n".join(m.content for m in tail_msgs)
            summary_text = summary_text.rstrip() + sources_block
    except Exception:
        pass

    return SummaryResult(room_id=messages[0].room_id, message_count=len(messages), generated_at=int(time.time()*1000), summary_text=summary_text)
