from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import AsyncIterator, Dict, List
from uuid import UUID

from ...core.domain.models import Signal
from ...core.ports.services import SignalBus


class InMemorySignalBus(SignalBus):
    def __init__(self) -> None:
        self.queues: Dict[UUID, List[asyncio.Queue[Signal]]] = defaultdict(list)
        self._presence: Dict[UUID, set[str]] = defaultdict(set)

    async def publish(self, room_id: UUID, signal: Signal) -> None:  # type: ignore[override]
        for q in list(self.queues[room_id]):
            await q.put(signal)

    async def subscribe(self, room_id: UUID) -> AsyncIterator[Signal]:  # type: ignore[override]
        q: asyncio.Queue[Signal] = asyncio.Queue()
        self.queues[room_id].append(q)
        try:
            while True:
                try:
                    s = await q.get()
                except asyncio.CancelledError:
                    # нормальный выход при отмене таска-подписчика
                    break
                else:
                    yield s
        finally:
            self.queues[room_id].remove(q)

    async def update_presence(self, room_id: UUID, user_id: UUID, present: bool) -> None:  # type: ignore[override]
        if present:
            self._presence[room_id].add(str(user_id))
        else:
            self._presence[room_id].discard(str(user_id))

    async def list_presence(self, room_id: UUID) -> List[dict]:  # type: ignore[override]
        return [{"user_id": uid, "present": True} for uid in self._presence[room_id]]
