from __future__ import annotations
from collections import defaultdict, deque
from typing import Deque, List, Dict, Iterable
import time
from .models import ChatMessage, is_technical


class MessageLog:
    """Недеструктивный лог сообщений комнаты.

    Хранит хвост до limit_per_room сообщений.
    """
    def __init__(self, limit_per_room: int = 4000) -> None:
        self._storage: Dict[str, Deque[ChatMessage]] = defaultdict(deque)
        self._limit = limit_per_room

    def add(self, room_id: str, author_id: str | None, author_name: str | None, content: str, *, ts: int | None = None) -> ChatMessage:
        if not content:
            # игнор пустые
            return ChatMessage(room_id=room_id, author_id=author_id, author_name=author_name, content="", ts=int(time.time()*1000))
        msg = ChatMessage(room_id=room_id, author_id=author_id, author_name=author_name, content=content.strip(), ts=ts or int(time.time()*1000))
        bucket = self._storage[room_id]
        bucket.append(msg)
        # trim
        while len(bucket) > self._limit:
            bucket.popleft()
        return msg

    def slice_since(self, room_id: str, from_ts: int | None) -> List[ChatMessage]:
        bucket = self._storage.get(room_id)
        if not bucket:
            return []
        if from_ts is None:
            return list(bucket)
        return [m for m in bucket if m.ts >= from_ts]

    def tail(self, room_id: str, n: int) -> List[ChatMessage]:
        bucket = self._storage.get(room_id)
        if not bucket:
            return []
        if n <= 0:
            return []
        return list(bucket)[-n:]

    def all_user_visible(self, room_id: str) -> List[ChatMessage]:
        # Исключаем технические/пустые сообщения
        bucket = self._storage.get(room_id)
        if not bucket:
            return []
        return [m for m in bucket if not is_technical(m)]
