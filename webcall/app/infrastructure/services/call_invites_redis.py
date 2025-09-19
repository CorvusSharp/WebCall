from __future__ import annotations

import time
from typing import List
from uuid import UUID

from redis.asyncio import Redis

from ...core.ports.services import CallInviteService

INVITE_TTL_SEC = 15 * 60  # 15 минут

class RedisCallInviteService(CallInviteService):
    """Redis реализация CallInviteService.

    Хранилища:
      - Hash call_invite:{room_id} => поля: fromUserId,toUserId,fromUsername,fromEmail,ts
      - ZSET call_invite_user:{user_id} score=ts member=room_id (для быстрого поиска pending)
    """

    def __init__(self, redis: Redis):
        self.redis = redis

    def _hash_key(self, room_id: str) -> str:
        return f"call_invite:{room_id}"

    def _user_index(self, user_id: str) -> str:
        return f"call_invite_user:{user_id}"

    async def invite(self, from_user_id: UUID, to_user_id: UUID, room_id: str, from_username: str | None, from_email: str | None) -> None:  # type: ignore[override]
        ts = int(time.time())
        k = self._hash_key(room_id)
        pipe = self.redis.pipeline()
        pipe.hset(k, mapping={
            'fromUserId': str(from_user_id),
            'toUserId': str(to_user_id),
            'fromUsername': from_username or '',
            'fromEmail': from_email or '',
            'ts': ts,
        })
        pipe.expire(k, INVITE_TTL_SEC)
        pipe.zadd(self._user_index(str(from_user_id)), {room_id: ts})
        pipe.zadd(self._user_index(str(to_user_id)), {room_id: ts})
        pipe.expire(self._user_index(str(from_user_id)), INVITE_TTL_SEC)
        pipe.expire(self._user_index(str(to_user_id)), INVITE_TTL_SEC)
        await pipe.execute()
        from ...presentation.ws import friends as friends_ws  # локальный импорт
        await friends_ws.publish_call_invite(from_user_id, to_user_id, room_id, from_username, from_email)

    async def accept(self, from_user_id: UUID, to_user_id: UUID, room_id: str) -> None:  # type: ignore[override]
        await self._finalize(room_id)
        from ...presentation.ws import friends as friends_ws
        await friends_ws.publish_call_accept(from_user_id, to_user_id, room_id)

    async def decline(self, from_user_id: UUID, to_user_id: UUID, room_id: str) -> None:  # type: ignore[override]
        await self._finalize(room_id)
        from ...presentation.ws import friends as friends_ws
        await friends_ws.publish_call_decline(from_user_id, to_user_id, room_id)

    async def cancel(self, from_user_id: UUID, to_user_id: UUID, room_id: str) -> None:  # type: ignore[override]
        await self._finalize(room_id)
        from ...presentation.ws import friends as friends_ws
        await friends_ws.publish_call_cancel(from_user_id, to_user_id, room_id)

    async def _finalize(self, room_id: str) -> None:
        # Удаляем hash и чистим индексы (без знания участников — ищем из hash)
        k = self._hash_key(room_id)
        data = await self.redis.hgetall(k)
        pipe = self.redis.pipeline()
        pipe.delete(k)
        if data:
            fu = data.get('fromUserId')
            tu = data.get('toUserId')
            if fu:
                pipe.zrem(self._user_index(fu), room_id)
            if tu:
                pipe.zrem(self._user_index(tu), room_id)
        await pipe.execute()

    async def list_pending_for(self, user_id: UUID) -> List[dict]:  # type: ignore[override]
        idx_key = self._user_index(str(user_id))
        now = int(time.time())
        # Получаем все за последние INVITE_TTL_SEC секунд
        min_score = now - INVITE_TTL_SEC - 5
        room_ids = await self.redis.zrangebyscore(idx_key, min_score, now)
        results: List[dict] = []
        for rid in room_ids:
            h = await self.redis.hgetall(self._hash_key(rid))
            if not h:
                continue
            results.append({
                'roomId': rid,
                'fromUserId': h.get('fromUserId'),
                'toUserId': h.get('toUserId'),
                'fromUsername': h.get('fromUsername') or None,
                'fromEmail': h.get('fromEmail') or None,
            })
        return results
