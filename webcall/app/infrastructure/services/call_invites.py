from __future__ import annotations

from typing import Dict, List
import time
from uuid import UUID
from asyncio import Lock

from ...core.ports.services import CallInviteService
"""Сервис приглашений к звонку.

Избегаем циклического импорта с модулем friends_ws (presentation.ws.friends),
который через контейнеры тянет зависимости обратно сюда. Поэтому импорт
делается лениво внутри методов.
"""


class InMemoryCallInviteService(CallInviteService):
    """In-memory реализация хранения приглашений.

    Заменяет _pending_calls из friends.py, при этом friends.py может
    пользоваться этой службой через DI.
    """

    def __init__(self) -> None:
        self._pending: Dict[str, dict] = {}
        self._lock = Lock()

    async def invite(self, from_user_id: UUID, to_user_id: UUID, room_id: str, from_username: str | None, from_email: str | None) -> None:
        ts = int(time.time() * 1000)
        async with self._lock:
            self._pending[room_id] = {
                'fromUserId': str(from_user_id),
                'toUserId': str(to_user_id),
                'fromUsername': from_username,
                'fromEmail': from_email,
                'ts': ts,  # ms timestamp для восстановления после оффлайна
            }
        from ...presentation.ws import friends as friends_ws  # локальный импорт чтобы избежать цикла
        await friends_ws.publish_call_invite(from_user_id, to_user_id, room_id, from_username, from_email)

    async def accept(self, from_user_id: UUID, to_user_id: UUID, room_id: str) -> None:
        async with self._lock:
            self._pending.pop(room_id, None)
        from ...presentation.ws import friends as friends_ws
        await friends_ws.publish_call_accept(from_user_id, to_user_id, room_id)

    async def decline(self, from_user_id: UUID, to_user_id: UUID, room_id: str) -> None:
        async with self._lock:
            self._pending.pop(room_id, None)
        from ...presentation.ws import friends as friends_ws
        await friends_ws.publish_call_decline(from_user_id, to_user_id, room_id)

    async def cancel(self, from_user_id: UUID, to_user_id: UUID, room_id: str) -> None:
        async with self._lock:
            self._pending.pop(room_id, None)
        # publish_call_cancel уже очищает у себя, но для безопасности удаляем здесь тоже
        from ...presentation.ws import friends as friends_ws
        await friends_ws.publish_call_cancel(from_user_id, to_user_id, room_id)

    async def list_pending_for(self, user_id: UUID) -> List[dict]:
        now = int(time.time() * 1000)
        # Жизненный цикл инвайта: 30 секунд (синхронизировано с RING_TIMEOUT_MS на клиенте 25s + небольшой запас)
        MAX_AGE_MS = 30000
        async with self._lock:
            # Очистим устаревшие
            stale = [rid for rid, data in self._pending.items() if (now - int(data.get('ts', 0))) > MAX_AGE_MS]
            for rid in stale:
                self._pending.pop(rid, None)
            return [
                {'roomId': rid, **data, 'createdAt': data.get('ts')}
                for rid, data in self._pending.items()
                if str(user_id) in (data.get('fromUserId'), data.get('toUserId'))
            ]
