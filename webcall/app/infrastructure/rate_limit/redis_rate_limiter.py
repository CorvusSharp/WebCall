from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Tuple

from redis.asyncio import Redis


def parse_rate(rate: str) -> Tuple[int, int]:
    """Parse rate string like '100/60' -> (100, 60)."""
    parts = rate.split('/')
    if len(parts) != 2:
        raise ValueError("Invalid RATE_LIMIT format, expected '<count>/<seconds>'")
    return int(parts[0]), int(parts[1])


@dataclass
class RedisRateLimiter:
    redis: Redis
    limit: int
    window: int  # seconds

    @classmethod
    def from_config(cls, redis: Redis, rate: str):
        limit, window = parse_rate(rate)
        return cls(redis=redis, limit=limit, window=window)

    async def allow(self, bucket: str) -> bool:
        """Fixed window counter increment. Returns True if allowed."""
        now = int(time.time())
        window_start = now - (now % self.window)
        key = f"rl:{bucket}:{window_start}"
        pipe = self.redis.pipeline()
        pipe.incr(key)
        pipe.expire(key, self.window + 2)
        count, _ = await pipe.execute()
        return int(count) <= self.limit
