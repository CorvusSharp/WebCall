from __future__ import annotations

import asyncio
import json
from typing import Any, AsyncIterator
from uuid import UUID

import redis.asyncio as aioredis

from ...core.domain.models import Signal
from ...core.ports.services import SignalBus
from ..config import get_settings


class RedisSignalBus(SignalBus):
    def __init__(self, redis: aioredis.Redis | None = None) -> None:
        self.settings = get_settings()
        self.redis = redis or aioredis.from_url(self.settings.REDIS_URL, decode_responses=True)

    def _channel(self, room_id: UUID) -> str:
        return f"room:{room_id}:signals"

    def _presence_key(self, room_id: UUID) -> str:
        return f"room:{room_id}:presence"

    async def publish(self, room_id: UUID, signal: Signal) -> None:
        payload = json.dumps(
            {
                "type": signal.type.value,
                "sender_id": str(signal.sender_id),
                "target_id": str(signal.target_id) if signal.target_id else None,
                "room_id": str(signal.room_id),
                "sdp": signal.sdp,
                "candidate": signal.candidate,
                "sent_at": signal.sent_at.isoformat(),
            }
        )
        await self.redis.publish(self._channel(room_id), payload)

    async def subscribe(self, room_id: UUID) -> AsyncIterator[Signal]:
        pubsub = self.redis.pubsub()
        await pubsub.subscribe(self._channel(room_id))
        try:
            async for msg in pubsub.listen():
                if msg["type"] != "message":
                    continue
                data = json.loads(msg["data"])  # type: ignore[arg-type]
                yield Signal.create(
                    type=data["type"],
                    sender_id=UUID(data["sender_id"]),
                    room_id=UUID(data["room_id"]),
                    sdp=data.get("sdp"),
                    candidate=data.get("candidate"),
                    target_id=UUID(data["target_id"]) if data.get("target_id") else None,
                )
        finally:
            await pubsub.unsubscribe(self._channel(room_id))
            await pubsub.close()

    async def update_presence(self, room_id: UUID, user_id: UUID, present: bool) -> None:
        key = self._presence_key(room_id)
        if present:
            await self.redis.hset(key, str(user_id), json.dumps({"present": True}))
        else:
            await self.redis.hdel(key, str(user_id))
        await self.redis.expire(key, 60 * 60)

    async def list_presence(self, room_id: UUID) -> list[dict[str, Any]]:
        key = self._presence_key(room_id)
        data = await self.redis.hgetall(key)
        result: list[dict[str, Any]] = []
        for uid, v in data.items():
            try:
                obj = json.loads(v)
            except Exception:
                obj = {"present": True}
            obj["user_id"] = uid
            result.append(obj)
        return result
